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
 * Decodifica una cadena con codificación Quoted-Printable.
 */
function decodeQuotedPrintable(str) {
    if (!str) return '';
    // 1. Eliminar saltos de línea suaves (soft line breaks: '=' seguido de salto de línea)
    let decoded = str.replace(/=\r?\n/g, '').replace(/=\n/g, '');
    
    // 2. Mapeos comunes de caracteres utf-8 codificados en QP para evitar fallas
    decoded = decoded
        .replace(/=C3=B3/gi, 'ó')
        .replace(/=C3=AD/gi, 'í')
        .replace(/=C3=A1/gi, 'á')
        .replace(/=C3=A9/gi, 'é')
        .replace(/=C3=BA/gi, 'ú')
        .replace(/=C3=B1/gi, 'ñ')
        .replace(/=C3=93/gi, 'Ó')
        .replace(/=C3=8D/gi, 'Í')
        .replace(/=C3=81/gi, 'Á')
        .replace(/=C3=89/gi, 'É')
        .replace(/=C3=9A/gi, 'Ú')
        .replace(/=C3=91/gi, 'Ñ');

    // 3. Decodificar secuencias =XX convirtiéndolas a %XX para decodeURIComponent (UTF-8)
    try {
        let pctEncoded = decoded.replace(/%/g, '%25').replace(/=([0-9A-F]{2})/gi, '%$1');
        return decodeURIComponent(pctEncoded);
    } catch (e) {
        // Fallback en caso de que falle decodeURIComponent (mapeo directo byte a char)
        return decoded.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
        });
    }
}

/**
 * Valiza si un código extraído es un código de verificación real.
 * Evita emparejar años (como 2026) o partes de fechas.
 */
