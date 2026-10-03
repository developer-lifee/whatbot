const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getAccountsByPhone, fetchRawData } = require('./apiService');
const { checkSpreadsheetStock } = require('./availabilityService');
const { callGemini38Flash, callAgyCli, extractJsonFromAgyOutput, executeFixAndCommit, GEMINI_MODEL } = require('./cliAgentService');

const ERRORS_LOG_PATH = path.join(__dirname, 'logs', 'reported_errors.json');
const PENDING_SOLUTIONS_PATH = path.join(__dirname, 'logs', 'pending_error_solutions.json');
const RESOLVED_CASES_PATH = path.join(__dirname, 'logs', 'resolved_cases_history.json');

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
function getLatestPendingSolution(targetText = '') {
    try {
        if (!fs.existsSync(PENDING_SOLUTIONS_PATH)) return null;
        let solutions = JSON.parse(fs.readFileSync(PENDING_SOLUTIONS_PATH, 'utf8'));
        if (targetText) {
            const matchId = targetText.match(/#?(ERR-[\w-]+)/i);
            if (matchId) {
                const found = solutions.find(s => s.id === matchId[1]);
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
                targetIndex = solutions.findIndex(s => s.id === matchId[1]);
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
 * Registra un caso resuelto exitosamente con su commit y fecha exacta
 */
function saveResolvedCase(ticket, commitResult) {
    try {
        let history = [];
        if (fs.existsSync(RESOLVED_CASES_PATH)) {
            try {
                history = JSON.parse(fs.readFileSync(RESOLVED_CASES_PATH, 'utf8'));
            } catch (e) {
                history = [];
            }
        }
        const now = new Date();
        const nowHuman = now.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
        history.unshift({
            id: ticket.id,
            resolvedAt: now.toISOString(),
            resolvedAtHuman: nowHuman,
            commitHash: commitResult.commitHash || 'OK',
            clientPhone: ticket.clientPhone || null,
            clientName: ticket.clientName || null,
            platform: ticket.platform || null,
            summary: ticket.summary || null,
            rawMessage: ticket.rawMessage || ticket.rawOcr || null,
            diagnosis: ticket.diagnosis || null,
            plan: ticket.plan || null,
            commitMessage: ticket.commitMessage || null,
            files: commitResult.changedFiles || []
        });
        if (history.length > 500) history = history.slice(0, 500);
        fs.writeFileSync(RESOLVED_CASES_PATH, JSON.stringify(history, null, 2), 'utf8');
    } catch (e) {
        console.error('[ErrorDiagnostic] Error guardando caso resuelto:', e.message);
    }
}

/**
 * Busca si un reporte ya fue resuelto previamente en un commit (vía JSON de historial o Git Log)
 */
function findExistingResolvedCase(extractedInfo, effectiveText = '') {
    try {
        const currentPhone = extractedInfo.clientPhone ? extractedInfo.clientPhone.replace(/\D/g, '') : null;
        const currentName = (extractedInfo.clientName || '').toLowerCase().trim();
        const currentPlat = (extractedInfo.platform || '').toLowerCase().trim();
        const combinedCurrent = `${extractedInfo.summary || ''} ${effectiveText || ''} ${extractedInfo.rawOcr || ''}`.toLowerCase();

        // 1. Primero buscar en el historial JSON
        if (fs.existsSync(RESOLVED_CASES_PATH)) {
            let history = [];
            try {
                history = JSON.parse(fs.readFileSync(RESOLVED_CASES_PATH, 'utf8'));
            } catch (e) {
                history = [];
            }

            if (Array.isArray(history) && history.length > 0) {
                // 1.1 Coincidencia por teléfono
                if (currentPhone) {
                    const match = history.find(c => {
                        if (!c.clientPhone) return false;
                        const cPhone = c.clientPhone.replace(/\D/g, '');
                        const matchPhone = cPhone.includes(currentPhone) || currentPhone.includes(cPhone);
                        if (matchPhone) {
                            if (!currentPlat || !c.platform) return true;
                            return c.platform.toLowerCase().includes(currentPlat) || currentPlat.includes(c.platform.toLowerCase());
                        }
                        return false;
                    });
                    if (match) return match;
                }

                // 1.2 Coincidencia por nombre de cliente y plataforma
                if (currentName && currentName.length > 3 && currentPlat) {
                    const match = history.find(c => {
                        const cName = (c.clientName || '').toLowerCase();
                        const cPlat = (c.platform || '').toLowerCase();
                        return (cName.includes(currentName) || currentName.includes(cName)) &&
                               (cPlat.includes(currentPlat) || currentPlat.includes(cPlat));
                    });
                    if (match) return match;
                }

                // 1.3 Coincidencia por contenido del mensaje / pantallazo / OCR
                if (combinedCurrent.length > 20) {
                    const match = history.find(c => {
                        const cMsg = (c.rawMessage || c.summary || '').toLowerCase();
                        if (cMsg.length > 15) {
                            if (combinedCurrent.includes(cMsg) || cMsg.includes(combinedCurrent.slice(0, 40))) {
                                return true;
                            }
                        }
                        return false;
                    });
                    if (match) return match;
                }

                // 1.4 Coincidencia temática por palabras clave + plataforma
                if (currentPlat && combinedCurrent.length > 15) {
                    const isRenewalVsNew = combinedCurrent.includes('renov') && (combinedCurrent.includes('nueva') || combinedCurrent.includes('compra'));
                    const isStockIssue = (combinedCurrent.includes('cupo') || combinedCurrent.includes('stock') || combinedCurrent.includes('disponib')) && combinedCurrent.includes('excel');

                    if (isRenewalVsNew || isStockIssue) {
                        const match = history.find(c => {
                            const cPlat = (c.platform || '').toLowerCase();
                            const cSum = (c.summary || '').toLowerCase();
                            const platMatch = cPlat.includes(currentPlat) || currentPlat.includes(cPlat);
                            if (!platMatch) return false;

                            if (isRenewalVsNew) {
                                return cSum.includes('renov') && (cSum.includes('nueva') || cSum.includes('compra'));
                            }
                            if (isStockIssue) {
                                return cSum.includes('cupo') || cSum.includes('stock') || cSum.includes('disponib') || cSum.includes('excel');
                            }
                            return false;
                        });
                        if (match) return match;
                    }
                }
            }
        }

        // 2. Si no encontró en el JSON, buscar directamente en los commits de Git (Git Log)
        try {
            const gitOutput = execSync('git log -n 35 --pretty=format:"COMMIT_SPLIT%h|%ad|%B" --date=iso', {
                cwd: __dirname,
                encoding: 'utf8',
                timeout: 3000
            });
            const entries = gitOutput.split('COMMIT_SPLIT').filter(Boolean);
            for (const entry of entries) {
                const firstPipe = entry.indexOf('|');
                const secondPipe = entry.indexOf('|', firstPipe + 1);
                if (firstPipe === -1 || secondPipe === -1) continue;
                const hash = entry.substring(0, firstPipe).trim();
                const dateStr = entry.substring(firstPipe + 1, secondPipe).trim();
                const body = entry.substring(secondPipe + 1).trim();
                const bodyLower = body.toLowerCase();

                const phoneMatch = currentPhone && currentPhone.length >= 7 && bodyLower.includes(currentPhone);
                const nameMatch = currentName && currentName.length > 3 && bodyLower.includes(currentName);
                const platMatch = currentPlat && currentPlat.length > 3 && bodyLower.includes(currentPlat);

                if (phoneMatch || (nameMatch && platMatch)) {
                    const casoMatch = body.match(/- Caso:\s*([^\n]+)/i);
                    const solMatch = body.match(/- Solución en código:\s*([^\n]+)/i);
                    const msgMatch = body.match(/- Mensaje \/ Reporte:\s*([^\n]+)/i);
                    const clienteMatch = body.match(/- Cliente:\s*([^\n]+)/i);
                    const platExtracted = body.match(/- Plataforma:\s*([^\n]+)/i);

                    const commitDate = new Date(dateStr);
                    return {
                        id: `GIT-${hash}`,
                        resolvedAt: commitDate.toISOString(),
                        resolvedAtHuman: commitDate.toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                        commitHash: hash,
                        clientPhone: currentPhone,
                        clientName: clienteMatch ? clienteMatch[1].trim() : (currentName || null),
                        platform: platExtracted ? platExtracted[1].trim() : (currentPlat || null),
                        summary: casoMatch ? casoMatch[1].trim() : body.split('\n')[0],
                        rawMessage: msgMatch ? msgMatch[1].trim() : null,
                        diagnosis: null,
                        plan: solMatch ? solMatch[1].trim() : null,
                        commitMessage: body
                    };
                }
            }
        } catch (gitErr) {
            // Ignorar errores de git log
        }

        return null;
    } catch (e) {
        console.warn('[ErrorDiagnostic] Error buscando caso resuelto previo:', e.message);
        return null;
    }
}

/**
 * Genera el plan de resolución y commit detallado directamente con Antigravity CLI (agy)
 */
async function generateCliPlanAndCommit(extractedInfo, diagnosticNotes = [], userAdjustment = null, previousTicket = null, imagePath = null, effectiveText = '', recentChatContext = '') {
    let fallbackCausa = extractedInfo.summary || effectiveText || "Incidencia técnica reportada en el flujo de atención del bot.";
    let fallbackPlan = diagnosticNotes.length > 0 
        ? diagnosticNotes.join('\n') 
        : "1. En index.js, validar el enrutamiento de estados para la condición reportada.\n2. Ajustar la respuesta automática para sincronizar el estado del cliente y prevenir inconsistencias.";
    let fallbackCommit = "fix(bot): atender incidencia técnica reportada\n\n- Validaciones en flujos de atención y prevención de regresión.";
    let fallbackFiles = ["index.js"];

    const rawOcrText = (extractedInfo.rawOcr || '').toLowerCase();
    const sumLower = (extractedInfo.summary || effectiveText || '').toLowerCase();

    if (sumLower.includes('codigo') || sumLower.includes('código') || sumLower.includes('2fa') || sumLower.includes('gpt')) {
        fallbackCausa = "El cliente solicitó código de acceso (2FA) para GPT u otra plataforma, pero el bot no detectó la intención o no despachó el código TOTP.";
        fallbackPlan = "1. En aiService.js, reforzar la detección de intenciones de solicitud de código 2FA/TOTP ante variaciones y errores tipográficos (ej: 'godigo', 'código', 'hola me regalas el codigo').\n2. En index.js y totpService.js, asegurar el despacho inmediato del código generado.";
        fallbackCommit = "fix(totp): mejorar detección y respuesta ante solicitudes de código 2FA\n\n- Ampliar expresiones de intención en aiService.js y despacho en totpService.js.";
        fallbackFiles = ["aiService.js", "totpService.js", "index.js"];
    } else if (sumLower.includes('cuenta nueva') || sumLower.includes('renovaci') || sumLower.includes('cobro') || sumLower.includes('cobró') || sumLower.includes('nuevas')) {
        fallbackCausa = "El bot cobró o recibió comprobante de renovación pero respondió prometiendo entrega de accesos o cuentas nuevas en lugar de confirmar la renovación y vigencia del servicio actual.";
        fallbackPlan = "1. En index.js (bloques de respuesta de comprobante líneas ~15620 y ~15778-15792), comprobar el flag `stateData.isRenewal`.\n2. Si `isRenewal` es true, enviar mensaje de renovación ('Un asesor validará tu pago y renovará tu suscripción/servicio') en vez de hablar de 'entregar accesos' o 'pedido nuevo'.";
        fallbackCommit = "fix(billing): diferenciar mensaje de renovación vs cuenta nueva al recibir comprobante\n\n- Evaluar stateData.isRenewal para confirmar renovación de cuentas activas en vez de prometer credenciales nuevas.";
        fallbackFiles = ["index.js"];
    } else if (rawOcrText.includes('bancolombia') || rawOcrText.includes('transferencia') || sumLower.includes('pago') || sumLower.includes('comprobante')) {
        fallbackCausa = `Comprobante de transferencia bancaria (${extractedInfo.platform || 'Bancolombia'}${extractedInfo.clientPhone ? `, celular ${extractedInfo.clientPhone}` : ''}) enviado pero el bot no lo validó ni envió respuesta de confirmación/entrega.`;
        fallbackPlan = `1. En gmailService.js y billingService.js, comprobar la sincronización del buzón de alertas bancarias y ampliar la ventana de tolerancia de minutos para transferencias.\n2. En index.js, asegurar que cuando el cliente envía comprobante con mensaje de cortesía ("Listo gracias"), el bot no se quede en espera humana y proceda con la validación del pago.`;
        fallbackCommit = `fix(billing): mejorar detección y validación de transferencias Bancolombia\n\n- Sincronización de alertas y mitigación de bloqueo en espera humana ante comprobantes con texto de cortesía.`;
        fallbackFiles = ["gmailService.js", "billingService.js", "index.js"];
    }

    const fallbackResponse = {
        causaRaiz: fallbackCausa,
        planCodigo: fallbackPlan,
        commitDetallado: fallbackCommit,
        archivosAfectados: fallbackFiles,
        isPreliminary: true
    };

    const generatePromise = async () => {
        let prompt = '';
        if (userAdjustment && previousTicket) {
            prompt = `Actúas como Antigravity CLI (asistente senior de ingeniería de software para el repositorio whatbot).
El usuario solicitó un AJUSTE / CAMBIO a una propuesta técnica previa:

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
        } else if (imagePath) {
            const absoluteImgPath = path.resolve(__dirname, imagePath);
            prompt = `Actúas como Antigravity CLI (asistente senior de ingeniería de software para el repositorio whatbot en este servidor).
Un asesor reportó una incidencia técnica enviando una captura de pantalla al grupo de WhatsApp "Errors bot".

EVIDENCIA PRINCIPAL (PANTALLAZO GUARDADO EN DISCO):
- RUTA ABSOLUTA DEL ARCHIVO DE IMAGEN: "${absoluteImgPath}"
- PIE DE FOTO / MENSAJE DEL ASESOR: "${effectiveText || extractedInfo.summary || 'Captura de pantalla de soporte enviada'}"
- CONTEXTO RECIENTE DEL GRUPO:
${recentChatContext || 'Sin contexto previo'}

NOTAS DE AUDITORÍA DEL SISTEMA:
${diagnosticNotes.join('\n') || 'Sin notas adicionales'}

INSTRUCCIONES CLAVE DE INGENIERÍA:
1. Inspecciona y examina directamente el archivo de imagen en "${absoluteImgPath}" usando tus herramientas de visión / lectura de archivos.
   - Lee con absoluto detalle todo el texto del pantallazo: los mensajes del cliente, lo que pide (ej: código 2FA para GPT / ChatGPT, renovación, soporte, etc.), las respuestas del bot, números de teléfono o nombres.
   - Identifica la plataforma REAL del servicio (ej: "ChatGPT / GPT", "Netflix", "Amazon", "Disney", "Crunchyroll", etc.).
   ⚠️ NOTA CRÍTICA: "WHATSAPP" NO ES LA PLATAFORMA DEL PROBLEMA. WhatsApp es la aplicación de chat donde el cliente escribe. NUNCA respondas que la plataforma es WHATSAPP.
2. Inspecciona el código fuente REAL de este repositorio (/root/whatbot):
   - Archivos existentes relevantes: totpService.js (manejo de códigos 2FA de GPT y límites de dispositivos), index.js (enrutamiento de mensajes y estados), billingService.js, aiService.js, availabilityService.js, etc.
   ⚠️ REGLA DE ORO: NUNCA inventes carpetas ni nombres de archivo inexistentes como "services/excelService.js" o "controllers/whatsappController.js". Todo el código del bot está en archivos JavaScript en la raíz de /root/whatbot.
3. Devuelve tu respuesta técnica exclusivamente en un JSON estructurado así (sin texto adicional fuera del JSON):
{
  "clientName": string | null,
  "clientPhone": string | null,
  "platform": string, // ej: "ChatGPT / GPT", "Netflix", "Amazon", etc. NUNCA "WHATSAPP".
  "problemType": string, // ej: "solicitud_codigo_2fa", "renovacion_vs_compra", "no_entrega_credenciales", etc.
  "summary": "Resumen fiel y exacto del caso según la captura (ej: Cliente solicita código 2FA para GPT y el bot no responde)",
  "causaRaiz": "Explicación técnica detallada de por qué ocurrió el fallo en el código del bot",
  "planCodigo": "Pasos detallados de las modificaciones en código requeridas en los archivos reales del repositorio",
  "commitDetallado": "Título y cuerpo del commit propuesto con viñetas claras explicando los cambios",
  "archivosAfectados": ["totpService.js", "index.js"]
}`;
        } else {
            prompt = `Actúas como Antigravity CLI (asistente senior de ingeniería para el repositorio whatbot).
Un asesor reportó la siguiente incidencia en el grupo de WhatsApp "Errors bot":
- Caso / Resumen: ${extractedInfo.summary || effectiveText || 'Error reportado en chat'}
- Cliente: ${extractedInfo.clientPhone || 'No especificado'} (${extractedInfo.clientName || 'N/A'})
- Plataforma: ${extractedInfo.platform || 'General'}
- Tipo de problema: ${extractedInfo.problemType || 'incidencia'}
- Estado actual en sistema:
${diagnosticNotes.join('\n') || 'Sin notas adicionales'}

INSTRUCCIÓN:
Analiza los archivos reales de este repositorio (/root/whatbot: index.js, aiService.js, totpService.js, billingService.js, etc.) y genera un plan de solución en código.
⚠️ NUNCA inventes archivos inexistentes como "services/excelService.js" o carpetas ficticias.
Devuelve un JSON estrictamente estructurado así:
{
  "causaRaiz": "Explicación concisa y técnica de por qué ocurrió el fallo en el código o datos",
  "planCodigo": "Pasos detallados de las modificaciones en código en los archivos reales para resolverlo de raíz",
  "commitDetallado": "Título y cuerpo del commit propuesto con viñetas claras explicando los cambios y la prevención de regresión",
  "archivosAfectados": ["archivo_real1.js", "archivo_real2.js"]
}`;
        }

        try {
            console.log('[ErrorDiagnostic] 🚀 Invocando Antigravity CLI (agy) para análisis de ingeniería...');
            const rawOutput = await callAgyCli(prompt, "Eres Antigravity CLI. Inspecciona los archivos y devuelve exclusivamente el JSON solicitado sin bloques markdown ni texto extra.");
            const parsed = extractJsonFromAgyOutput(rawOutput);
            if (parsed && (parsed.causaRaiz || parsed.planCodigo || parsed.summary || parsed.platform)) {
                console.log('[ErrorDiagnostic] ✅ JSON parseado exitosamente de Antigravity CLI:', JSON.stringify({ platform: parsed.platform, clientName: parsed.clientName, summary: parsed.summary }));
                return parsed;
            }
        } catch (agyErr) {
            console.warn('[ErrorDiagnostic] Error invocando Antigravity CLI:', agyErr.message);
        }

        return fallbackResponse;
    };

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(fallbackResponse), 145000));
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
    let effectiveText = (
        message.caption ||
        (message._data && message._data.caption) ||
        (message._data && message._data.comment) ||
        message.body ||
        ''
    ).trim();

    // Si el texto vino vacío en el evento inmediato y el mensaje tiene media o es fromMe,
    // esperar un instante para sincronizar con el chat ya que WhatsApp Web actualiza el caption asíncronamente
    let chat = null;
    try { chat = await message.getChat(); } catch (e) {}

    if (!effectiveText && chat && chat.fetchMessages) {
        try {
            await new Promise(r => setTimeout(r, 1200));
            const recentMsgs = await chat.fetchMessages({ limit: 6 });
            const matchingMsg = recentMsgs.find(m => m.id && (
                m.id._serialized === (message.id && message.id._serialized) || 
                m.id.id === (message.id && message.id.id)
            ));
            if (matchingMsg) {
                effectiveText = (
                    matchingMsg.caption ||
                    (matchingMsg._data && matchingMsg._data.caption) ||
                    (matchingMsg._data && matchingMsg._data.comment) ||
                    matchingMsg.body ||
                    ''
                ).trim();
            }
        } catch (e) {}
    }

    if (!message || (!effectiveText && !message.hasMedia)) return;

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
        const bodyLower = effectiveText.toLowerCase();
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

        if (!chat) {
            try { chat = await message.getChat(); } catch (e) {}
        }
        const chatName = chat ? (chat.name || '') : '';
        const sender = message.author || message.from;
        const senderPhone = sender.replace('@c.us', '').replace(/\D/g, '');
        const textTrimmed = effectiveText;

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
                    if (quoted && (quoted.body || quoted.caption)) quotedText = quoted.caption || quoted.body;
                } catch (e) {}
            }

            const contextText = `${textTrimmed} ${quotedText}`.trim();
            const approvedTicket = approvePendingSolution(contextText, senderPhone);
            if (approvedTicket) {
                if (approvedTicket.isPreliminary || !approvedTicket.plan || (approvedTicket.files && approvedTicket.files.length === 0)) {
                    const notice = `⚠️ *[TICKET EN EVALUACIÓN - SIN PARCHE DE CÓDIGO]* (Ticket #${approvedTicket.id})\n\n` +
                        `Este ticket corresponde a un diagnóstico preliminar u operativo y aún no cuenta con un parche de código generado.\n\n` +
                        `👉 Para indicarle a la IA qué código modificar en el repositorio, escribe:\n` +
                        `*@cambio <indica qué función o archivo modificar>*`;
                    try { await message.reply(notice); } catch (e) {
                        if (client && client.sendMessage) await client.sendMessage(groupChatId, notice).catch(() => {});
                    }
                    return;
                }

                const waitNotice = `⚙️ *[APLICANDO CAMBIOS EN CÓDIGO Y SUBIENDO AL REPOSITORIO...]* (Ticket: #${approvedTicket.id})\n` +
                    `Por favor espera un momento mientras Antigravity CLI aplica las modificaciones, corre validación sintáctica y hace git push...`;
                try { await message.reply(waitNotice); } catch (e) {
                    if (client && client.sendMessage) await client.sendMessage(groupChatId, waitNotice).catch(() => {});
                }

                // Ejecutar el parche en código, commit y push usando Antigravity CLI
                const commitResult = await executeFixAndCommit(approvedTicket);

                if (commitResult.success) {
                    saveResolvedCase(approvedTicket, commitResult);
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
                    updatePendingSolution(approvedTicket.id, { status: 'PENDIENTE_APROBACION' });
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

            const contextText = `${textTrimmed} ${quotedText}`.trim();
            const pendingTicket = getLatestPendingSolution(contextText);
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
            textBody: effectiveText,
            clientPhone: null,
            clientName: null,
            platform: null,
            problemType: null,
            rawOcr: null
        };

        // 3. Buscar si citó un mensaje con imagen
        let targetMediaMsg = message.hasMedia ? message : null;
        let quotedContextText = '';
        if (message.hasQuotedMsg) {
            try {
                const quoted = await message.getQuotedMessage();
                if (quoted) {
                    quotedContextText = (quoted.caption || (quoted._data && quoted._data.caption) || quoted.body || '').trim();
                    if (!targetMediaMsg && quoted.hasMedia) {
                        targetMediaMsg = quoted;
                    }
                }
            } catch (e) {}
        }

        // Si effectiveText estaba vacío pero targetMediaMsg o quoted tienen texto, incorporarlo
        if (!effectiveText) {
            if (targetMediaMsg) {
                effectiveText = (targetMediaMsg.caption || (targetMediaMsg._data && targetMediaMsg._data.caption) || (targetMediaMsg._data && targetMediaMsg._data.comment) || targetMediaMsg.body || '').trim();
            }
            if (!effectiveText && quotedContextText) {
                effectiveText = quotedContextText;
            }
        } else if (quotedContextText && !effectiveText.includes(quotedContextText)) {
            effectiveText = `${effectiveText} (citando: "${quotedContextText.slice(0, 90)}")`;
        }

        extractedInfo.textBody = effectiveText;

        // 4. Si no citó imagen, buscar en los mensajes recientes del grupo (hasta 20 mensajes atrás en las últimas 24 horas)
        // REGLA CRÍTICA: Filtrar y excluir TODOS los mensajes generados por el bot para romper cualquier bucle de retroalimentación
        let recentChatContext = '';
        if (chat && chat.fetchMessages) {
            try {
                const recents = await chat.fetchMessages({ limit: 20 });
                const validRecents = recents.filter(m => {
                    if (!m) return false;
                    if (Math.abs(message.timestamp - m.timestamp) > 86400) return false;
                    if (m.fromMe) return false;
                    const b = ((m.body || '') + ' ' + (m.caption || '')).toLowerCase();
                    if (b.includes('ticket #err') || b.includes('ticket: #err') || b.includes('[auditoría') || b.includes('diagnóstico técnico:') || b.includes('la auditoría preliminar') || b.includes('🤖')) {
                        return false;
                    }
                    return true;
                });
                if (!targetMediaMsg) {
                    // Buscar la imagen más reciente enviada por un asesor humano en el chat
                    const mediaMsg = [...validRecents].reverse().find(m => m.hasMedia);
                    if (mediaMsg) targetMediaMsg = mediaMsg;
                }
                recentChatContext = validRecents.slice(-6).map(m => `[${m.author || m.from}]: ${(m.caption || (m._data && m._data.caption) || m.body || (m.hasMedia ? '[Captura/Imagen adjunta]' : ''))}`).join('\n');
            } catch (e) {}
        }

        // 5. Si el reporte contiene o está asociado a una imagen (captura de WhatsApp, comprobante, etc.)
        let ocrSuccess = false;
        let imageDiskPath = null;
        let fullImageDiskPath = null;

        if (targetMediaMsg && targetMediaMsg.hasMedia) {
            console.log(`[ErrorDiagnostic] 📥 Intentando descargar imagen del reporte (${targetMediaMsg.id ? targetMediaMsg.id._serialized : 'media'})...`);

            // 0. Intento instantáneo: Descifrado criptográfico nativo de WhatsApp (inmune a errores de navegador)
            try {
                const { downloadMediaDirect } = require('./mediaDecryptService');
                const directMedia = await downloadMediaDirect(targetMediaMsg);
                if (directMedia && directMedia.data) {
                    const errorsDir = path.join(__dirname, 'uploads', 'errors');
                    if (!fs.existsSync(errorsDir)) fs.mkdirSync(errorsDir, { recursive: true });
                    const ext = (directMedia.mimetype && directMedia.mimetype.includes('png')) ? 'png' : 'jpg';
                    const filename = `error_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                    const fullPath = path.join(errorsDir, filename);
                    fs.writeFileSync(fullPath, Buffer.from(directMedia.data, 'base64'));
                    imageDiskPath = path.relative(__dirname, fullPath);
                    fullImageDiskPath = fullPath;
                    console.log(`[ErrorDiagnostic] 📸 Captura descargada y descifrada con éxito vía nativo en: ${fullPath} (${Math.round(directMedia.data.length / 1024)} KB)`);
                }
            } catch (dirErr) {
                console.warn('[ErrorDiagnostic] Falló intento directo nativo:', dirErr.message);
            }

            if (!imageDiskPath) {
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        // 1. Intento estándar de whatsapp-web.js
                        let media = await Promise.race([
                            targetMediaMsg.downloadMedia(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout descarga media 25s')), 25000))
                        ]);

                    // 2. Si vino vacío, intentar con Puppeteer forzando la descarga y esperando RESOLVED
                    if ((!media || !media.data) && client && client.pupPage) {
                        try {
                            const targetId = targetMediaMsg.id ? (targetMediaMsg.id._serialized || targetMediaMsg.id.id) : null;
                            if (targetId) {
                                media = await client.pupPage.evaluate(async (id) => {
                                    const m = window.Store.Msg.get(id) || (await window.Store.Msg.getMessagesById([id]))?.messages?.[0];
                                    if (!m) return null;
                                    if (m.mediaData && m.mediaData.mediaStage !== 'RESOLVED') {
                                        try {
                                            if (typeof m.downloadMedia === 'function') {
                                                m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                                            }
                                        } catch (err) {}
                                    }
                                    for (let i = 0; i < 16; i++) {
                                        if (m.mediaData && m.mediaData.mediaStage === 'RESOLVED') break;
                                        await new Promise(r => setTimeout(r, 500));
                                    }
                                    try {
                                        const decrypted = await window.Store.DownloadManager.downloadAndMaybeDecrypt({
                                            directPath: m.directPath,
                                            encFilehash: m.encFilehash,
                                            filehash: m.filehash,
                                            mediaKey: m.mediaKey,
                                            mediaKeyTimestamp: m.mediaKeyTimestamp,
                                            type: m.type,
                                            signal: (new AbortController()).signal
                                        });
                                        if (decrypted) {
                                            return {
                                                data: window.WWebJS.arrayBufferToBase64(decrypted),
                                                mimetype: m.mimetype,
                                                filename: m.filename
                                            };
                                        }
                                    } catch (e) {
                                        return null;
                                    }
                                    return null;
                                }, targetId);
                            }
                        } catch (pupErr) {
                            console.warn('[ErrorDiagnostic] Error en Puppeteer download:', pupErr.message);
                        }
                    }

                    // 3. Si sigue vacío, re-sincronizar el mensaje consultándolo fresco desde el chat
                    if ((!media || !media.data) && chat && chat.fetchMessages) {
                        try {
                            const recents = await chat.fetchMessages({ limit: 6 });
                            const fresh = recents.find(m => m.id && targetMediaMsg.id && (
                                m.id._serialized === targetMediaMsg.id._serialized ||
                                m.id.id === targetMediaMsg.id.id
                            )) || recents.slice().reverse().find(m => m.hasMedia);
                            if (fresh && fresh.hasMedia && fresh !== targetMediaMsg) {
                                targetMediaMsg = fresh;
                                media = await targetMediaMsg.downloadMedia();
                            }
                        } catch (refErr) {}
                    }

                    if (media && media.data) {
                        const errorsDir = path.join(__dirname, 'uploads', 'errors');
                        if (!fs.existsSync(errorsDir)) fs.mkdirSync(errorsDir, { recursive: true });
                        const ext = (media.mimetype && media.mimetype.includes('png')) ? 'png' : 'jpg';
                        const filename = `error_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
                        const fullPath = path.join(errorsDir, filename);
                        fs.writeFileSync(fullPath, Buffer.from(media.data, 'base64'));
                        imageDiskPath = path.relative(__dirname, fullPath);
                        fullImageDiskPath = fullPath;
                        console.log(`[ErrorDiagnostic] 📸 Captura de pantalla guardada exitosamente en: ${fullPath} (${Math.round(media.data.length / 1024)} KB)`);
                        break;
                    } else {
                        console.warn(`[ErrorDiagnostic] Intento ${attempt}: downloadMedia devolvió vacío.`);
                    }
                } catch (dErr) {
                    console.warn(`[ErrorDiagnostic] Intento ${attempt} descargando imagen falló:`, dErr.message);
                }
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

        // Si el asesor envió solo una imagen y NO se pudo descargar en disco, AVISAR de forma honesta en vez de inventar
        if (!imageDiskPath && !effectiveText) {
            console.warn('[ErrorDiagnostic] ⚠️ No se pudo descargar la captura de pantalla y no hay texto explicativo. Abortando para evitar alucinación.');
            const retryNotice = `⚠️ *[NO SE PUDO LEER LA CAPTURA EN ESTE INTENTO]*\n\n` +
                `WhatsApp Web no completó la descarga del archivo multimedia en el servidor.\n\n` +
                `👉 Por favor reenvía el pantallazo o escribe una breve descripción del error (ej: _"El bot no entrega el código 2FA de GPT"_).`;
            try {
                await message.reply(retryNotice);
            } catch (err) {
                if (client && client.sendMessage) await client.sendMessage(groupChatId, retryNotice).catch(() => {});
            }
            return;
        }

        // Si no hay imagen en disco pero SÍ tenemos texto del asesor, asignar el texto directamente para que Antigravity CLI lo analice
        if (!imageDiskPath && (!extractedInfo.summary || !extractedInfo.problemType)) {
            extractedInfo.summary = effectiveText;
            const phoneMatch = effectiveText.match(/(\b57\d{10}\b|\b3\d{9}\b)/);
            if (phoneMatch) {
                extractedInfo.clientPhone = phoneMatch[1];
            }
        }

        // 6. Normalizar teléfono si se detectó
        let cleanPhone = extractedInfo.clientPhone ? extractedInfo.clientPhone.replace(/\D/g, '') : null;
        if (cleanPhone && cleanPhone.length > 10 && cleanPhone.startsWith('57')) {
            cleanPhone = cleanPhone.slice(-10);
        }

        // =========================================================================
        // 6.1 Detección de Casos Ya Resueltos en Commits (Evitar Trabajo Duplicado)
        // =========================================================================
        const existingResolved = findExistingResolvedCase(extractedInfo, effectiveText);
        if (existingResolved) {
            const botStartTime = Date.now() - (process.uptime() * 1000);
            const resolvedTime = new Date(existingResolved.resolvedAt).getTime();
            // Si el commit se generó después de que este proceso de Node inició, requiere reinicio
            const needsRestart = !isNaN(resolvedTime) && (resolvedTime > botStartTime);

            console.log(`[ErrorDiagnostic] ⚡ Caso ya resuelto detectado (#${existingResolved.id}, commit ${existingResolved.commitHash}). Requiere restart: ${needsRestart}`);

            if (needsRestart) {
                const restartNotice = `ℹ️ *[CASO YA SOLUCIONADO EN REPOSITORIO - PENDIENTE REINICIO]* (Ticket #${existingResolved.id})\n\n` +
                    `📅 *Fecha de solución:* ${existingResolved.resolvedAtHuman || 'Reciente'}\n` +
                    `👤 *Cliente:* ${existingResolved.clientName || 'Identificado'} ${existingResolved.clientPhone ? `(+57 ${existingResolved.clientPhone})` : ''}\n` +
                    `📺 *Plataforma:* ${existingResolved.platform || 'General'}\n` +
                    `📦 *Commit en GitHub:* \`${existingResolved.commitHash}\`\n\n` +
                    `📋 *Caso previo solucionado:*\n${existingResolved.summary}\n\n` +
                    (existingResolved.rawMessage ? `💬 *Mensaje/Reporte registrado:*\n"${existingResolved.rawMessage.length > 120 ? existingResolved.rawMessage.slice(0, 120) + '...' : existingResolved.rawMessage}"\n\n` : '') +
                    `⚡ *Este caso ya fue corregido en el código.* No es necesario generar otro commit ni crear un nuevo reporte.\n\n` +
                    `🔄 *Para activar los cambios en el servidor:* Solo escribe *@restart* y el bot se reiniciará con el parche en vivo.`;

                try {
                    await message.reply(restartNotice);
                } catch (repErr) {
                    if (client && client.sendMessage) {
                        await client.sendMessage(groupChatId, restartNotice).catch(() => {});
                    }
                }
                return;
            } else {
                const activeNotice = `✅ *[CASO YA RESUELTO Y ACTIVO EN EL SERVIDOR]* (Ticket #${existingResolved.id})\n\n` +
                    `📅 *Solucionado el:* ${existingResolved.resolvedAtHuman || 'Reciente'} en el commit \`${existingResolved.commitHash}\`\n` +
                    `👤 *Cliente:* ${existingResolved.clientName || 'Identificado'} ${existingResolved.clientPhone ? `(+57 ${existingResolved.clientPhone})` : ''}\n` +
                    `📺 *Plataforma:* ${existingResolved.platform || 'General'}\n\n` +
                    `📋 *Caso:* ${existingResolved.summary}\n` +
                    `📝 *Solución aplicada en código:*\n${existingResolved.plan || existingResolved.diagnosis || 'Validaciones y flujos ajustados'}\n\n` +
                    `ℹ️ Esta corrección ya se encuentra activa en caliente en el servidor.\n` +
                    `👉 Si consideras que persiste un fallo diferente, escribe: *@cambio <indica el detalle>*`;

                try {
                    await message.reply(activeNotice);
                } catch (repErr) {
                    if (client && client.sendMessage) {
                        await client.sendMessage(groupChatId, activeNotice).catch(() => {});
                    }
                }
                return;
            }
        }

        // 7. Cruzar datos con el sistema en tiempo real
        let accountsFound = [];
        let stockAvailable = null;
        let diagnosticNotes = [];
        let catalogPlatform = null;

        const INVALID_PLATFORMS = ['WHATSAPP', 'GENERAL', 'BOT', 'SOPORTE', 'CHAT', 'DESCONOCIDO', 'N/A'];
        const isPlatValid = extractedInfo.platform && !INVALID_PLATFORMS.includes(extractedInfo.platform.toUpperCase().trim());
        const platUpper = (extractedInfo.platform || 'servicio').toUpperCase();

        // 7.1 Auditoría de Catálogo Web vs Excel Online SOLO para plataformas comerciales de venta reales
        if (isPlatValid) {
            const { getPlatformsFromDb } = require('./platformsDbService');
            try {
                stockAvailable = await checkSpreadsheetStock(extractedInfo.platform);
            } catch (e) {}

            try {
                const platforms = await getPlatformsFromDb();
                const cleanTarget = extractedInfo.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
                catalogPlatform = platforms.find(p => {
                    const cleanP = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    return cleanP.includes(cleanTarget) || cleanTarget.includes(cleanP);
                });
            } catch (e) {}

            if (catalogPlatform) {
                diagnosticNotes.push(`🌐 *Página Web (sheerit.co):* *${catalogPlatform.name}* está publicado y activo para venta ($${Number(catalogPlatform.price || 0).toLocaleString('es-CO')}/mes).`);
            }
            if (stockAvailable !== null) {
                if (stockAvailable) {
                    diagnosticNotes.push(`📄 *Excel Online:* Hay cupos libres registrados en el inventario.`);
                } else {
                    diagnosticNotes.push(`📄 *Excel Online:* ⚠️ 0 cupos libres encontrados en la hoja para *${platUpper}*.`);
                }
            }
            if (catalogPlatform && stockAvailable === false) {
                diagnosticNotes.push(`🚨 *Discrepancia detectada:* El catálogo web permite comprar *${platUpper}* aunque el inventario de Excel no tiene cupos.`);
                diagnosticNotes.push(`⚡ *Acción operativa recomendada:* Puedes pausar temporalmente este servicio en la web escribiendo: *@bot pausar ${extractedInfo.platform.toLowerCase()}*`);
            }
        }

        // 7.2 Auditoría de Cliente y Cola de Turnos
        if (cleanPhone) {
            try {
                accountsFound = await getAccountsByPhone(cleanPhone, extractedInfo.clientName, true);
                if (accountsFound.length > 0) {
                    const acc = accountsFound[0];
                    diagnosticNotes.push(`👤 *Cuentas registradas para +57 ${cleanPhone}:* ${acc.Streaming} (${acc.correo || 'sin correo'})\n• Fecha cliente (deben): *${acc.deben || 'N/A'}*\n• Vencimiento proveedor: *${acc.vencimiento || 'N/A'}*`);
                }
            } catch (e) {}

            if (global.supportQueue && Array.isArray(global.supportQueue)) {
                const queueIdx = global.supportQueue.findIndex(id => id.includes(cleanPhone));
                if (queueIdx !== -1) {
                    diagnosticNotes.push(`📌 *Turno en cola en memoria:* #${queueIdx + 1} de ${global.supportQueue.length} turnos registrados en caché.`);
                }
            }
        }

        if (extractedInfo.problemType === 'no_entrega_credenciales' || /no entrega|cupos|asignación manual/i.test(extractedInfo.summary || '')) {
            if (stockAvailable === false && !diagnosticNotes.some(n => n.includes('0 cupos libres'))) {
                diagnosticNotes.push(`⚠️ No se encontraron cupos libres en Excel para *${platUpper}*. Requiere que un administrador cree o agregue una cuenta en la hoja.`);
            }
        } else if (extractedInfo.problemType === 'vencimiento_error' || /vencimiento|deben|renov/i.test(extractedInfo.summary || '')) {
            if (accountsFound.length > 0 && !diagnosticNotes.some(n => n.includes('Cuentas registradas'))) {
                const acc = accountsFound[0];
                diagnosticNotes.push(`📅 Cuenta registrada: ${acc.Streaming} (${acc.correo || 'sin correo'})\n• Fecha cliente (deben): *${acc.deben || 'N/A'}*\n• Fecha proveedor (vencimiento interno): *${acc.vencimiento || 'N/A'}*`);
            }
        } else if (extractedInfo.problemType === 'clave_incorrecta' || /contraseña|clave|incorrecta|anterior/i.test(extractedInfo.summary || '') || /contraseña|clave|anterior/i.test(effectiveText)) {
            if (accountsFound.length > 0 && !diagnosticNotes.some(n => n.includes('Cuenta en caché'))) {
                const acc = accountsFound[0];
                diagnosticNotes.push(`🔑 Cuenta en caché: ${acc.Streaming} (${acc.correo || 'N/A'})\n• Clave registrada: *${acc.contraseña || acc.clave || 'N/A'}*\n• Vencimiento: *${acc.vencimiento || 'N/A'}*`);
            }
        }

        // 8. Generar Plan de Solución CLI y Commit Detallado con Antigravity CLI (agy)
        const ticketId = `ERR-${Date.now().toString().slice(-6)}`;
        const cliSolution = await generateCliPlanAndCommit(extractedInfo, diagnosticNotes, null, null, fullImageDiskPath || imageDiskPath, effectiveText, recentChatContext);

        if (cliSolution.platform && cliSolution.platform.toUpperCase() !== 'WHATSAPP') {
            extractedInfo.platform = cliSolution.platform;
        }
        if (cliSolution.clientName && !extractedInfo.clientName) {
            extractedInfo.clientName = cliSolution.clientName;
        }
        if (cliSolution.clientPhone && !extractedInfo.clientPhone) {
            extractedInfo.clientPhone = cliSolution.clientPhone;
            cleanPhone = cliSolution.clientPhone.replace(/\D/g, '').slice(-10);
        }
        if (cliSolution.summary && (!extractedInfo.summary || extractedInfo.summary.toLowerCase().includes('no envió texto'))) {
            extractedInfo.summary = cliSolution.summary;
        }
        if (cliSolution.problemType) {
            extractedInfo.problemType = cliSolution.problemType;
        }

        const platDisplay = (extractedInfo.platform && extractedInfo.platform.toUpperCase() !== 'WHATSAPP') 
            ? extractedInfo.platform.toUpperCase() 
            : (cliSolution.platform && cliSolution.platform.toUpperCase() !== 'WHATSAPP' ? cliSolution.platform.toUpperCase() : 'GENERAL');

        // Guardar ticket como pendiente de aprobación
        savePendingSolution({
            id: ticketId,
            reportedBy: senderPhone,
            summary: extractedInfo.summary || effectiveText,
            clientName: extractedInfo.clientName || null,
            clientPhone: cleanPhone,
            platform: platDisplay,
            rawMessage: effectiveText || extractedInfo.rawOcr || extractedInfo.summary || '',
            rawOcr: extractedInfo.rawOcr || '',
            diagnosis: cliSolution.causaRaiz,
            plan: cliSolution.planCodigo,
            commitMessage: cliSolution.commitDetallado,
            files: cliSolution.archivosAfectados,
            isPreliminary: Boolean(cliSolution.isPreliminary),
            status: 'PENDIENTE_APROBACION',
            createdAt: new Date().toISOString()
        });

        // 9. Construir Mensaje de Respuesta
        let responseMsg = '';
        if (cliSolution.isPreliminary) {
            responseMsg += `⚠️ *[AUDITORÍA PRELIMINAR]* (Ticket #${ticketId})\n\n`;
        } else {
            responseMsg += `🛠️ *[AUDITORÍA Y PROPUESTA TÉCNICA]* (Ticket #${ticketId})\n\n`;
        }

        const reportedText = effectiveText || (extractedInfo.summary || '');
        if (reportedText) {
            responseMsg += `💬 *En respuesta a:* "${reportedText.length > 90 ? reportedText.slice(0, 90) + '...' : reportedText}"\n`;
        }
        if (extractedInfo.clientName || cleanPhone) {
            responseMsg += `👤 *Cliente:* ${extractedInfo.clientName || 'Identificado'} ${cleanPhone ? `(+57 ${cleanPhone})` : ''}\n`;
        }
        if (extractedInfo.platform) {
            responseMsg += `📺 *Plataforma:* ${platUpper}\n`;
        }
        if (extractedInfo.summary) {
            responseMsg += `📋 *Situación:* ${extractedInfo.summary}\n`;
        }

        if (diagnosticNotes.length > 0) {
            responseMsg += `\n🔍 *REVISIÓN REALIZADA EN EL SISTEMA:*\n` + diagnosticNotes.map(n => `• ${n}`).join('\n') + `\n`;
        }

        if (cliSolution.causaRaiz && cliSolution.causaRaiz !== extractedInfo.summary) {
            responseMsg += `\n🔬 *Diagnóstico Técnico:* \n${cliSolution.causaRaiz}\n`;
        }

        if (cliSolution.isPreliminary) {
            responseMsg += `\n💡 *Acción / Solución:* \n${cliSolution.planCodigo}\n`;
            responseMsg += `\n👉 *Para implementar un parche en código:* Escribe *@cambio <indica qué función o archivo cambiar>*\n`;
        } else {
            responseMsg += `\n💡 *Plan de Modificaciones en Código:* \n${cliSolution.planCodigo}\n`;
            if (cliSolution.commitDetallado) {
                responseMsg += `\n📝 *Commit Propuesto:* \n\`\`\`\n${cliSolution.commitDetallado}\n\`\`\`\n`;
            }
            responseMsg += `\n👉 *Para implementar cambio en código y subir a GitHub:* Escribe *@commit*\n`;
            responseMsg += `✏️ *Para pedir otra solución o ajuste:* Escribe *@cambio <la solución que quieres>*\n`;
            responseMsg += `\n⚠️ *Nota:* El comando *@restart* solo estará disponible una vez que apruebes con *@commit*.`;
        }

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

