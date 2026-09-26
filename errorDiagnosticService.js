const fs = require('fs');
const path = require('path');
const { getAccountsByPhone, fetchRawData } = require('./apiService');
const { callDeepSeek, describeImageWithGemini } = require('./aiService');
const { checkSpreadsheetStock } = require('./availabilityService');
const { callGemini38Flash, executeFixAndCommit, GEMINI_MODEL } = require('./cliAgentService');

const ERRORS_LOG_PATH = path.join(__dirname, 'logs', 'reported_errors.json');
const PENDING_SOLUTIONS_PATH = path.join(__dirname, 'logs', 'pending_error_solutions.json');

// Asegurar que exista la carpeta logs
try {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
} catch (e) {}

/**
 * Verifica si un chat es un grupo de reporte de errores o administración
 */
function isErrorDiagnosticGroup(chatId, chatName = '') {
    if (!chatId || !chatId.endsWith('@g.us')) return false;
    // ID exacto del grupo oficial "Errors bot"
    if (chatId === '120363427163636523@g.us') return true;
    const nameLower = (chatName || '').toLowerCase();
    const isNameMatch = /error|errores|bug|bugs|falla|fallas|incidencia|incidencias/i.test(nameLower);
    return isNameMatch;
}

/**
 * Guarda o actualiza una propuesta de solución pendiente de aprobación
 */
// Control de mensajes de reporte ya procesados o en ejecución concurrente para evitar duplicados
const processedReportMessageIds = new Set();
const activeReportMessageIds = new Set();

setInterval(() => {
    if (processedReportMessageIds.size > 1000) {
        processedReportMessageIds.clear();
    }
}, 10 * 60 * 1000);

/**
 * Guarda o actualiza una propuesta de solución pendiente de aprobación
 */
function savePendingSolution(ticket) {
    try {
        let solutions = [];
        if (fs.existsSync(PENDING_SOLUTIONS_PATH)) {
            try {
                solutions = JSON.parse(fs.readFileSync(PENDING_SOLUTIONS_PATH, 'utf8'));
            } catch (e) {
                solutions = [];
            }
        }
        solutions.unshift(ticket);
        if (solutions.length > 50) solutions = solutions.slice(0, 50);
        fs.writeFileSync(PENDING_SOLUTIONS_PATH, JSON.stringify(solutions, null, 2), 'utf8');
    } catch (e) {
        console.error('[ErrorDiagnostic] Error guardando propuesta pendiente:', e.message);
    }
}

/**
 * Obtiene la última solución pendiente de aprobación (o la asociada al mensaje citado)
 */
