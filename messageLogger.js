const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { pool } = require('./database');

async function saveMessage(message, botIntent = null) {
    const messageId = message.id ? message.id._serialized : null;
    const chatId = message.fromMe ? message.to : message.from;
    const senderId = message.fromMe ? (message.from || 'me') : (message.author || message.from);
    const isFromMe = message.fromMe ? 1 : 0;
    const body = message.body || "";
    
    let mediaPath = null;
    let mediaMime = null;
    let senderName = null;

    try {
        if (message.id && typeof message.getContact === 'function') {
            const contact = await message.getContact();
            senderName = contact ? (contact.name || contact.pushname || null) : null;
        }
    } catch (e) {
        console.log("[Message Logger] Info: No se pudo obtener el nombre de contacto:", e.message);
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
        // Ensure customer and chat exist to avoid foreign key errors
        if (chatId && chatId.endsWith('@c.us')) {
            const customerPhone = chatId.replace('@c.us', '');
            const contactName = senderName || customerPhone;
            await pool.query(
                `INSERT IGNORE INTO customers (phone, fullname) VALUES (?, ?)`,
                [customerPhone, contactName]
            );
            
            await pool.query(
                `INSERT INTO chats (chat_id, customer_phone, status, last_message_text, last_message_time)
                 VALUES (?, ?, 'bot', ?, NOW())
                 ON DUPLICATE KEY UPDATE last_message_text = VALUES(last_message_text), last_message_time = NOW()`,
                [chatId, customerPhone, body.substring(0, 500)]
            );
        } else if (chatId) {
            await pool.query(
                `INSERT INTO chats (chat_id, status, last_message_text, last_message_time)
                 VALUES (?, 'bot', ?, NOW())
                 ON DUPLICATE KEY UPDATE last_message_text = VALUES(last_message_text), last_message_time = NOW()`,
                [chatId, body.substring(0, 500)]
            );
        }

        const columns = await getMessagesTableColumns();
        
        let queryFields = ['message_id', 'chat_id', 'sender_id', 'sender_name', 'body', 'media_path', 'media_mime', 'bot_intent'];
        let queryValues = [messageId, chatId, senderId, senderName, body, mediaPath, mediaMime, botIntent];
        
        if (columns.includes('direction')) {
            queryFields.push('direction');
            queryValues.push(isFromMe ? 'outbound' : 'inbound');
        } else if (columns.includes('is_from_me')) {
            queryFields.push('is_from_me');
            queryValues.push(isFromMe);
        } else if (columns.includes('isFromMe')) {
            queryFields.push('isFromMe');
            queryValues.push(isFromMe);
        }

        const placeholders = queryFields.map(() => '?').join(', ');
        const fieldsStr = queryFields.join(', ');
        
        await pool.query(
            `INSERT INTO messages (${fieldsStr})
             VALUES (${placeholders})
             ON DUPLICATE KEY UPDATE body = VALUES(body), media_path = VALUES(media_path), bot_intent = VALUES(bot_intent)`,
            queryValues
        );
        console.log(`[Message Logger] Mensaje ${messageId || ''} guardado en BD.`);
    } catch (dbErr) {
        console.error("[Message Logger] Error inserting message into DB:", dbErr.message);
    }
}

let messagesTableColumns = null;

async function getMessagesTableColumns() {
    if (messagesTableColumns) return messagesTableColumns;
    try {
        const [rows] = await pool.query("DESCRIBE messages");
        messagesTableColumns = rows.map(r => r.Field);
    } catch (e) {
        console.warn("[Message Logger] Error describing table, falling back to defaults:", e.message);
        messagesTableColumns = ['message_id', 'chat_id', 'sender_id', 'sender_name', 'body', 'media_path', 'media_mime', 'direction', 'bot_intent'];
    }
    return messagesTableColumns;
}

module.exports = {
    saveMessage
};
