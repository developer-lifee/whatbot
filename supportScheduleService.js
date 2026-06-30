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

function getNowInBogota() {
  const dateStr = new Date().toLocaleString("en-US", {timeZone: "America/Bogota"});
  return new Date(dateStr);
}

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
async function isSupportOpen() {
  const config = getSupportScheduleConfig();
  if (config.manual_status === "online") {
    return { open: true, reason: "Habilitado manualmente por administración." };
  }
  if (config.manual_status === "offline") {
    return { open: false, reason: "Deshabilitado manualmente por administración." };
  }

  // Auto mode: check BOG schedule
  const today = getNowInBogota();
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

  if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
    return { open: false, reason: "Fuera del horario de atención." };
  }

  // Connected with Agent Schedules: Check if any agent is currently active and not on break
  try {
    const { pool } = require('./database');
    
    // Calculate Monday of the current week (Bogota time)
    const dayOffset = today.getDay() === 0 ? -6 : 1 - today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() + dayOffset);
    const year = monday.getFullYear();
    const month = String(monday.getMonth() + 1).padStart(2, '0');
    const dateVal = String(monday.getDate()).padStart(2, '0');
    const currentWeekStart = `${year}-${month}-${dateVal}`;

    const [allSchedules] = await pool.query(
      "SELECT * FROM agent_schedules WHERE week_start = ? OR week_start = 'default'",
      [currentWeekStart]
    );

    if (allSchedules.length > 0) {
      // Find slots for today
      const todaySlots = allSchedules.filter(s => s.day_of_week === day);
      
      // Group by agent to prefer custom slots over default
      const customSlotsByAgent = new Map();
      const defaultSlotsByAgent = new Map();
      
      for (const slot of todaySlots) {
        if (slot.week_start === currentWeekStart) {
          if (!customSlotsByAgent.has(slot.agent_id)) customSlotsByAgent.set(slot.agent_id, []);
          customSlotsByAgent.get(slot.agent_id).push(slot);
        } else {
          if (!defaultSlotsByAgent.has(slot.agent_id)) defaultSlotsByAgent.set(slot.agent_id, []);
          defaultSlotsByAgent.get(slot.agent_id).push(slot);
        }
      }
      
      const activeAgents = [];
      const agentsToEvaluate = new Set([...customSlotsByAgent.keys(), ...defaultSlotsByAgent.keys()]);
      
      for (const agentId of agentsToEvaluate) {
        const slots = customSlotsByAgent.has(agentId) 
          ? customSlotsByAgent.get(agentId) 
          : defaultSlotsByAgent.get(agentId);

        for (const slot of slots) {
          const [sh, sm] = slot.start_time.split(':').map(Number);
          const [eh, em] = slot.end_time.split(':').map(Number);
          const slotStartMin = sh * 60 + sm;
          const slotEndMin = eh * 60 + em;

          // Check if current time is within this slot
          if (currentMinutes >= slotStartMin && currentMinutes <= slotEndMin) {
            // Check if agent is on break right now
            let onBreak = false;
            if (slot.break_type && slot.break_type !== 'none' && slot.break_start) {
              const [bh, bm] = slot.break_start.split(':').map(Number);
              const breakStartMin = bh * 60 + bm;
              const breakDuration = slot.break_type === 'break_30' ? 30 : 60;
              const breakEndMin = breakStartMin + breakDuration;

              if (currentMinutes >= breakStartMin && currentMinutes <= breakEndMin) {
                onBreak = true;
              }
            }
            if (!onBreak) {
              activeAgents.push(slot.agent_id);
            }
          }
        }
      }

      if (activeAgents.length === 0) {
        return { 
          open: false, 
          reason: "No hay colaboradores con turnos de trabajo activos en este momento (o todos están en su hora de almuerzo/descanso)." 
        };
      }
    }
  } catch (err) {
    console.error("[Support Schedule Service] Error checking agent schedules in isSupportOpen:", err.message);
  }

  return { open: true, reason: "Dentro del horario automático de atención." };
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
