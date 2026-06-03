const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');
const fs = require('fs');
const path = require('path');

const PROCESSED_EMAILS_PATH = path.join(__dirname, 'processed_emails.json');

const PAYMENT_EMAIL = 'jordimemesmomazosdick@gmail.com';

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
    const auth = await getOAuth2Client('gmail', null, PAYMENT_EMAIL);
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

async function findMatchingPaymentInAccount(email, query, targetAmount, toleranceMinutes, isBancolombia = false) {
    const auth = await getOAuth2Client('gmail', null, email);
    if (!auth) return null;

    const gmail = google.gmail({ version: 'v1', auth });
    const processedIds = loadProcessedEmails();
    
    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 15
        });

        const messages = res.data.messages || [];
        const now = Date.now();

        for (const msg of messages) {
            if (processedIds.includes(msg.id)) {
                continue;
            }

            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            const internalDate = parseInt(fullMsg.data.internalDate);
            const diffMinutes = (now - internalDate) / (1000 * 60);

            if (diffMinutes > toleranceMinutes) {
                continue;
            }

            const snippet = fullMsg.data.snippet || '';
            const bodyData = fullMsg.data.payload.body && fullMsg.data.payload.body.data ? Buffer.from(fullMsg.data.payload.body.data, 'base64').toString() : '';
            const body = snippet + ' ' + bodyData;

            const subjectHeader = fullMsg.data.payload.headers.find(h => h.name.toLowerCase() === 'subject');
            const subject = subjectHeader ? subjectHeader.value : 'Sin asunto';

            if (isBancolombia) {
                const isTransfer = /transferencia/i.test(body) || /recibida/i.test(body) || /abono/i.test(body) || /transferencia/i.test(subject);
                if (!isTransfer) continue;

                const amountRegex = /(?:por valor de|por|monto|valor)\s*(?:\$)?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)/i;
                const amountMatches = body.match(amountRegex);

                if (amountMatches) {
                    const rawValue = amountMatches[1];
                    const cleanValue = parseInt(rawValue.replace(/\./g, '').split(',')[0]);

                    if (cleanValue === targetAmount) {
                        console.log(`[GMAIL MATCH BANCOLOMBIA] ✅ ¡MATCH ENCONTRADO! ID: ${msg.id}`);
                        saveProcessedEmail(msg.id);
                        return {
                            id: msg.id,
                            amount: cleanValue,
                            date: internalDate,
                            diffMinutes: Math.round(diffMinutes),
                            subject: subject,
                            bank: "Bancolombia"
                        };
                    }
                }
            } else {
                const isApproved = /Estado:\s*(?:Aprobada|Exitosa)/i.test(body) || /Venta exitosa/i.test(body);
                if (!isApproved) continue;

                const amountRegex = /Monto:\s*(?:\$)?\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})?)/i;
                const amountMatches = body.match(amountRegex);

                if (amountMatches) {
                    const rawValue = amountMatches[1];
                    const cleanValue = parseInt(rawValue.replace(/\./g, '').split(',')[0]);

                    if (cleanValue === targetAmount) {
                        console.log(`[GMAIL MATCH BRE-B] ✅ ¡MATCH ENCONTRADO! ID: ${msg.id}`);
                        saveProcessedEmail(msg.id);
                        return {
                            id: msg.id,
                            amount: cleanValue,
                            date: internalDate,
                            diffMinutes: Math.round(diffMinutes),
                            subject: subject,
                            bank: "Bre-B"
                        };
                    }
                }
            }
        }
    } catch (e) {
        console.error(`Error en findMatchingPaymentInAccount para ${email}:`, e.message);
    }
    return null;
}

/**
 * Busca un pago específico por monto en los correos recientes de Gmail (Bre-B y Bancolombia).
 * @param {number} targetAmount 
 * @param {number} toleranceMinutes 
 * @returns {Promise<Object|null>}
 */
async function findMatchingPayment(targetAmount, toleranceMinutes = 30) {
    console.log(`[GMAIL MATCH] Buscando pago de $${targetAmount} en los últimos ${toleranceMinutes} min...`);
    
    // 1. Buscar en Jordi (Bre-B)
    const matchJordi = await findMatchingPaymentInAccount(
        PAYMENT_EMAIL,
        'subject:"Detalle de tu venta por Bre-B" newer_than:1d',
        targetAmount,
        toleranceMinutes,
        false
    );
    if (matchJordi) return matchJordi;

    // 2. Buscar en Esteban (Bancolombia)
    const matchEsteban = await findMatchingPaymentInAccount(
        'estebanavila6324@gmail.com',
        'subject:("Transferencia recibida" OR "Le informamos" OR "Bancolombia te informa") newer_than:1d',
        targetAmount,
        toleranceMinutes,
        true
    );
    if (matchEsteban) return matchEsteban;

    return null;
}

/**
 * Busca códigos de verificación (OTP) o inicios de sesión en los últimos minutos en una cuenta específica.
 * @param {string} email El correo donde buscar.
 * @param {number} toleranceMinutes Tiempo máximo hacia atrás.
 */
