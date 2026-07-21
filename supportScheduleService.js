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
  offline_message: "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos. Te responderemos tan pronto regresemos.",
  allow_overtime: true,
  hourly_rate: 8333,
  trial_hourly_rate: 5000,
  trial_hours_target: 80
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
      
      if (todaySlots.length > 0) {
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

        if (activeAgents.length > 0) {
          return { open: true, reason: "Hay colaboradores con turnos de trabajo activos en este momento." };
        } else {
          return { 
            open: false, 
            reason: "No hay colaboradores con turnos de trabajo activos en este momento (o todos están en su hora de almuerzo/descanso)." 
          };
        }
      }
    }
  } catch (err) {
    console.error("[Support Schedule Service] Error checking agent schedules in isSupportOpen:", err.message);
  }

  // Fallback if no agent schedules are registered for today
  if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
    return { open: false, reason: "Fuera del horario de atención." };
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
async function checkUpcomingDayCoverage(client, groupId) {
  try {
    const { pool } = require('./database');
    const today = getNowInBogota();
    
    // Check for tomorrow
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const tomorrowDay = tomorrow.getDay();
    
    // Calculate week start for tomorrow (Monday of tomorrow's week)
    const dayOffset = tomorrowDay === 0 ? -6 : 1 - tomorrowDay;
    const monday = new Date(tomorrow);
    monday.setDate(tomorrow.getDate() + dayOffset);
    const currentWeekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

    const config = getSupportScheduleConfig();
    const isWeekend = (tomorrowDay === 0 || tomorrowDay === 6);
    const startStr = isWeekend ? config.weekend_start : config.weekday_start;
    const endStr = isWeekend ? config.weekend_end : config.weekday_end;
    
    const [startHour, startMin] = startStr.split(':').map(Number);
    const [endHour, endMin] = endStr.split(':').map(Number);
    const supportStartMin = startHour * 60 + startMin;
    const supportEndMin = endHour * 60 + endMin;

    // Fetch all schedules
    const [allSchedules] = await pool.query(
      "SELECT s.*, a.fullname FROM agent_schedules s JOIN agents a ON s.agent_id = a.id WHERE s.week_start = ? OR s.week_start = 'default'",
      [currentWeekStart]
    );

    const todaySlots = allSchedules.filter(s => s.day_of_week === tomorrowDay);
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

    const agentsToEvaluate = new Set([...customSlotsByAgent.keys(), ...defaultSlotsByAgent.keys()]);
    const activeSlots = [];
    for (const agentId of agentsToEvaluate) {
      const slots = customSlotsByAgent.has(agentId) 
        ? customSlotsByAgent.get(agentId) 
        : defaultSlotsByAgent.get(agentId);
      activeSlots.push(...slots);
    }

    // Check every 5 minutes
    const uncoveredSegments = [];
    let segmentStart = null;

    for (let m = supportStartMin; m <= supportEndMin; m += 5) {
      let isCovered = false;
      for (const slot of activeSlots) {
        const [sh, sm] = slot.start_time.split(':').map(Number);
        const [eh, em] = slot.end_time.split(':').map(Number);
        const slotStartMin = sh * 60 + sm;
        const slotEndMin = eh * 60 + em;

        if (m >= slotStartMin && m <= slotEndMin) {
          // Check break
          let onBreak = false;
          if (slot.break_type && slot.break_type !== 'none' && slot.break_start) {
            const [bh, bm] = slot.break_start.split(':').map(Number);
            const breakStartMin = bh * 60 + bm;
            const breakDuration = slot.break_type === 'break_30' ? 30 : 60;
            const breakEndMin = breakStartMin + breakDuration;
            if (m >= breakStartMin && m <= breakEndMin) {
              onBreak = true;
            }
          }
          if (!onBreak) {
            isCovered = true;
            break;
          }
        }
      }

      if (!isCovered) {
        if (segmentStart === null) {
          segmentStart = m;
        }
      } else {
        if (segmentStart !== null) {
          uncoveredSegments.push({ start: segmentStart, end: m - 5 });
          segmentStart = null;
        }
      }
    }
    if (segmentStart !== null) {
      uncoveredSegments.push({ start: segmentStart, end: supportEndMin });
    }

    if (uncoveredSegments.length > 0) {
      const formatMinToTime = (min) => {
        const h = Math.floor(min / 60);
        const m = min % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };

      const daysNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const tomorrowName = daysNames[tomorrowDay];
      
      let message = `🚨 *ALERTA DE HUECOS EN EL HORARIO* 🚨\n\nEl horario de mañana *${tomorrowName}* (${currentWeekStart}) no está cubierto por completo.\n\nFaltan asesores en las siguientes franjas:\n`;
      for (const seg of uncoveredSegments) {
        message += `- ⏰ *${formatMinToTime(seg.start)}* a *${formatMinToTime(seg.end)}*\n`;
      }
      message += `\nPor favor, algún colaborador libre hágase cargo de cubrir estas horas. ¡Gracias! 😊`;
      
      const chat = await client.getChatById(groupId);
      if (chat) {
        await chat.sendMessage(message);
      }
    }
  } catch (err) {
    console.error('Error checking upcoming day coverage:', err);
  }
}

