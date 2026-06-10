const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { pool } = require('./database');

async function saveMessage(message, botIntent = null) {
    const messageId = message.id ? message.id._serialized : null;
    const chatId = message.from;
    const senderId = message.author || message.from;
    const isFromMe = message.fromMe ? 1 : 0;
    const body = message.body || "";
    
    let mediaPath = null;
    let mediaMime = null;
    let senderName = null;

    try {
        const contact = await message.getContact();
        senderName = contact ? (contact.name || contact.pushname || null) : null;
    } catch (e) {
        console.error("[Message Logger] Error getting contact name:", e.message);
    }

    if (message.hasMedia) {
        try {
            const media = await message.downloadMedia();
            if (media && media.data && media.mimetype) {
                mediaMime = media.mimetype.split(';')[0];
                const buffer = Buffer.from(media.data, 'base64');
                const fileExt = mediaMime.split('/')[1] || 'bin';
                const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
                const destFolder = path.join(__dirname, 'uploads', 'media');
                
                if (!fs.existsSync(destFolder)) {
                    fs.mkdirSync(destFolder, { recursive: true });
                }
                
                const finalPath = path.join(destFolder, fileName);

                // Si es una imagen y es de tipo comprimible
                if (mediaMime.startsWith('image/') && !mediaMime.includes('gif') && !mediaMime.includes('svg')) {
                    try {
                        await sharp(buffer)
                            .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                            .jpeg({ quality: 80 })
                            .toFile(finalPath);
                        mediaPath = `uploads/media/${fileName}`;
                        console.log(`[Message Logger] Imagen comprimida guardada en: ${finalPath}`);
                    } catch (sharpErr) {
                        console.error("[Message Logger] Error al comprimir con sharp, guardando raw:", sharpErr.message);
                        fs.writeFileSync(finalPath, buffer);
                        mediaPath = `uploads/media/${fileName}`;
                    }
                } else {
                    // Guardar otros archivos (videos, pdfs, gifs, etc.) tal cual
                    fs.writeFileSync(finalPath, buffer);
                    mediaPath = `uploads/media/${fileName}`;
                    console.log(`[Message Logger] Archivo guardado en: ${finalPath}`);
                }
            }
        } catch (mediaErr) {
            console.error("[Message Logger] Error downloading or saving media:", mediaErr.message);
        }
    }

    try {
        await pool.query(
            `INSERT INTO messages (message_id, chat_id, sender_id, sender_name, body, media_path, media_mime, is_from_me, bot_intent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE body = VALUES(body), media_path = VALUES(media_path), bot_intent = VALUES(bot_intent)`,
            [messageId, chatId, senderId, senderName, body, mediaPath, mediaMime, isFromMe, botIntent]
        );
        console.log(`[Message Logger] Mensaje ${messageId || ''} guardado en BD.`);
    } catch (dbErr) {
        console.error("[Message Logger] Error inserting message into DB:", dbErr.message);
    }
}

module.exports = {
    saveMessage
};
