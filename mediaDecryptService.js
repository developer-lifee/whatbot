const crypto = require('crypto');

/**
 * Descifra directamente archivos multimedia de WhatsApp (imágenes, audios, videos, documentos)
 * descargando el archivo cifrado desde el CDN de WhatsApp (mmg.whatsapp.net) y descifrándolo
 * con HKDF-SHA256 y AES-256-CBC de forma 100% nativa en Node.js.
 * 
 * Esto bypassa por completo los errores del navegador (como el error 't' o 'r: r' de whatsapp-web.js)
 * y funciona instantáneamente para comprobantes de pago y capturas de error.
 * 
 * @param {object} message - Instancia de Message de whatsapp-web.js
 * @returns {Promise<{data: string, mimetype: string, filename: string, filesize: number}|null>}
 */
async function downloadMediaDirect(message) {
    if (!message) return null;

    const raw = message._data || {};
    const mediaData = raw.mediaData || message.mediaData || {};

    let directPath = raw.directPath || mediaData.directPath || message.directPath;
    let mediaKey = raw.mediaKey || mediaData.mediaKey || message.mediaKey;
    let type = raw.type || mediaData.type || message.type || 'image';
    let mimetype = raw.mimetype || mediaData.mimetype || message.mimetype;
    let filename = raw.filename || mediaData.filename || message.filename;

    // Si aún no tenemos directPath o mediaKey (común en mensajes salientes o chats @lid),
    // intentar extraerlos rápidamente desde el modelo en memoria de WhatsApp Web (Store.Msg)
    if ((!directPath || !mediaKey) && message.client && message.client.pupPage) {
        try {
            const rawMsgId = message.id ? (message.id._serialized || message.id.id || message.id) : null;
            if (rawMsgId) {
                const storeData = await message.client.pupPage.evaluate((serializedId) => {
                    try {
                        const msg = (window.Store && window.Store.Msg && window.Store.Msg.get) 
                            ? window.Store.Msg.get(serializedId) 
                            : null;
                        if (!msg) return null;
                        const mData = msg.mediaData || {};
                        let mk = msg.mediaKey || mData.mediaKey;
                        if (mk && typeof mk !== 'string') {
                            if (mk instanceof Uint8Array || Array.isArray(mk)) {
                                mk = Array.from(mk);
                            }
                        }
                        return {
                            directPath: msg.directPath || mData.directPath,
                            mediaKey: mk,
                            type: msg.type || mData.type,
                            mimetype: msg.mimetype || mData.mimetype,
                            filename: msg.filename || mData.filename
                        };
                    } catch (e) {
                        return null;
                    }
                }, rawMsgId);

                if (storeData) {
                    directPath = directPath || storeData.directPath;
                    mediaKey = mediaKey || storeData.mediaKey;
                    type = type || storeData.type;
                    mimetype = mimetype || storeData.mimetype;
                    filename = filename || storeData.filename;
                }
            }
        } catch (evalErr) {
            // Ignorar fallo de evaluación en Puppeteer
        }
    }

    if (!directPath || !mediaKey) {
        return null;
    }

    const resolvedType = type || 'image';
    let infoStr = 'WhatsApp Image Keys';
    if (resolvedType === 'video') infoStr = 'WhatsApp Video Keys';
    else if (resolvedType === 'audio' || resolvedType === 'ptt') infoStr = 'WhatsApp Audio Keys';
    else if (resolvedType === 'document') infoStr = 'WhatsApp Document Keys';

    const normalizedPath = directPath.startsWith('/') ? directPath : `/${directPath}`;
    const downloadUrl = `https://mmg.whatsapp.net${normalizedPath}`;

    try {
        const cdnRes = await fetch(downloadUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Origin': 'https://web.whatsapp.com',
                'Referer': 'https://web.whatsapp.com/'
            }
        });

        if (!cdnRes.ok) {
            console.warn(`[mediaDecryptService] Error HTTP ${cdnRes.status} descargando desde CDN de WhatsApp: ${downloadUrl}`);
            return null;
        }

        const encBuffer = Buffer.from(await cdnRes.arrayBuffer());
        if (encBuffer.length <= 10) {
            console.warn('[mediaDecryptService] Buffer cifrado corrupto o demasiado corto.');
            return null;
        }

        let mediaKeyBuf;
        if (Buffer.isBuffer(mediaKey)) {
            mediaKeyBuf = mediaKey;
        } else if (typeof mediaKey === 'string') {
            mediaKeyBuf = Buffer.from(mediaKey, 'base64');
        } else if (Array.isArray(mediaKey) || ArrayBuffer.isView(mediaKey) || mediaKey instanceof Uint8Array) {
            mediaKeyBuf = Buffer.from(mediaKey);
        } else if (typeof mediaKey === 'object' && mediaKey !== null) {
            mediaKeyBuf = Buffer.from(Object.values(mediaKey));
        } else {
            return null;
        }

        const expanded = crypto.hkdfSync('sha256', mediaKeyBuf, Buffer.alloc(0), Buffer.from(infoStr), 112);

        // Los primeros 16 bytes son el IV, los siguientes 32 bytes son la clave AES-256
        const iv = expanded.slice(0, 16);
        const cipherKey = expanded.slice(16, 48);

        // Los últimos 10 bytes son el MAC de autenticación
        const dataToDecrypt = encBuffer.slice(0, -10);
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
        const decrypted = Buffer.concat([decipher.update(dataToDecrypt), decipher.final()]);

        let ext = 'jpg';
        if (mimetype) {
            if (mimetype.includes('png')) ext = 'png';
            else if (mimetype.includes('pdf')) ext = 'pdf';
            else if (mimetype.includes('webp')) ext = 'webp';
            else if (mimetype.includes('mp4')) ext = 'mp4';
            else if (mimetype.includes('ogg')) ext = 'ogg';
            else if (mimetype.includes('mp3')) ext = 'mp3';
        }

        return {
            data: decrypted.toString('base64'),
            mimetype: mimetype || 'image/jpeg',
            filename: filename || `media_${Date.now()}.${ext}`,
            filesize: decrypted.length
        };
    } catch (err) {
        console.warn('[mediaDecryptService] Falló el descifrado nativo de WhatsApp:', err.message);
        return null;
    }
}

module.exports = {
    downloadMediaDirect
};
