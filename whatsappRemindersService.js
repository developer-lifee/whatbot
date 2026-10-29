const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

const REMINDERS_FILE = path.join(__dirname, 'whatsapp_reminders.json');
const activeJobs = new Map();

const PREDEFINED_TARGETS = [
    { id: '120363102144405222@g.us', name: '👥 Grupo Sheerit General' },
    { id: '120363427163636523@g.us', name: '⚠️ Grupo Errors Bot' },
    { id: '120363161345379149@g.us', name: '📊 Grupo Cobros y Reportes' }
];

/**
 * Carga los recordatorios desde el archivo JSON.
 */
function loadReminders() {
    if (!fs.existsSync(REMINDERS_FILE)) {
        // Datos iniciales de ejemplo si el archivo no existe
        const defaultReminders = [
            {
                id: 'rem_claude_usage',
                title: 'Revisar uso de Claude',
                target: '120363102144405222@g.us',
                targetLabel: '👥 Grupo Sheerit General',
                message: '🔔 *RECORDATORIO DIARIO:*\nPor favor revisar el consumo y uso de tokens de las cuentas de Claude para verificar disponibilidad y límites.',
                type: 'recurring',
                time: '10:00',
                days: [1, 2, 3, 4, 5, 6, 0], // Todos los días
                daysLabel: 'Todos los días',
                enabled: true,
                createdAt: new Date().toISOString(),
                lastSentAt: null
            }
        ];
        saveReminders(defaultReminders);
        return defaultReminders;
    }
    try {
        const raw = fs.readFileSync(REMINDERS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('❌ Error leyendo whatsapp_reminders.json:', e.message);
        return [];
    }
}

/**
 * Guarda los recordatorios en el archivo JSON.
 */
function saveReminders(reminders) {
    try {
        fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Error guardando whatsapp_reminders.json:', e.message);
    }
}

/**
 * Cancela una tarea activa si existe.
 */
function cancelJob(reminderId) {
    if (activeJobs.has(reminderId)) {
        try {
            activeJobs.get(reminderId).cancel();
        } catch (e) { }
        activeJobs.delete(reminderId);
    }
}

/**
 * Programa una tarea en node-schedule para un recordatorio.
 */
function scheduleReminderJob(reminder, client) {
    cancelJob(reminder.id);

    if (!reminder.enabled) {
        return;
    }

    if (!client) {
        console.warn(`[REMINDERS] Cliente de WhatsApp no disponible para programar "${reminder.title}".`);
        return;
    }

    try {
        if (reminder.type === 'once') {
            // Envío único en fecha y hora específica
            const targetDate = new Date(reminder.datetime);
            const now = new Date();
            if (targetDate <= now) {
                console.log(`[REMINDERS] El recordatorio único "${reminder.title}" ya pasó (${reminder.datetime}).`);
                return;
            }

            const job = schedule.scheduleJob(targetDate, async () => {
                await executeReminderSend(reminder, client);
                // Desactivar tras envío único
                const reminders = loadReminders();
                const idx = reminders.findIndex(r => r.id === reminder.id);
                if (idx !== -1) {
                    reminders[idx].enabled = false;
                    reminders[idx].completed = true;
                    saveReminders(reminders);
                }
                cancelJob(reminder.id);
            });

            if (job) activeJobs.set(reminder.id, job);
            console.log(`⏰ [REMINDERS] Recordatorio único programado: "${reminder.title}" para ${targetDate.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`);
        } else {
            // Recurrente diario o días específicos
            const [hourStr, minStr] = (reminder.time || '10:00').split(':');
            const hour = parseInt(hourStr, 10);
            const minute = parseInt(minStr, 10);

            const rule = new schedule.RecurrenceRule();
            rule.hour = hour;
            rule.minute = minute;
            rule.tz = 'America/Bogota';

            if (Array.isArray(reminder.days) && reminder.days.length > 0 && reminder.days.length < 7) {
                rule.dayOfWeek = reminder.days; // 0-6 (0 = Domingo)
            }

            const job = schedule.scheduleJob(rule, async () => {
                await executeReminderSend(reminder, client);
            });

            if (job) activeJobs.set(reminder.id, job);
            console.log(`⏰ [REMINDERS] Recordatorio recurrente programado: "${reminder.title}" a las ${reminder.time} (${reminder.daysLabel || 'días programados'}) [Bogotá]`);
        }
    } catch (err) {
        console.error(`❌ [REMINDERS] Error programando recordatorio "${reminder.title}":`, err.message);
    }
}

/**
 * Ejecuta el envío real del mensaje por WhatsApp.
 */
async function executeReminderSend(reminder, client) {
    if (!client) {
        console.error(`❌ [REMINDERS] No se pudo enviar "${reminder.title}": Cliente WhatsApp no conectado.`);
        return { success: false, error: 'Cliente WhatsApp no disponible' };
    }

    let targetJid = reminder.target.trim();
    // Limpieza de formato si es teléfono
    if (!targetJid.includes('@')) {
        const cleanDigits = targetJid.replace(/\D/g, '');
        targetJid = `${cleanDigits}@c.us`;
    }

    console.log(`🚀 [REMINDERS] Enviando recordatorio "${reminder.title}" a ${targetJid}...`);
    try {
        const chat = await client.getChatById(targetJid);
        if (chat) {
            await chat.sendMessage(reminder.message);
        } else {
            await client.sendMessage(targetJid, reminder.message);
        }

        // Registrar timestamp de último envío
        const reminders = loadReminders();
        const idx = reminders.findIndex(r => r.id === reminder.id);
        const sentTime = new Date().toISOString();
        if (idx !== -1) {
            reminders[idx].lastSentAt = sentTime;
            saveReminders(reminders);
        }

        console.log(`✅ [REMINDERS] Recordatorio "${reminder.title}" enviado exitosamente a ${targetJid}`);
        return { success: true, sentAt: sentTime };
    } catch (err) {
        console.error(`❌ [REMINDERS] Fallo al enviar recordatorio "${reminder.title}" a ${targetJid}:`, err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Inicializa todos los recordatorios activos al arrancar el bot.
 */
function initReminders(client) {
    console.log('⏰ [REMINDERS] Inicializando motor de recordatorios automáticos...');
    const reminders = loadReminders();
    let scheduled = 0;

    reminders.forEach(rem => {
        if (rem.enabled) {
            scheduleReminderJob(rem, client);
            scheduled++;
        }
    });

    console.log(`✅ [REMINDERS] Carga completada. ${scheduled} recordatorios activos programados.`);
}

/**
 * CRUD y funciones de gestión
 */
function getAllReminders() {
    return {
        reminders: loadReminders(),
        predefinedTargets: PREDEFINED_TARGETS
    };
}

function createReminder(data, client) {
    const reminders = loadReminders();
    const id = 'rem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    let daysLabel = 'Todos los días';
    if (data.type === 'once') {
        daysLabel = 'Una sola vez';
    } else if (Array.isArray(data.days)) {
        if (data.days.length === 7) daysLabel = 'Todos los días';
        else if (data.days.length === 5 && !data.days.includes(0) && !data.days.includes(6)) daysLabel = 'Lunes a Viernes';
        else if (data.days.length === 2 && data.days.includes(0) && data.days.includes(6)) daysLabel = 'Fines de semana';
        else {
            const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
            daysLabel = data.days.map(d => dayNames[d]).join(', ');
        }
    }

    const matchedTarget = PREDEFINED_TARGETS.find(t => t.id === data.target);
    const targetLabel = matchedTarget ? matchedTarget.name : (data.targetLabel || data.target);

    const newReminder = {
        id,
        title: (data.title || 'Recordatorio').trim(),
        target: (data.target || '').trim(),
        targetLabel,
        message: (data.message || '').trim(),
        type: data.type === 'once' ? 'once' : 'recurring',
        time: data.time || '10:00',
        datetime: data.datetime || null,
        days: Array.isArray(data.days) ? data.days : [1, 2, 3, 4, 5, 6, 0],
        daysLabel,
        enabled: data.enabled !== false,
        createdAt: new Date().toISOString(),
        lastSentAt: null
    };

    reminders.push(newReminder);
    saveReminders(reminders);

    if (newReminder.enabled && client) {
        scheduleReminderJob(newReminder, client);
    }

    return newReminder;
}

function updateReminder(id, data, client) {
    const reminders = loadReminders();
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) {
        throw new Error('Recordatorio no encontrado');
    }

    let daysLabel = reminders[idx].daysLabel;
    if (data.type === 'once') {
        daysLabel = 'Una sola vez';
    } else if (Array.isArray(data.days)) {
        if (data.days.length === 7) daysLabel = 'Todos los días';
        else if (data.days.length === 5 && !data.days.includes(0) && !data.days.includes(6)) daysLabel = 'Lunes a Viernes';
        else if (data.days.length === 2 && data.days.includes(0) && data.days.includes(6)) daysLabel = 'Fines de semana';
        else {
            const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
            daysLabel = data.days.map(d => dayNames[d]).join(', ');
        }
    }

    const matchedTarget = PREDEFINED_TARGETS.find(t => t.id === (data.target || reminders[idx].target));
    const targetLabel = matchedTarget ? matchedTarget.name : (data.targetLabel || data.target || reminders[idx].targetLabel);

    reminders[idx] = {
        ...reminders[idx],
        ...data,
        daysLabel,
        targetLabel,
        updatedAt: new Date().toISOString()
    };

    saveReminders(reminders);
    cancelJob(id);

    if (reminders[idx].enabled && client) {
        scheduleReminderJob(reminders[idx], client);
    }

    return reminders[idx];
}

function toggleReminder(id, enabled, client) {
    const reminders = loadReminders();
    const idx = reminders.findIndex(r => r.id === id);
    if (idx === -1) throw new Error('Recordatorio no encontrado');

    reminders[idx].enabled = !!enabled;
    saveReminders(reminders);

    if (reminders[idx].enabled) {
        scheduleReminderJob(reminders[idx], client);
    } else {
        cancelJob(id);
    }

    return reminders[idx];
}

function deleteReminder(id) {
    cancelJob(id);
    let reminders = loadReminders();
    reminders = reminders.filter(r => r.id !== id);
    saveReminders(reminders);
    return true;
}

async function testReminder(id, client) {
    const reminders = loadReminders();
    const reminder = reminders.find(r => r.id === id);
    if (!reminder) throw new Error('Recordatorio no encontrado');
    return await executeReminderSend(reminder, client);
}

module.exports = {
    initReminders,
    getAllReminders,
    createReminder,
    updateReminder,
    toggleReminder,
    deleteReminder,
    testReminder,
    PREDEFINED_TARGETS
};

