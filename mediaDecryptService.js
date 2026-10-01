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

    const raw = message._data;
    if (!raw || !raw.directPath || !raw.mediaKey) {
        return null;
    }

    const type = raw.type || message.type || 'image';
    let infoStr = 'WhatsApp Image Keys';
    if (type === 'video') infoStr = 'WhatsApp Video Keys';
    else if (type === 'audio' || type === 'ptt') infoStr = 'WhatsApp Audio Keys';
    else if (type === 'document') infoStr = 'WhatsApp Document Keys';

    const downloadUrl = `https://mmg.whatsapp.net${raw.directPath}`;

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

        const mediaKeyBuf = Buffer.isBuffer(raw.mediaKey) ? raw.mediaKey : Buffer.from(raw.mediaKey, 'base64');
        const expanded = crypto.hkdfSync('sha256', mediaKeyBuf, Buffer.alloc(0), Buffer.from(infoStr), 112);

        // Los primeros 16 bytes son el IV, los siguientes 32 bytes son la clave AES-256
        const iv = expanded.slice(0, 16);
        const cipherKey = expanded.slice(16, 48);

        // Los últimos 10 bytes son el MAC de autenticación
        const dataToDecrypt = encBuffer.slice(0, -10);
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
        const decrypted = Buffer.concat([decipher.update(dataToDecrypt), decipher.final()]);

        const ext = raw.mimetype?.includes('png') ? 'png' : (raw.mimetype?.includes('pdf') ? 'pdf' : 'jpg');
        return {
            data: decrypted.toString('base64'),
            mimetype: raw.mimetype || 'image/jpeg',
            filename: raw.filename || `media_${Date.now()}.${ext}`,
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
