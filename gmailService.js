const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');
const fs = require('fs');
const path = require('path');

const PROCESSED_EMAILS_PATH = path.join(__dirname, 'processed_emails.json');

/**
 * Carga la lista de IDs de correos ya procesados para evitar duplicados.
 */
function loadProcessedEmails() {
    if (!fs.existsSync(PROCESSED_EMAILS_PATH)) return [];
    try {
        return JSON.parse(fs.readFileSync(PROCESSED_EMAILS_PATH, 'utf8'));
    } catch (e) { return []; }
}

/**
 * Guarda un ID de correo como procesado.
 */
function saveProcessedEmail(id) {
    const processed = loadProcessedEmails();
    if (!processed.includes(id)) {
        processed.push(id);
        // Mantener solo los últimos 100 para no inflar el archivo
        if (processed.length > 100) processed.shift();
        fs.writeFileSync(PROCESSED_EMAILS_PATH, JSON.stringify(processed));
    }
}

/**
 * Escanea Gmail en busca de correos de Bre-B y extrae los pagos.
 */
async function checkNewPayments() {
    const auth = getOAuth2Client();
    if (!auth) return [];

    const gmail = google.gmail({ version: 'v1', auth });
    const processedIds = loadProcessedEmails();

    try {
        // Buscamos correos con el asunto específico de Bre-B
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'subject:"Detalle de tu venta por Bre-B"',
            maxResults: 10
        });

        const messages = res.data.messages || [];
        const newPayments = [];

        for (const msg of messages) {
            if (processedIds.includes(msg.id)) continue;

            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            // Extraer el texto del correo (puede estar en snippet o body)
            const snippet = fullMsg.data.snippet || '';
            const bodyData = fullMsg.data.payload.body.data ? Buffer.from(fullMsg.data.payload.body.data, 'base64').toString() : '';
            const body = snippet + ' ' + bodyData;

            // 1. Verificar que el estado sea Aprobada o Exitosa
            const isApproved = /Estado:\s*(?:Aprobada|Exitosa)/i.test(body) || /Venta exitosa/i.test(body);
            if (!isApproved) {
                console.log(`[GMAIL SCAN] Ignorando correo ID: ${msg.id} (No parece ser una venta aprobada).`);
                saveProcessedEmail(msg.id); // Guardar para no procesar de nuevo
                continue;
            }
            
            // 2. Extraer el valor (Monto: $ 6.000)
            const amountRegex = /Monto:\s*(?:\$)?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)/i;
            const amountMatches = body.match(amountRegex);
            
            if (amountMatches) {
                // Limpiar el valor para convertirlo a número puro (Ej: 6.000 -> 6000)
                const rawValue = amountMatches[1];
                const cleanValue = parseInt(rawValue.replace(/\./g, '').split(',')[0]);

                console.log(`[GMAIL SCAN] ✅ Detectado pago de $${cleanValue} en correo ID: ${msg.id}`);
                
                newPayments.push({
                    id: msg.id,
                    amount: cleanValue,
                    date: fullMsg.data.internalDate
                });
                
                saveProcessedEmail(msg.id);
            }
        }

        return newPayments;
    } catch (error) {
        console.error('❌ Error escaneando Gmail:', error.message);
        return [];
    }
}

/**
 * Busca un pago específico por monto en los correos recientes de Gmail.
 * @param {number} targetAmount 
 * @param {number} toleranceMinutes 
 * @returns {Promise<Object|null>}
 */
async function findMatchingPayment(targetAmount, toleranceMinutes = 30) {
    console.log(`[GMAIL MATCH] Buscando pago de $${targetAmount} en los últimos ${toleranceMinutes} min...`);
    const auth = getOAuth2Client();
    if (!auth) return null;

    const gmail = google.gmail({ version: 'v1', auth });
    
    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'subject:"Detalle de tu venta por Bre-B"',
            maxResults: 15
        });

        const messages = res.data.messages || [];
        const now = Date.now();

        for (const msg of messages) {
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            const internalDate = parseInt(fullMsg.data.internalDate);
            const diffMinutes = (now - internalDate) / (1000 * 60);

            if (diffMinutes > toleranceMinutes) {
                // Como los correos vienen ordenados por fecha, si este ya pasó la tolerancia, los siguientes también
                // break; // Descomentar si se quiere optimizar, pero cuidado con el orden de list()
            }

            const snippet = fullMsg.data.snippet || '';
            const bodyData = fullMsg.data.payload.body.data ? Buffer.from(fullMsg.data.payload.body.data, 'base64').toString() : '';
            const body = snippet + ' ' + bodyData;

            const isApproved = /Estado:\s*(?:Aprobada|Exitosa)/i.test(body) || /Venta exitosa/i.test(body);
            if (!isApproved) continue;

            const amountRegex = /Monto:\s*(?:\$)?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)/i;
            const amountMatches = body.match(amountRegex);

            if (amountMatches) {
                const rawValue = amountMatches[1];
                const cleanValue = parseInt(rawValue.replace(/\./g, '').split(',')[0]);

                if (cleanValue === targetAmount) {
                    console.log(`[GMAIL MATCH] ✅ ¡MATCH ENCONTRADO! ID: ${msg.id}`);
                    return {
                        id: msg.id,
                        amount: cleanValue,
                        date: internalDate,
                        diffMinutes: Math.round(diffMinutes)
                    };
                }
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Error en findMatchingPayment:', error.message);
        return null;
    }
}

module.exports = {
    checkNewPayments,
    findMatchingPayment
};
