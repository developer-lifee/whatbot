const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

const SCHEDULED_FILE = path.join(__dirname, 'scheduled_messages.json');
const activeJobs = new Map();

/**
 * Carga los mensajes programados desde el archivo JSON.
 */
function loadScheduledMessages() {
    if (!fs.existsSync(SCHEDULED_FILE)) {
        return [];
    }
    try {
        const data = fs.readFileSync(SCHEDULED_FILE, 'utf8');
        return JSON.parse(data || '[]');
    } catch (e) {
        console.error('❌ Error leyendo scheduled_messages.json:', e.message);
        return [];
    }
}

/**
 * Guarda los mensajes programados en el archivo JSON.
 */
function saveScheduledMessages(messages) {
    try {
        fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(messages, null, 2));
    } catch (e) {
        console.error('❌ Error guardando scheduled_messages.json:', e.message);
    }
}

/**
 * Parsea descripciones de tiempo en español y calcula la fecha correspondiente.
 * Soporta formatos como:
 * - "8 am", "8:30 pm", "14:15" (hoy, o mañana si ya pasó la hora)
 * - "en 10 minutos", "en 5 mins"
 * - "en 2 horas", "en 1 hora"
 * - "mañana a las 10 am", "mañana" (misma hora)
 */
function parseScheduledTime(timeStr) {
    const now = new Date();
    let targetDate = new Date(now);
    const cleanStr = timeStr.toLowerCase().trim();

    // 1. "en X minutos" / "en X mins"
    const inMinsMatch = cleanStr.match(/en\s+(\d+)\s*(?:minuto|minutos|min|mins)/);
    if (inMinsMatch) {
        const mins = parseInt(inMinsMatch[1]);
        targetDate.setMinutes(targetDate.getMinutes() + mins);
        return targetDate;
    }

    // 2. "en X horas" / "en X hs"
    const inHoursMatch = cleanStr.match(/en\s+(\d+)\s*(?:hora|horas|hr|hrs|h|hs)/);
    if (inHoursMatch) {
        const hours = parseInt(inHoursMatch[1]);
        targetDate.setHours(targetDate.getHours() + hours);
        return targetDate;
    }

    // 3. "mañana" (por defecto, mismo día + 1)
    let isTomorrow = false;
    if (cleanStr.includes('mañana')) {
        isTomorrow = true;
        targetDate.setDate(targetDate.getDate() + 1);
    }

    // 4. Buscar horas específicas como "8:30 am", "8 am", "15:00", "3 pm", etc.
    const timeMatch = cleanStr.match(/(?:a las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const ampm = timeMatch[3];

        if (ampm) {
            if (ampm === 'pm' && hours < 12) hours += 12;
            if (ampm === 'am' && hours === 12) hours = 0;
        } else if (hours < 7 && !isTomorrow) {
            // Si es menor a 7 y no dice am/pm, asumimos pm (ej: "a las 3" -> 3 PM)
            hours += 12;
        }

        targetDate.setHours(hours, minutes, 0, 0);

        // Si la hora ya pasó hoy y no se especificó "mañana", mover a mañana
        if (targetDate < now && !isTomorrow) {
            targetDate.setDate(targetDate.getDate() + 1);
        }
        return targetDate;
    }

    // Fallback: Si no coincide con nada, retornar null
    return null;
}

/**
 * Inicializa y programa todos los mensajes pendientes al arrancar el servidor.
 */
function initScheduledMessages(client) {
    console.log('⏰ [SCHEDULED MSGS] Inicializando gestor de mensajes programados...');
    const messages = loadScheduledMessages();
    const now = new Date();
    let scheduledCount = 0;
    let missedCount = 0;

    messages.forEach(msg => {
        if (msg.sent) return;

        const targetDate = new Date(msg.scheduledTime);

        if (targetDate <= now) {
            // Si el mensaje debió enviarse mientras el bot estaba apagado
            // Solo lo enviamos si la diferencia es menor a 2 horas (para evitar spam retrasado)
            const diffMs = now - targetDate;
            const diffHours = diffMs / (1000 * 60 * 60);

            if (diffHours < 2) {
                console.log(`[SCHEDULED MSGS] Enviando mensaje pendiente retrasado a ${msg.chatId}...`);
                client.sendMessage(msg.chatId, msg.message)
                    .then(() => {
                        msg.sent = true;
                        msg.sentAt = new Date().toISOString();
                        saveScheduledMessages(messages);
                    })
                    .catch(err => console.error(`Error enviando mensaje retrasado a ${msg.chatId}:`, err.message));
            } else {
                console.log(`[SCHEDULED MSGS] Mensaje expirado (más de 2 hs de retraso) para ${msg.chatId}. Marcado como expirado.`);
                msg.sent = true;
                msg.expired = true;
                saveScheduledMessages(messages);
                missedCount++;
            }
        } else {
            // Programar tarea activa
            scheduleJob(client, msg);
            scheduledCount++;
        }
    });

    console.log(`✅ [SCHEDULED MSGS] Carga completa. Mensajes programados activos: ${scheduledCount}. Expirados omitidos: ${missedCount}`);
}

/**
 * Programa una tarea de node-schedule para un mensaje.
 */
function scheduleJob(client, msg) {
    if (activeJobs.has(msg.id)) {
        activeJobs.get(msg.id).cancel();
    }

    const targetDate = new Date(msg.scheduledTime);
    
    const job = schedule.scheduleJob(targetDate, async () => {
        console.log(`🚀 [SCHEDULED MSGS] Ejecutando envío programado para ${msg.chatId}...`);
        try {
            await client.sendMessage(msg.chatId, msg.message);
            
            // Marcar como enviado en la persistencia
            const messages = loadScheduledMessages();
            const index = messages.findIndex(m => m.id === msg.id);
            if (index !== -1) {
                messages[index].sent = true;
                messages[index].sentAt = new Date().toISOString();
                saveScheduledMessages(messages);
            }
            activeJobs.delete(msg.id);
            console.log(`✅ [SCHEDULED MSGS] Mensaje programado enviado con éxito a ${msg.chatId}`);
        } catch (err) {
            console.error(`❌ [SCHEDULED MSGS] Error al enviar mensaje programado a ${msg.chatId}:`, err.message);
        }
    });

    activeJobs.set(msg.id, job);
}

/**
 * Crea y registra un nuevo mensaje programado.
 */
async function scheduleNewMessage(client, chatId, messageText, timeStr) {
    const targetDate = parseScheduledTime(timeStr);
    
    if (!targetDate) {
        throw new Error(`No pude interpretar el tiempo "${timeStr}". Ejemplos válidos: "8 am", "mañana a las 10:30", "en 15 minutos".`);
    }

    const now = new Date();
    if (targetDate <= now) {
        throw new Error('La hora especificada ya pasó. Por favor indica una hora futura.');
    }

    const messages = loadScheduledMessages();
    const newMsg = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        chatId: chatId,
        message: messageText,
        scheduledTime: targetDate.toISOString(),
        timeDescription: timeStr,
        sent: false,
        createdAt: now.toISOString()
    };

    messages.push(newMsg);
    saveScheduledMessages(messages);
    scheduleJob(client, newMsg);

    return {
        success: true,
        scheduledDate: targetDate,
        formattedTime: targetDate.toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
        message: newMsg
    };
}

module.exports = {
    initScheduledMessages,
    scheduleNewMessage,
    parseScheduledTime
};