function isValidVerificationCode(code, fullText) {
    if (!code) return false;
    // Excluir años típicos (como 2024-2035)
    if (/^(202\d|203\d)$/.test(code)) {
        return false;
    }
    // Si el código está en formato de fecha en el texto (ej. 2026-06-16 o 16-06-2026)
    const datePattern = new RegExp(`(?:\\d{1,4}[-\\/\\s]\\d{1,2}[-\\/\\s]${code})|(?:${code}[-\\/\\s]\\d{1,2}[-\\/\\s]\\d{1,4})`, 'i');
    if (datePattern.test(fullText)) {
        return false;
    }
    return true;
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
            q: 'subject:(código OR code OR inició OR inicio OR iniciar OR sesion OR sesión OR login OR otp OR verification OR hogar OR link OR actualiza OR claude OR anthropic OR "iniciar su sesión" OR "vamos a iniciar")',
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
            const parts = getMessageParts(fullMsg.data.payload);
            const decodedText = decodeQuotedPrintable(parts.text || parts.html || "");
            const decodedHtml = decodeQuotedPrintable(parts.html || "");
            const decodedSnippet = decodeQuotedPrintable(snippet);

            const subject = fullMsg.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'Sin asunto';
            const decodedSubject = decodeQuotedPrintable(subject);

            // Eliminar URLs completas para evitar extraer números/IDs dentro de enlaces (como el 000000 de Disney+)
            const textToSearchForCode = decodedSnippet + ' ' + decodedText;
            const bodyWithoutUrls = textToSearchForCode.replace(/https?:\/\/[^\s<>"`']+/gi, ' ');

            // Eliminar bloques <style> enteros
            const noStyleBody = bodyWithoutUrls.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

            // Limpiar etiquetas HTML y colores hexadecimales basura residuales
            const cleanBody = noStyleBody.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');
            const superCleanBody = cleanBody.replace(/\b(?:F9F9F9|FFFFFF|000000|E5E5E5|CCCCCC|DEDEDE)\b/gi, ' ');

            let code = null;
            // Buscar la palabra "código" o "pin" y capturar el primer número de 4-8 dígitos o alfanumérico que aparezca cerca (hasta 250 caracteres de distancia).
            // Usamos [\s\S] para incluir cualquier salto de línea residual.
            const specificCodeMatch = superCleanBody.match(/(?:c[oó]digo|pin|code)[\s\S]{0,250}?\b([0-9]{4,8}|[A-Z0-9]{6,8})\b/i);

            if (specificCodeMatch && /[0-9]/.test(specificCodeMatch[1])) {
                const tempCode = specificCodeMatch[1].toUpperCase();
                if (isValidVerificationCode(tempCode, decodedSubject + ' ' + superCleanBody)) {
                    code = tempCode;
                }
            }

            if (!code) {
                // Fallback 1: Buscar explícitamente 6 dígitos o formato con guion 3-3 (típico en Amazon/Disney+/Netflix)
                const hyphenMatch = superCleanBody.match(/\b([0-9]{3})-([0-9]{3})\b/);
                const sixDigitMatch = superCleanBody.match(/\b([0-9]{6})\b/);
                if (hyphenMatch) {
                    const tempCode = hyphenMatch[1] + hyphenMatch[2];
                    if (isValidVerificationCode(tempCode, decodedSubject + ' ' + superCleanBody)) {
                        code = tempCode;
                    }
                } else if (sixDigitMatch) {
                    const tempCode = sixDigitMatch[1];
                    if (isValidVerificationCode(tempCode, decodedSubject + ' ' + superCleanBody)) {
                        code = tempCode;
                    }
                }
            }

            if (!code) {
                // Fallback 2: Código alfanumérico mixto (Max)
                const alphaNumMatch = superCleanBody.match(/\b([A-Z0-9]{6,8})\b/i);
                if (alphaNumMatch && /[A-Z]/i.test(alphaNumMatch[1]) && /[0-9]/.test(alphaNumMatch[1])) {
                    const tempCode = alphaNumMatch[1].toUpperCase();
                    if (isValidVerificationCode(tempCode, decodedSubject + ' ' + superCleanBody)) {
                        code = tempCode;
                    }
                }
            }

            if (!code) {
                // Fallback 3: Cualquier número de 4 a 8 dígitos suelto
                const fallbackMatch = superCleanBody.match(/\b\d{4,8}\b/) || decodedSnippet.match(/\b\d{4,8}\b/);
                if (fallbackMatch) {
                    const tempCode = fallbackMatch[0];
                    if (isValidVerificationCode(tempCode, decodedSubject + ' ' + superCleanBody)) {
                        code = tempCode;
                    }
                }
            }

            // Extraer el mejor enlace (sin logos ni imágenes de Claude/Streaming)
            const link = extractBestLink(decodedHtml || decodedText);

            codesFound.push({
                subject: decodedSubject,
                snippet: decodedSnippet.substring(0, 150),
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

function getMessageParts(payload) {
    let text = "";
    let html = "";
    if (!payload) return { text, html };

    if (payload.body && payload.body.data) {
        const decoded = Buffer.from(payload.body.data, 'base64').toString('utf8');
        if (payload.mimeType === 'text/html') {
            html = decoded;
        } else {
            text = decoded;
        }
    }

    if (payload.parts && payload.parts.length > 0) {
        for (const part of payload.parts) {
            const partResult = getMessageParts(part);
            text += partResult.text;
            html += partResult.html;
        }
    }

    return { text, html };
}

function getMessageBody(payload) {
    const parts = getMessageParts(payload);
    return parts.text || parts.html || "";
}

function extractBestLink(bodyText) {
    if (!bodyText) return null;
    const regex = /https?:\/\/(?:www\.)?(?:[a-zA-Z0-9-]+\.)*(?:netflix\.com|disneyplus\.com|starplus\.com|max\.com|hbomax\.com|primevideo\.com|amazon\.com|auth\.max\.com|claude\.ai|anthropic\.com|mail\.anthropic\.com|crunchyroll\.com|paramountplus\.com|vix\.com|spotify\.com|canva\.com|plex\.tv)[^\s<>"']+/gi;
    const matches = bodyText.match(regex);
    if (!matches) return null;

    // Filter out images, logos, static assets
    const filteredMatches = matches.filter(url => {
        const lower = url.toLowerCase();
        if (/\.(png|jpg|jpeg|gif|svg|webp|ico)(?:\?|$)/.test(lower)) return false;
        if (lower.includes('/images/') || lower.includes('/logos/') || lower.includes('/assets/')) return false;
        return true;
    });

    if (filteredMatches.length === 0) {
        return matches[0];
    }

    // Prioritize links containing keywords like magic-link, click, login, signin, verify, etc.
    const priorityMatch = filteredMatches.find(url => {
        const lower = url.toLowerCase();
        return lower.includes('magic-link') || lower.includes('click') || lower.includes('login') || lower.includes('signin') || lower.includes('verify') || lower.includes('code');
    });

    return priorityMatch || filteredMatches[0];
}

function cleanHtml(html) {
    if (!html) return "";
    let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<\/tr>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, url, linkText) => {
        const cleanLinkText = linkText.replace(/<[^>]+>/g, '').trim();
        // Solo mostrar la URL si es un link real (http) y diferente al texto
        if (/^https?:\/\//i.test(url) && cleanLinkText.toLowerCase() !== url.toLowerCase()) {
            return `${cleanLinkText} (${url})`;
        }
        return cleanLinkText || url;
    });
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&iquest;/g, '¿')
        .replace(/&#[0-9]+;/g, '');
    text = text.replace(/\n\s*\n+/g, '\n\n');
    return text.trim();
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

            const parts = getMessageParts(fullMsg.data.payload);
            const decodedText = decodeQuotedPrintable(parts.text);
            const decodedHtml = decodeQuotedPrintable(parts.html);

            const isHtml = !!decodedHtml;
            const cleanBody = isHtml ? cleanHtml(decodedHtml) : decodedText;

            // rawHtml: HTML decodificado para renderizar en iframe (se añade meta charset para evitar garbled chars)
            const rawHtml = isHtml
                ? `<meta charset="utf-8"><base target="_blank">${decodedHtml}`
                : `<meta charset="utf-8"><pre style="font-family:sans-serif;white-space:pre-wrap;word-break:break-word;padding:16px;">${cleanBody}</pre>`;

            // Intentar extraer de forma anticipada el link y código
            const textToSearchForCode = decodeQuotedPrintable(snippet) + ' ' + (isHtml ? cleanBody : decodedText);
            const bodyWithoutUrls = textToSearchForCode.replace(/https?:\/\/[^\s<>"`']+/gi, ' ');
            const noStyleBody = bodyWithoutUrls.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
            const cleanBodyForCode = noStyleBody.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');
            const superCleanBody = cleanBodyForCode.replace(/\b(?:F9F9F9|FFFFFF|000000|E5E5E5|CCCCCC|DEDEDE)\b/gi, ' ');

            let code = null;
            const specificCodeMatch = superCleanBody.match(/(?:c[oó]digo|pin|code)[\s\S]{0,250}?\b([0-9]{4,8}|[A-Z0-9]{6,8})\b/i);
            if (specificCodeMatch && /[0-9]/.test(specificCodeMatch[1])) {
                code = specificCodeMatch[1].toUpperCase();
            }
            if (!code) {
                const sixDigitMatch = superCleanBody.match(/\b([0-9]{6})\b/);
                if (sixDigitMatch) code = sixDigitMatch[1];
            }

            const link = extractBestLink(decodedHtml || decodedText);

            emailsList.push({
                id: msg.id,
                subject: decodeQuotedPrintable(subject),
                from: decodeQuotedPrintable(from),
                date: dateStr,
                internalDate,
                snippet: decodeQuotedPrintable(snippet),
                body: cleanBody || decodeQuotedPrintable(snippet),
                rawHtml,
                code,
                link
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