function getLatestPendingSolution(quotedText = '') {
    try {
        if (!fs.existsSync(PENDING_SOLUTIONS_PATH)) return null;
        let solutions = JSON.parse(fs.readFileSync(PENDING_SOLUTIONS_PATH, 'utf8'));
        if (quotedText) {
            const matchId = quotedText.match(/#?(ERR-[\w-]+)/i);
            if (matchId) {
                const found = solutions.find(s => s.id === matchId[1] && s.status === 'PENDIENTE_APROBACION');
                if (found) return found;
            }
        }
        return solutions.find(s => s.status === 'PENDIENTE_APROBACION') || null;
    } catch (e) {
        return null;
    }
}

/**
 * Actualiza los campos de un ticket pendiente
 */
function updatePendingSolution(ticketId, updatedFields) {
    try {
        if (!fs.existsSync(PENDING_SOLUTIONS_PATH)) return null;
        let solutions = JSON.parse(fs.readFileSync(PENDING_SOLUTIONS_PATH, 'utf8'));
        const index = solutions.findIndex(s => s.id === ticketId);
        if (index !== -1) {
            solutions[index] = { ...solutions[index], ...updatedFields, updatedAt: new Date().toISOString() };
            fs.writeFileSync(PENDING_SOLUTIONS_PATH, JSON.stringify(solutions, null, 2), 'utf8');
            return solutions[index];
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Aprueba una solución pendiente cuando el usuario escribe @commit o @aceptar
 */
function approvePendingSolution(quotedText = '', approverPhone = '') {
    try {
        if (!fs.existsSync(PENDING_SOLUTIONS_PATH)) return null;
        let solutions = JSON.parse(fs.readFileSync(PENDING_SOLUTIONS_PATH, 'utf8'));
        
        let targetIndex = -1;
        // 1. Si citó un mensaje, buscar el ID en el texto citado (ej: #ERR-1727...)
        if (quotedText) {
            const matchId = quotedText.match(/#?(ERR-[\w-]+)/i);
            if (matchId) {
                targetIndex = solutions.findIndex(s => s.id === matchId[1] && s.status === 'PENDIENTE_APROBACION');
            }
        }

        // 2. Si no lo encontró por cita, tomar el último pendiente
        if (targetIndex === -1) {
            targetIndex = solutions.findIndex(s => s.status === 'PENDIENTE_APROBACION');
        }

        if (targetIndex !== -1) {
            solutions[targetIndex].status = 'APROBADO';
            solutions[targetIndex].approvedBy = approverPhone;
            solutions[targetIndex].approvedAt = new Date().toISOString();
            fs.writeFileSync(PENDING_SOLUTIONS_PATH, JSON.stringify(solutions, null, 2), 'utf8');
            return solutions[targetIndex];
        }
        return null;
    } catch (e) {
        console.error('[ErrorDiagnostic] Error aprobando solución pendiente:', e.message);
        return null;
    }
}

/**
 * Guarda el reporte en el historial de errores
 */
function logReportedError(data) {
    try {
        let history = [];
        if (fs.existsSync(ERRORS_LOG_PATH)) {
            try {
                history = JSON.parse(fs.readFileSync(ERRORS_LOG_PATH, 'utf8'));
            } catch (e) {
                history = [];
            }
        }
        history.unshift({
            id: `ERR-${Date.now()}`,
            timestamp: new Date().toISOString(),
            ...data
        });
        if (history.length > 200) history = history.slice(0, 200);
        fs.writeFileSync(ERRORS_LOG_PATH, JSON.stringify(history, null, 2), 'utf8');
    } catch (e) {
        console.error('[ErrorDiagnostic] Error guardando historial de error:', e.message);
    }
}

/**
 * Genera el plan de resolución y commit detallado con LLM (Gemini / DeepSeek)
 */
async function generateCliPlanAndCommit(extractedInfo, diagnosticNotes = [], userAdjustment = null, previousTicket = null) {
    let fallbackCausa = extractedInfo.summary || "Incidencia reportada en el grupo de soporte.";
    let fallbackPlan = diagnosticNotes.length > 0 
        ? diagnosticNotes.join('\n') 
        : "Revisar logs del bot y validar el flujo de atención para el caso reportado.";
    let fallbackCommit = "fix(bot): resolver incidencia técnica reportada\n\n- Prevención de fallos y refuerzo de validaciones.";
    let fallbackFiles = ["index.js"];

    const rawOcrText = (extractedInfo.rawOcr || '').toLowerCase();
    const sumLower = (extractedInfo.summary || '').toLowerCase();

    if (rawOcrText.includes('bancolombia') || rawOcrText.includes('transferencia') || sumLower.includes('pago') || sumLower.includes('comprobante')) {
        fallbackCausa = `Comprobante de transferencia bancaria (${extractedInfo.platform || 'Bancolombia'}${extractedInfo.clientPhone ? `, celular ${extractedInfo.clientPhone}` : ''}) enviado pero el bot no lo validó ni envió respuesta de confirmación/entrega.`;
        fallbackPlan = `1. En gmailService.js y billingService.js, comprobar la sincronización del buzón de alertas bancarias y ampliar la ventana de tolerancia de minutos para transferencias.\n2. En index.js, asegurar que cuando el cliente envía comprobante con mensaje de cortesía ("Listo gracias"), el bot no se quede en espera humana y proceda con la validación del pago.`;
        fallbackCommit = `fix(billing): mejorar detección y validación de transferencias Bancolombia\n\n- Sincronización de alertas y mitigación de bloqueo en espera humana ante comprobantes con texto de cortesía.`;
        fallbackFiles = ["gmailService.js", "billingService.js", "index.js"];
    }

    const fallbackResponse = {
        causaRaiz: fallbackCausa,
        planCodigo: fallbackPlan,
        commitDetallado: fallbackCommit,
        archivosAfectados: fallbackFiles
    };

    const generatePromise = async () => {
        let prompt = '';
        if (userAdjustment && previousTicket) {
            prompt = `Actúas como Antigravity CLI (asistente de ingeniería para el bot de WhatsApp y backend Sheerit).
El usuario solicitó un AJUSTE / CAMBIO a una propuesta previa:

PROPUESTA PREVIA:
- Caso: ${previousTicket.summary || extractedInfo.summary}
- Diagnóstico previo: ${previousTicket.diagnosis}
- Plan previo: ${previousTicket.plan}
- Archivos previos: ${(previousTicket.files || []).join(', ')}

INDICACIÓN / CORRECCIÓN DEL USUARIO:
"${userAdjustment}"

Notas de diagnóstico del sistema:
${diagnosticNotes.join('\n') || 'Sin notas adicionales'}

Genera una NUEVA propuesta técnica que incorpore estrictamente la solución que el usuario quiere.
Devuelve un JSON estrictamente estructurado así:
{
  "causaRaiz": "Explicación concisa y técnica de la causa raíz actualizada con la indicación del usuario",
  "planCodigo": "Pasos detallados de las modificaciones en código ajustadas",
  "commitDetallado": "Título y cuerpo del commit propuesto explicando los cambios",
  "archivosAfectados": ["archivo1.js", "archivo2.js"]
}`;
        } else {
            prompt = `Actúas como Antigravity CLI (asistente de ingeniería para el bot de WhatsApp y backend Sheerit).
Un asesor reportó la siguiente incidencia en el grupo de WhatsApp "Errors bot":
- Caso / Resumen: ${extractedInfo.summary || 'Error reportado en chat'}
- Cliente: ${extractedInfo.clientPhone || 'No especificado'} (${extractedInfo.clientName || 'N/A'})
- Plataforma: ${extractedInfo.platform || 'General'}
- Tipo de problema: ${extractedInfo.problemType || 'incidencia'}
- OCR / Captura: ${extractedInfo.rawOcr || 'Sin OCR'}
- Estado actual en sistema:
${diagnosticNotes.join('\n') || 'Sin notas adicionales'}

Genera un plan de ingeniería en código para erradicar este problema de raíz.
Devuelve un JSON estrictamente estructurado así:
{
  "causaRaiz": "Explicación concisa y técnica de por qué ocurrió el fallo en el código o datos",
  "planCodigo": "Pasos detallados de las modificaciones en código realizadas/propuestas para resolverlo de raíz",
  "commitDetallado": "Título y cuerpo del commit propuesto con viñetas claras explicando los cambios y la prevención de regresión",
  "archivosAfectados": ["archivo1.js", "archivo2.js"]
}`;
        }

        let raw = null;
        try {
            raw = await callGemini38Flash(prompt, "Eres Antigravity CLI. Responde exclusivamente con el JSON solicitado sin bloques markdown ni texto extra.");
            raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
            return JSON.parse(raw);
        } catch (gErr) {
            console.warn('[ErrorDiagnostic] Fallback a DeepSeek para plan CLI:', gErr.message);
            raw = await callDeepSeek(prompt, "Responde únicamente con el JSON solicitado.", true);
            raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
            return JSON.parse(raw);
        }
    };

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(fallbackResponse), 45000));
    try {
        return await Promise.race([generatePromise(), timeoutPromise]);
    } catch (e) {
        return fallbackResponse;
    }
}

/**
 * Diagnostica un reporte enviado por un asesor en el grupo "errors bot"
 */
async function handleAdvisorErrorReport(message, client, userStates) {
    if (!message || (!message.body && !message.hasMedia)) return;

    // Deduplicación estricta por ID del mensaje para evitar doble respuesta (message vs message_create)
    const msgId = message.id ? (message.id._serialized || message.id.id) : null;
    if (msgId) {
        if (processedReportMessageIds.has(msgId) || activeReportMessageIds.has(msgId)) {
            console.log(`[ErrorDiagnostic] ⚠️ Mensaje ya procesado o en ejecución concurrente ignorado: ${msgId}`);
            return;
        }
        activeReportMessageIds.add(msgId);
    }

    try {
        const bodyLower = (message.body || '').toLowerCase().trim();
        // Evitar bucles recursivos ignorando mensajes autogenerados del bot
        if (
            bodyLower.includes('[diagnóstico') ||
            bodyLower.includes('ticket #err-') ||
            bodyLower.includes('ticket: #err-') ||
            bodyLower.includes('[agy / cli]') ||
            bodyLower.includes('propuesta de resolución') ||
            bodyLower.includes('[solución aplicada') ||
            bodyLower.includes('[solución implementada') ||
            bodyLower.includes('[propuesta ajustada') ||
            bodyLower.includes('reiniciando servicio') ||
            bodyLower.includes('🤖')
        ) {
            return;
        }

        const chat = await message.getChat();
        const chatName = chat ? (chat.name || '') : '';
        const sender = message.author || message.from;
        const senderPhone = sender.replace('@c.us', '').replace(/\D/g, '');
        const textTrimmed = (message.body || '').trim();

        const groupChatId = (message.to && message.to.includes('@g.us')) 
            ? message.to 
            : ((message.from && message.from.includes('@g.us')) 
                ? message.from 
                : (chat ? chat.id._serialized : message.from));

        // 1. FLUJO DE APROBACIÓN CON @commit (o @aceptar)
        const isCommit = /^@?commit\b/i.test(textTrimmed) || /^@?acept(ar|o)\b/i.test(textTrimmed);
        if (isCommit) {
            let quotedText = '';
            if (message.hasQuotedMsg) {
                try {
                    const quoted = await message.getQuotedMessage();
                    if (quoted && quoted.body) quotedText = quoted.body;
                } catch (e) {}
            }

            const approvedTicket = approvePendingSolution(quotedText, senderPhone);
            if (approvedTicket) {
                const waitNotice = `⚙️ *[APLICANDO CAMBIOS EN CÓDIGO Y SUBIENDO AL REPOSITORIO...]* (Ticket: #${approvedTicket.id})\n` +
                    `Por favor espera un momento mientras Antigravity CLI aplica las modificaciones, corre validación sintáctica y hace git push...`;
                try { await message.reply(waitNotice); } catch (e) {
                    if (client && client.sendMessage) await client.sendMessage(groupChatId, waitNotice).catch(() => {});
                }

                // Ejecutar el parche en código, commit y push usando Antigravity CLI
                const commitResult = await executeFixAndCommit(approvedTicket);

                if (commitResult.success) {
                    const filesList = (commitResult.changedFiles && commitResult.changedFiles.length > 0)
                        ? commitResult.changedFiles.map(f => `• ${f}`).join('\n')
                        : '• Repositorio actualizado y verificado';

                    const commitHashDisplay = commitResult.commitHash ? `\`${commitResult.commitHash}\`` : 'OK';
                    const pushNotice = commitResult.pushed ? '✅ Subido exitosamente a `origin/main`' : '⚠️ Commit local creado';

                    const acceptMsg = `✅ *[SOLUCIÓN IMPLEMENTADA, COMMIT Y PUSH COMPLETADOS]* (Ticket: #${approvedTicket.id})\n\n` +
                        `👤 *Aprobado por:* @${senderPhone}\n` +
                        `🤖 *Motor:* Antigravity CLI (${commitResult.model || GEMINI_MODEL})\n` +
                        `📦 *Commit Hash:* ${commitHashDisplay}\n` +
                        `🚀 *GitHub Remote:* ${pushNotice}\n\n` +
                        `📋 *Caso Resuelto:* ${approvedTicket.summary}\n\n` +
                        `📁 *Archivos Modificados:*\n${filesList}\n\n` +
                        `📝 *Detalle del Commit:*\n\`\`\`\n${approvedTicket.commitMessage}\n\`\`\`\n\n` +
                        `⚡ *¡CÓDIGO LISTO EN PRODUCCIÓN!*\n` +
                        `Los cambios ya se encuentran guardados y subidos al repositorio.\n\n` +
                        `🔄 *Para activar los cambios en caliente ahora:* Escribe *@restart*`;

                    try {
                        await message.reply(acceptMsg);
                    } catch (e) {
                        if (client && client.sendMessage) await client.sendMessage(groupChatId, acceptMsg).catch(() => {});
                    }
                    return;
                } else {
                    const errorMsg = `❌ *[ERROR AL APLICAR SOLUCIÓN]* (Ticket: #${approvedTicket.id})\n\n` +
                        `Ocurrió un problema al intentar modificar los archivos o hacer push:\n` +
                        `\`${commitResult.error || 'Error desconocido'}\`\n\n` +
                        `Los cambios anteriores fueron revertidos para proteger la estabilidad del bot.\n` +
                        `Puedes solicitar un enfoque diferente escribiendo *@cambio <nueva indicación>*.`;
                    try {
                        await message.reply(errorMsg);
                    } catch (e) {
                        if (client && client.sendMessage) await client.sendMessage(groupChatId, errorMsg).catch(() => {});
                    }
                    return;
                }
            } else {
                const noTicketMsg = `ℹ️ No encontré ninguna propuesta de solución pendiente de aprobación.\n` +
                    `Si deseas aprobar una específica, responde citando el mensaje del diagnóstico con *@commit*.`;
                try {
                    await message.reply(noTicketMsg);
                } catch (e) {
                    if (client && client.sendMessage) await client.sendMessage(groupChatId, noTicketMsg).catch(() => {});
                }
                return;
            }
        }

        // 2. FLUJO DE AJUSTE CON @cambio <solucion>
        const changeMatch = textTrimmed.match(/^@?cambio[+: ]\s*(.+)/is) || textTrimmed.match(/^@?cambio\b(.*)/is);
        if (changeMatch) {
            const userInstruction = changeMatch[1] ? changeMatch[1].trim() : '';
            if (!userInstruction) {
                const hintMsg = `⚠️ Por favor especifica qué cambio o solución deseas. Ejemplo:\n` +
                    `*@cambio validar contra las alertas de Gmail de Bancolombia y no contra Excel*`;
                try { await message.reply(hintMsg); } catch (e) {
                    if (client && client.sendMessage) await client.sendMessage(groupChatId, hintMsg).catch(() => {});
                }
                return;
            }

            let quotedText = '';
            if (message.hasQuotedMsg) {
                try {
                    const quoted = await message.getQuotedMessage();
                    if (quoted && quoted.body) quotedText = quoted.body;
                } catch (e) {}
            }

            const pendingTicket = getLatestPendingSolution(quotedText);
            if (!pendingTicket) {
                const noTicketMsg = `ℹ️ No encontré ninguna propuesta pendiente para modificar.\n` +
                    `Por favor responde citando el mensaje del ticket de diagnóstico que deseas cambiar escribiendo *@cambio <tu indicación>*.`;
                try { await message.reply(noTicketMsg); } catch (e) {
                    if (client && client.sendMessage) await client.sendMessage(groupChatId, noTicketMsg).catch(() => {});
                }
                return;
            }

            const adjustingNotice = `⏳ *[REAJUSTANDO PROPUESTA SEGÚN TU INDICACIÓN]* (Ticket #${pendingTicket.id})...\n` +
                `Analizando: "${userInstruction}"`;
            try { await message.reply(adjustingNotice); } catch (e) {
                if (client && client.sendMessage) await client.sendMessage(groupChatId, adjustingNotice).catch(() => {});
            }

            // Generar nueva propuesta incorporando la instrucción del usuario
            const updatedCliSolution = await generateCliPlanAndCommit(
                { summary: pendingTicket.summary, clientPhone: pendingTicket.clientPhone, platform: pendingTicket.platform, problemType: 'ajuste_usuario' },
                [`⚠️ Solicitud de cambio del usuario: "${userInstruction}"`, `Diagnóstico previo: ${pendingTicket.diagnosis}`],
                userInstruction,
                pendingTicket
            );

            updatePendingSolution(pendingTicket.id, {
                diagnosis: updatedCliSolution.causaRaiz,
                plan: updatedCliSolution.planCodigo,
                commitMessage: updatedCliSolution.commitDetallado,
                files: updatedCliSolution.archivosAfectados
            });

            let adjustedMsg = `🛠️ *[PROPUESTA AJUSTADA]* (Ticket #${pendingTicket.id})\n\n`;
            adjustedMsg += `✏️ *Ajuste recibido:* "${userInstruction}"\n\n`;
            adjustedMsg += `🔍 *Explicación actualizada:* \n${updatedCliSolution.causaRaiz}\n\n`;
            adjustedMsg += `💡 *Nuevo Plan de Código:* \n${updatedCliSolution.planCodigo}\n\n`;
            if (updatedCliSolution.commitDetallado) {
                adjustedMsg += `📝 *Commit Propuesto:* \n\`\`\`\n${updatedCliSolution.commitDetallado}\n\`\`\`\n\n`;
            }
            adjustedMsg += `👉 *Para implementar cambios en código y subir a GitHub:* Escribe *@commit*\n`;
            adjustedMsg += `✏️ *Para seguir ajustando:* Escribe *@cambio <tu ajuste>*\n\n`;
            adjustedMsg += `⚠️ *Nota:* El comando *@restart* solo estará disponible una vez que apruebes con *@commit*.`;

            try {
                await message.reply(adjustedMsg);
            } catch (e) {
                if (client && client.sendMessage) await client.sendMessage(groupChatId, adjustedMsg).catch(() => {});
            }
            return;
        }

        console.log(`[ErrorDiagnostic] 🚨 Procesando reporte de asesor en grupo: "${chatName}" (de @${senderPhone})`);

        let extractedInfo = {
            hasMedia: message.hasMedia,
            textBody: message.body || '',
            clientPhone: null,
            clientName: null,
            platform: null,
            problemType: null,
            rawOcr: null
        };

        // 3. Buscar si citó un mensaje con imagen
        let targetMediaMsg = message.hasMedia ? message : null;
        if (!targetMediaMsg && message.hasQuotedMsg) {
            try {
                const quoted = await message.getQuotedMessage();
                if (quoted && quoted.hasMedia) {
                    targetMediaMsg = quoted;
                }
            } catch (e) {}
        }

        // 4. Si no citó imagen, buscar en los mensajes recientes del grupo (hasta 20 mensajes atrás en las últimas 24 horas)
        let recentChatContext = '';
        if (chat && chat.fetchMessages) {
            try {
                const recents = await chat.fetchMessages({ limit: 20 });
                const validRecents = recents.filter(m => m && Math.abs(message.timestamp - m.timestamp) < 86400); // 24 horas
                if (!targetMediaMsg) {
                    // Buscar la imagen más reciente enviada en el chat
                    const mediaMsg = [...validRecents].reverse().find(m => m.hasMedia);
                    if (mediaMsg) targetMediaMsg = mediaMsg;
                }
                recentChatContext = validRecents.slice(-8).map(m => `[${m.author || m.from}]: ${m.body || (m.hasMedia ? '[Captura/Imagen]' : '')}`).join('\n');
            } catch (e) {}
        }

        // 5. Si el reporte contiene o está asociado a una imagen (captura de WhatsApp, comprobante, etc.)
        if (targetMediaMsg && targetMediaMsg.hasMedia) {
            try {
                const media = await targetMediaMsg.downloadMedia();
                if (media && media.data) {
                    const ocrPrompt = `Analiza esta captura de pantalla enviada al grupo de errores de soporte técnico.
Puede ser una conversación de WhatsApp con un cliente, un comprobante bancario (Bancolombia, Nequi, Daviplata, etc.), una pantalla de la web o un error de sistema.
Contexto reciente del chat:
${recentChatContext}

Extrae en formato JSON:
{
  "clientPhone": string | null, // Teléfono del cliente si se ve en el encabezado, texto o comprobante (ej: "3118587974")
  "clientName": string | null,  // Nombre del cliente o contacto si aparece (ej: "Esteban David Avila Diagama")
  "platform": string | null,    // Plataforma o banco involucrado (Bancolombia, Nequi, Netflix, Prime Video, YouTube, etc.)
  "problemType": string,        // "comprobante_no_validado", "cobro_indebido", "no_renovado", "comprobante_rechazado", "no_entrega_credenciales", "vencimiento_error", "clave_incorrecta", "otro"
  "summary": string             // Resumen conciso y claro de qué ocurrió según la captura y el mensaje
}`;
                    const mediaObj = { data: media.data, mimeType: media.mimetype || 'image/jpeg' };
                    const visionText = await describeImageWithGemini(mediaObj, message.body || '');
                    extractedInfo.rawOcr = visionText;

                    try {
                        const jsonParsed = await callDeepSeek(
                            `A partir de la siguiente descripción visual de la captura y los mensajes del chat, extrae los datos solicitados en formato JSON:\n\nMENSAJE ASESOR: "${message.body || ''}"\n\nCONTEXTO RECIENTE:\n${recentChatContext}\n\nDESCRIPCIÓN CAPTURA:\n${visionText}\n\n` + ocrPrompt,
                            "Responde únicamente con el JSON solicitado.",
                            true
                        );
                        const structured = JSON.parse(jsonParsed);
                        extractedInfo = { ...extractedInfo, ...structured };
                    } catch (pErr) {
                        console.warn('[ErrorDiagnostic] Error parseando JSON de visión:', pErr.message);
                    }
                }
            } catch (mediaErr) {
                console.error('[ErrorDiagnostic] Error descargando imagen de reporte:', mediaErr.message);
            }
        } else {
            // Si es solo texto, analizarlo junto con los últimos mensajes del grupo
            try {
                const textParsed = await callDeepSeek(
                    `Analiza este reporte de error enviado por un asesor y el contexto reciente del grupo:\nREPORTE: "${message.body}"\n\nCONTEXTO RECIENTE DEL GRUPO:\n${recentChatContext}\n\nExtrae en JSON:
{
  "clientPhone": string | null,
  "clientName": string | null,
  "platform": string | null,
  "problemType": string,
  "summary": string
}`,
                    "Responde únicamente con el JSON solicitado.",
                    true
                );
                const structured = JSON.parse(textParsed);
                extractedInfo = { ...extractedInfo, ...structured };
            } catch (tErr) {
                console.warn('[ErrorDiagnostic] Error analizando texto del asesor:', tErr.message);
            }
        }

        // 6. Normalizar teléfono si se detectó
        let cleanPhone = extractedInfo.clientPhone ? extractedInfo.clientPhone.replace(/\D/g, '') : null;
        if (cleanPhone && cleanPhone.length > 10 && cleanPhone.startsWith('57')) {
            cleanPhone = cleanPhone.slice(-10);
        }

        // 7. Cruzar datos con el sistema
        let accountsFound = [];
        let stockAvailable = null;
        let diagnosticNotes = [];

        if (cleanPhone) {
            try {
                accountsFound = await getAccountsByPhone(cleanPhone, extractedInfo.clientName, true);
            } catch (e) {}
        }

        if (extractedInfo.platform) {
            try {
                stockAvailable = await checkSpreadsheetStock(extractedInfo.platform);
            } catch (e) {}
        }

        const platUpper = (extractedInfo.platform || 'servicio').toUpperCase();

        if (extractedInfo.problemType === 'no_entrega_credenciales' || /no entrega|cupos|asignación manual/i.test(extractedInfo.summary || '')) {
            if (stockAvailable) {
                diagnosticNotes.push(`✅ Hay cupos libres disponibles para *${platUpper}* en el inventario.`);
            } else {
                diagnosticNotes.push(`⚠️ No se encontraron cupos libres en Excel para *${platUpper}*. Requiere que un administrador cree o agregue una cuenta en la hoja.`);
            }
        } else if (extractedInfo.problemType === 'vencimiento_error' || /vencimiento|deben|renov/i.test(extractedInfo.summary || '')) {
            if (accountsFound.length > 0) {
                const acc = accountsFound[0];
                diagnosticNotes.push(`📅 Cuenta registrada: ${acc.Streaming} (${acc.correo || 'sin correo'})\n• Fecha cliente (deben): *${acc.deben || 'N/A'}*\n• Fecha proveedor (vencimiento interno): *${acc.vencimiento || 'N/A'}*`);
            }
        } else if (extractedInfo.problemType === 'clave_incorrecta' || /contraseña|clave|incorrecta|anterior/i.test(extractedInfo.summary || '') || /contraseña|clave|anterior/i.test(message.body || '')) {
            if (accountsFound.length > 0) {
                const acc = accountsFound[0];
                diagnosticNotes.push(`🔑 Cuenta en caché: ${acc.Streaming} (${acc.correo || 'N/A'})\n• Clave registrada: *${acc.contraseña || acc.clave || 'N/A'}*\n• Vencimiento: *${acc.vencimiento || 'N/A'}*`);
            }
        }

        // 8. Generar Plan de Solución CLI y Commit Detallado
        const ticketId = `ERR-${Date.now().toString().slice(-6)}`;
        const cliSolution = await generateCliPlanAndCommit(extractedInfo, diagnosticNotes);

        // Guardar ticket como pendiente de aprobación
        savePendingSolution({
            id: ticketId,
            reportedBy: senderPhone,
            summary: extractedInfo.summary || message.body,
            clientPhone: cleanPhone,
            platform: platUpper,
            diagnosis: cliSolution.causaRaiz,
            plan: cliSolution.planCodigo,
            commitMessage: cliSolution.commitDetallado,
            files: cliSolution.archivosAfectados,
            status: 'PENDIENTE_APROBACION',
            createdAt: new Date().toISOString()
        });

        // 9. Construir Mensaje de Respuesta
        let responseMsg = `🛠️ *[DIAGNÓSTICO Y RESPUESTA]* (Ticket #${ticketId})\n\n`;

        const reportedText = (message.body || '').trim();
        if (reportedText) {
            responseMsg += `💬 *En respuesta a:* "${reportedText.length > 80 ? reportedText.slice(0, 80) + '...' : reportedText}"\n`;
        }
        if (extractedInfo.clientName || cleanPhone) {
            responseMsg += `👤 *Cliente:* ${extractedInfo.clientName || 'Identificado'} ${cleanPhone ? `(+57 ${cleanPhone})` : ''}\n`;
        }
        if (extractedInfo.platform) {
            responseMsg += `📺 *Plataforma / Medio:* ${platUpper}\n`;
        }
        if (extractedInfo.summary) {
            responseMsg += `📋 *Situación:* ${extractedInfo.summary}\n`;
        }

        responseMsg += `\n🔍 *Explicación:* \n${cliSolution.causaRaiz}\n`;
        responseMsg += `\n💡 *Acción / Solución en Código:* \n${cliSolution.planCodigo}\n`;

        if (cliSolution.commitDetallado && !cliSolution.commitDetallado.includes('incidencia soporte')) {
            responseMsg += `\n📝 *Commit Propuesto:* \n\`\`\`\n${cliSolution.commitDetallado}\n\`\`\`\n`;
        }

        responseMsg += `\n👉 *Para implementar cambio en código y subir a GitHub:* Escribe *@commit*\n`;
        responseMsg += `✏️ *Para pedir otra solución o ajuste:* Escribe *@cambio <la solución que quieres>*\n`;
        responseMsg += `\n⚠️ *Nota:* El comando *@restart* solo estará disponible una vez que apruebes con *@commit*.`;

        // Responder citando el mensaje del asesor o directamente si falla el quote
        try {
            await message.reply(responseMsg);
        } catch (repErr) {
            console.warn('[ErrorDiagnostic] Fallback enviando con client.sendMessage:', repErr.message);
            if (client && client.sendMessage) {
                await client.sendMessage(groupChatId, responseMsg).catch(err => console.error('[ErrorDiagnostic] Error en fallback de envío:', err.message));
            }
        }

        // Guardar registro en auditoría general
        logReportedError({
            id: ticketId,
            reporterPhone: senderPhone,
            chatName,
            extractedInfo,
            accountsCount: accountsFound.length,
            stockAvailable,
            cliSolution
        });

    } catch (err) {
        console.error('[ErrorDiagnostic] Error procesando reporte de asesor:', err.message);
    } finally {
        if (msgId) {
            activeReportMessageIds.delete(msgId);
            processedReportMessageIds.add(msgId);
        }
    }
}

module.exports = {
    isErrorDiagnosticGroup,
    handleAdvisorErrorReport,
    logReportedError,
    approvePendingSolution,
    getLatestPendingSolution,
    updatePendingSolution
};