async function getTodayScheduledShifts() {
  try {
    const { pool } = require('./database');
    const today = getNowInBogota();
    const day = today.getDay();
    
    // Calculate current week start date (Monday)
    const dayOffset = today.getDay() === 0 ? -6 : 1 - today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() + dayOffset);
    const currentWeekStart = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;

    const [rows] = await pool.query(
      "SELECT s.*, a.fullname FROM agent_schedules s JOIN agents a ON s.agent_id = a.id WHERE (s.week_start = ? OR s.week_start = 'default') AND s.day_of_week = ? ORDER BY s.start_time ASC",
      [currentWeekStart, day]
    );
    
    if (rows.length === 0) return "";
    
    const customSlotsByAgent = new Map();
    const defaultSlotsByAgent = new Map();
    for (const row of rows) {
      if (row.week_start === currentWeekStart) {
        if (!customSlotsByAgent.has(row.agent_id)) customSlotsByAgent.set(row.agent_id, []);
        customSlotsByAgent.get(row.agent_id).push(row);
      } else {
        if (!defaultSlotsByAgent.has(row.agent_id)) defaultSlotsByAgent.set(row.agent_id, []);
        defaultSlotsByAgent.get(row.agent_id).push(row);
      }
    }
    
    const activeSlots = [];
    const agentsToEvaluate = new Set([...customSlotsByAgent.keys(), ...defaultSlotsByAgent.keys()]);
    for (const agentId of agentsToEvaluate) {
      const slots = customSlotsByAgent.has(agentId) 
        ? customSlotsByAgent.get(agentId) 
        : defaultSlotsByAgent.get(agentId);
      activeSlots.push(...slots);
    }
    
    if (activeSlots.length === 0) return "";
    
    let shiftText = "\n\n📅 *Horario de atención de asesores para hoy:*";
    for (const slot of activeSlots) {
      shiftText += `\n- *${slot.fullname}*: de ${slot.start_time.substring(0, 5)} a ${slot.end_time.substring(0, 5)}`;
      if (slot.break_type && slot.break_type !== 'none' && slot.break_start) {
        const breakName = slot.break_type === 'lunch_60' ? 'Almuerzo' : 'Descanso';
        shiftText += ` _(${breakName}: ${slot.break_start.substring(0, 5)})_`;
      }
    }
    return shiftText;
  } catch (err) {
    console.error("Error in getTodayScheduledShifts:", err.message);
    return "";
  }
}

async function getOfflineReplyMessage(userId, userStates) {
  const config = getSupportScheduleConfig();
  const queuePos = getQueuePosition(userId, userStates);
  let offlineMsg = config.offline_message || "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos.";
  
  const shiftText = await getTodayScheduledShifts();
  if (shiftText) {
    offlineMsg += shiftText;
  }
  
  if (queuePos) {
    offlineMsg += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}.\n⚠️ _(Nota: Dado que estamos fuera de nuestro horario de atención, tu turno no avanzará hasta que nuestros asesores inicien labores de nuevo)._`;
  }
  return offlineMsg + " 🤖";
}

module.exports = {
  getSupportScheduleConfig,
  saveSupportScheduleConfig,
  isSupportOpen,
  getQueuePosition,
  checkUpcomingDayCoverage,
  getTodayScheduledShifts,
  getOfflineReplyMessage
};
