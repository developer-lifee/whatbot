const fs = require('fs');
const path = require('path');
const { getTodayInBogota } = require('./apiService');

const SCHEDULE_FILE = path.join(__dirname, 'support_schedule.json');

const DEFAULT_CONFIG = {
  manual_status: "auto", // "online", "offline", "auto"
  weekday_start: "10:00",
  weekday_end: "22:00",
  weekend_start: "16:00",
  weekend_end: "22:00",
  offline_message: "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos. Te responderemos tan pronto regresemos."
};

function getSupportScheduleConfig() {
  if (!fs.existsSync(SCHEDULE_FILE)) {
    saveSupportScheduleConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const content = fs.readFileSync(SCHEDULE_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch (e) {
    console.error("[Support Schedule Service] Error reading support_schedule.json:", e.message);
    return DEFAULT_CONFIG;
  }
}

function saveSupportScheduleConfig(config) {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error("[Support Schedule Service] Error writing support_schedule.json:", e.message);
  }
}

/**
 * Checks if support is currently open (active)
 * Returns { open: boolean, reason: string }
 */
function isSupportOpen() {
  const config = getSupportScheduleConfig();
  if (config.manual_status === "online") {
    return { open: true, reason: "Habilitado manualmente por administración." };
  }
  if (config.manual_status === "offline") {
    return { open: false, reason: "Deshabilitado manualmente por administración." };
  }

  // Auto mode: check BOG schedule
  const today = getTodayInBogota();
  const day = today.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = (day === 0 || day === 6);

  const startStr = isWeekend ? config.weekend_start : config.weekday_start;
  const endStr = isWeekend ? config.weekend_end : config.weekday_end;

  const [startHour, startMin] = startStr.split(':').map(Number);
  const [endHour, endMin] = endStr.split(':').map(Number);

  const currentHour = today.getHours();
  const currentMin = today.getMinutes();

  const currentMinutes = currentHour * 60 + currentMin;
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  if (currentMinutes >= startMinutes && currentMinutes <= endMinutes) {
    return { open: true, reason: "Dentro del horario automático de atención." };
  }

  return { open: false, reason: "Fuera del horario de atención." };
}

/**
 * Calculates queue position for a user based on userStates
 * @param {string} userId - WhatsApp chat ID (e.g. 12345@c.us)
 * @param {Map} userStates - In-memory Map of user states
 */
function getQueuePosition(userId, userStates) {
  if (!userStates) return null;
  const queue = [];
  for (const [id, state] of userStates.entries()) {
    const stateStr = typeof state === 'object' ? state.state : state;
    if (stateStr === 'waiting_human') {
      // Use waitingTimestamp or fall back to lastHumanInteraction, or 0
      const ts = (typeof state === 'object' && state.waitingTimestamp) 
        ? state.waitingTimestamp 
        : ((typeof state === 'object' && state.lastHumanInteraction) ? state.lastHumanInteraction : 0);
      queue.push({ id, ts });
    }
  }

  // Sort queue by timestamp (oldest first)
  queue.sort((a, b) => a.ts - b.ts);

  // Find index of userId
  const index = queue.findIndex(item => item.id === userId);
  if (index === -1) return null;
  return index + 1; // 1-based index
}

module.exports = {
  getSupportScheduleConfig,
  saveSupportScheduleConfig,
  isSupportOpen,
  getQueuePosition
};