async function findRecentCodes(email, toleranceMinutes = 10) {
    if (!email) {
        console.error("[GMAIL CODES] ❌ No se proporcionó un email para buscar códigos.");
        return [];
    }
    console.log(`[GMAIL CODES] Buscando códigos en ${email} (últimos ${toleranceMinutes} min)...`);
    const auth = await getOAuth2Client('gmail', null, email);
    if (!auth) return [];

    const gmail = google.gmail({ version: 'v1', auth });
    
    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'subject:(código OR code OR inició OR inicio OR login OR otp OR verification OR hogar OR link OR actualiza)',
            maxResults: 5
        });

        const messages = res.data.messages || [];
        const now = Date.now();
        const codesFound = [];

        for (const msg of messages) {
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            const internalDate = parseInt(fullMsg.data.internalDate);
            const diffMinutes = (now - internalDate) / (1000 * 60);

            if (diffMinutes > toleranceMinutes) continue;

            const snippet = fullMsg.data.snippet || '';
            const bodyData = fullMsg.data.payload.body && fullMsg.data.payload.body.data 
                ? Buffer.from(fullMsg.data.payload.body.data, 'base64').toString() 
                : (fullMsg.data.payload.parts ? fullMsg.data.payload.parts.map(p => p.body.data ? Buffer.from(p.body.data, 'base64').toString() : '').join(' ') : '');
            
            const body = snippet + ' ' + bodyData;
            const subject = fullMsg.data.payload.headers.find(h => h.name === 'Subject')?.value || 'Sin asunto';
            
            // 1. Limpiar Quoted-Printable (saltos de línea raros y tildes como =C3=B3) y eliminar bloques <style> enteros
            const unquotedBody = body.replace(/=\r?\n/g, '').replace(/=C3=B3/g, 'ó').replace(/=C3=AD/g, 'í').replace(/=C3=A1/g, 'á').replace(/=C3=A9/g, 'é').replace(/=C3=BA/g, 'ú');
            const noStyleBody = unquotedBody.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
            
            // 2. Limpiar etiquetas HTML y colores hexadecimales basura residuales
            const cleanBody = noStyleBody.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');
            const superCleanBody = cleanBody.replace(/\b(?:F9F9F9|FFFFFF|000000|E5E5E5|CCCCCC|DEDEDE)\b/gi, ' ');
            
            let code = null;
            // Buscar la palabra "código" o "pin" y capturar el primer número de 4-8 dígitos o alfanumérico que aparezca cerca (hasta 250 caracteres de distancia).
            // Usamos [\s\S] para incluir cualquier salto de línea residual.
            const specificCodeMatch = superCleanBody.match(/(?:c[oó]digo|pin|code)[\s\S]{0,250}?\b([0-9]{4,8}|[A-Z0-9]{6,8})\b/i);
            
            if (specificCodeMatch && /[0-9]/.test(specificCodeMatch[1])) {
                code = specificCodeMatch[1].toUpperCase();
            } else {
                // Fallback 1: Buscar explícitamente 6 dígitos (típico en Disney+ y Netflix)
                const sixDigitMatch = superCleanBody.match(/\b([0-9]{6})\b/);
                if (sixDigitMatch) {
                    code = sixDigitMatch[1];
                } else {
                    // Fallback 2: Código alfanumérico mixto (Max)
                    const alphaNumMatch = superCleanBody.match(/\b([A-Z0-9]{6,8})\b/i);
                    if (alphaNumMatch && /[A-Z]/i.test(alphaNumMatch[1]) && /[0-9]/.test(alphaNumMatch[1])) {
                        code = alphaNumMatch[1].toUpperCase();
                    } else {
                        // Fallback 3: Cualquier número de 4 a 8 dígitos suelto
                        const fallbackMatch = superCleanBody.match(/\b\d{4,8}\b/) || snippet.match(/\b\d{4,8}\b/);
                        code = fallbackMatch ? fallbackMatch[0] : null;
                    }
                }
            }

            // Intentar extraer links importantes de plataformas (Netflix, Disney+, Max, Star+, etc) o botones de acceso
            const linkMatch = body.match(/https:\/\/(?:www\.)?(?:netflix\.com|disneyplus\.com|starplus\.com|max\.com|hbomax\.com|primevideo\.com|amazon\.com|auth\.max\.com)[^\s<>"']+/i);
            const link = linkMatch ? linkMatch[0] : null;

            codesFound.push({
                subject,
                snippet: snippet.substring(0, 150),
                code,
                link,
                time: Math.round(diffMinutes)
            });
        }
        return codesFound;
    } catch (error) {
        console.error('❌ Error en findRecentCodes:', error.message);
        return [];
    }
}

async function getEmailsFromInbox(email, maxResults = 15) {
    const auth = await getOAuth2Client('gmail', null, email);
    if (!auth) throw new Error(`No se pudo obtener la autorización OAuth para ${email}`);

    const gmail = google.gmail({ version: 'v1', auth });

    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            maxResults: maxResults
        });

        const messages = res.data.messages || [];
        const emailsList = [];

        for (const msg of messages) {
            const fullMsg = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id
            });

            const headers = fullMsg.data.payload.headers;
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
            const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

            const subject = subjectHeader ? subjectHeader.value : 'Sin Asunto';
            const from = fromHeader ? fromHeader.value : 'Desconocido';
            const dateStr = dateHeader ? dateHeader.value : '';
            const internalDate = fullMsg.data.internalDate;
            const snippet = fullMsg.data.snippet || '';

            emailsList.push({
                id: msg.id,
                subject,
                from,
                date: dateStr,
                internalDate,
                snippet
            });
        }

        return emailsList;
    } catch (e) {
        console.error(`Error en getEmailsFromInbox para ${email}:`, e.message);
        throw e;
    }
}

module.exports = {
    checkNewPayments,
    findMatchingPayment,
    findRecentCodes,
    getEmailsFromInbox
};
