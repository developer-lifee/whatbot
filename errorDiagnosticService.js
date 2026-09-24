const fs = require('fs');
const path = require('path');
const { getAccountsByPhone, fetchRawData } = require('./apiService');
const { callDeepSeek, describeImageWithGemini } = require('./aiService');
const { checkSpreadsheetStock } = require('./availabilityService');

const ERRORS_LOG_PATH = path.join(__dirname, 'logs', 'reported_errors.json');

/**
 * Verifica si un chat es un grupo de reporte de errores o administración
 */
function isErrorDiagnosticGroup(chatId, chatName = '') {
    if (!chatId || !chatId.endsWith('@g.us')) return false;
    if (chatId === '120363427163636523@g.us') return true;
    const nameLower = (chatName || '').toLowerCase();
    const isNameMatch = /error|errores|bug|bugs|falla|fallas|incidencia|incidencias/i.test(nameLower);
    return isNameMatch;
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
 * Diagnostica un reporte enviado por un asesor en el grupo "errors bot"
 */
async function handleAdvisorErrorReport(message, client, userStates) {
    try {
        const chat = await message.getChat();
        const chatName = chat ? (chat.name || '') : '';
        const sender = message.author || message.from;
        const senderPhone = sender.replace('@c.us', '').replace(/\D/g, '');

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

        // 1. Si el reporte contiene imagen (captura de WhatsApp, comprobante, etc.)
        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (media && media.data) {
                    const ocrPrompt = `Analiza esta captura de pantalla enviada al grupo de errores de soporte técnico.
Puede ser una conversación de WhatsApp con un cliente, un comprobante bancario, una pantalla de la web o un error de sistema.

Extrae en formato JSON:
{
  "clientPhone": string | null, // Teléfono del cliente si se ve en el encabezado, texto o comprobante (ej: "3125297905")
  "clientName": string | null,  // Nombre del cliente o contacto si aparece
  "platform": string | null,    // Plataforma involucrada (Netflix, Prime Video, YouTube, Disney, HBO, Spotify, etc.)
  "problemType": string,        // "comprobante_rechazado", "no_entrega_credenciales", "vencimiento_error", "cobro_indebido", "cupos_agotados", "otro"
  "summary": string             // Resumen de qué ocurrió según la captura (ej: "El bot dijo que requiere activación manual pero hay cupos")
}`;
                    const mediaObj = { data: media.data, mimeType: media.mimetype || 'image/jpeg' };
                    const visionText = await describeImageWithGemini(mediaObj, message.body || '');
                    extractedInfo.rawOcr = visionText;

                    try {
                        const jsonParsed = await callDeepSeek(
                            `A partir de la siguiente descripción visual de la captura y el comentario del asesor, extrae los datos solicitados en formato JSON:\n\nCOMENTARIO ASESOR: "${message.body || ''}"\n\nDESCRIPCIÓN CAPTURA:\n${visionText}\n\n` + ocrPrompt,
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
            // Si es solo texto
            try {
                const textParsed = await callDeepSeek(
                    `Analiza este reporte de error enviado por un asesor:\n"${message.body}"\n\nExtrae en JSON:
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

        // 2. Normalizar teléfono si se detectó
        let cleanPhone = extractedInfo.clientPhone ? extractedInfo.clientPhone.replace(/\D/g, '') : null;
        if (cleanPhone && cleanPhone.length > 10 && cleanPhone.startsWith('57')) {
            cleanPhone = cleanPhone.slice(-10);
        }

        // 3. Cruzar datos con el sistema
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

        // 4. Determinar Causa Raíz y Acción
        let actionSuggestion = "";
        const platUpper = (extractedInfo.platform || 'servicio').toUpperCase();

        if (extractedInfo.problemType === 'no_entrega_credenciales' || /no entrega|cupos|asignación manual/i.test(extractedInfo.summary || '')) {
            if (stockAvailable) {
                diagnosticNotes.push(`✅ Hay cupos libres disponibles para *${platUpper}* en el inventario.`);
                if (cleanPhone) {
                    actionSuggestion = `👉 *Para entregarle credenciales al cliente ahora mismo:* Responde a este mensaje con:\n*@bot confirmar ${cleanPhone} ${platUpper}*`;
                } else {
                    actionSuggestion = `👉 Para entregarle credenciales automáticamente, escribe:\n*@bot confirmar <número_del_cliente> ${platUpper}*`;
                }
            } else {
                diagnosticNotes.push(`⚠️ No se encontraron cupos libres en Excel para *${platUpper}*. Requiere que un administrador cree o agregue una cuenta en la hoja.`);
            }
        } else if (extractedInfo.problemType === 'vencimiento_error' || /vencimiento|deben|renov/i.test(extractedInfo.summary || '')) {
            if (accountsFound.length > 0) {
                const acc = accountsFound[0];
                diagnosticNotes.push(`📅 Cuenta registrada: ${acc.Streaming} (${acc.correo || 'sin correo'})\n• Fecha cliente (deben): *${acc.deben || 'N/A'}*\n• Fecha proveedor (vencimiento interno): *${acc.vencimiento || 'N/A'}*`);
                if (cleanPhone) {
                    actionSuggestion = `👉 *Para actualizar la fecha de pago del cliente:* Escribe:\n*@bot confirmar ${cleanPhone} ${acc.Streaming}*`;
                }
            } else {
                diagnosticNotes.push(`ℹ️ No se encontró cuenta previa para el número ${cleanPhone || 'desconocido'}.`);
            }
        } else if (extractedInfo.problemType === 'comprobante_rechazado' || /comprobante|recibo|pago/i.test(extractedInfo.summary || '')) {
            diagnosticNotes.push(`📸 Comprobante bancario recibido.`);
            if (cleanPhone) {
                actionSuggestion = `👉 *Para aprobar la transferencia y entregar accesos:* Responde con:\n*@bot confirmar ${cleanPhone}*`;
            } else {
                actionSuggestion = `👉 Para aprobar la transferencia, escribe:\n*@bot confirmar <número_del_cliente>*`;
            }
        } else {
            if (cleanPhone) {
                actionSuggestion = `👉 Si el cliente realizó un pago y deseas activarlo, responde:\n*@bot confirmar ${cleanPhone}*`;
            }
        }

        // 5. Construir Respuesta en el Grupo
        let responseMsg = `🤖 *DIAGNÓSTICO AUTOMÁTICO DE REPORTE*\n\n`;
        if (extractedInfo.summary) {
            responseMsg += `📋 *Caso:* ${extractedInfo.summary}\n`;
        }
        if (cleanPhone) {
            responseMsg += `👤 *Cliente:* +57 ${cleanPhone}${extractedInfo.clientName ? ` (${extractedInfo.clientName})` : ''}\n`;
        }
        if (extractedInfo.platform) {
            responseMsg += `📺 *Plataforma:* ${platUpper}\n`;
        }

        if (diagnosticNotes.length > 0) {
            responseMsg += `\n🔍 *Estado en Sistema:*\n${diagnosticNotes.join('\n')}\n`;
        }

        if (actionSuggestion) {
            responseMsg += `\n⚡ *Solución Rápida:*\n${actionSuggestion}\n`;
        }

        responseMsg += `\n_Reportado por @${senderPhone}. Incidencia registrada en auditoría._`;

        // Responder citando el mensaje del asesor
        await message.reply(responseMsg);

        // Guardar registro
        logReportedError({
            reporterPhone: senderPhone,
            chatName,
            extractedInfo,
            accountsCount: accountsFound.length,
            stockAvailable
        });

    } catch (err) {
        console.error('[ErrorDiagnostic] Error procesando reporte de asesor:', err.message);
    }
}

module.exports = {
    isErrorDiagnosticGroup,
    handleAdvisorErrorReport,
    logReportedError
};
