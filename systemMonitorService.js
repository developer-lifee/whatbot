const fs = require('fs');
const os = require('os');

// Grupos administrativos para alertas críticas
const ADMIN_GROUPS = [
    '120363427163636523@g.us', // Errors bot
    '120363102144405222@g.us'  // Junta Sheerit
];

let lastAlertTimestamp = 0;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutos de enfriamiento entre alertas
const RAM_ALERT_THRESHOLD_PERCENT = 85;   // Alerta si la RAM usada supera el 85%
const SWAP_ALERT_THRESHOLD_PERCENT = 60;  // Alerta si el swap usado supera el 60%

/**
 * Obtiene el uso detallado de memoria RAM y Swap del sistema.
 * En Linux lee /proc/meminfo (más exacto al considerar MemAvailable).
 * En macOS/otros usa el módulo nativo os.
 */
function getMemoryUsage() {
    try {
        if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
            const content = fs.readFileSync('/proc/meminfo', 'utf8');
            const lines = content.split('\n');
            const mem = {};

            for (const line of lines) {
                const parts = line.split(':');
                if (parts.length === 2) {
                    const key = parts[0].trim();
                    const val = parseInt(parts[1].trim().split(' ')[0], 10);
                    if (!isNaN(val)) mem[key] = val; // en kB
                }
            }

            const totalKB = mem.MemTotal || 0;
            const availableKB = mem.MemAvailable || mem.MemFree || 0;
            const usedKB = Math.max(0, totalKB - availableKB);
            const usedPercent = totalKB > 0 ? Math.round((usedKB / totalKB) * 100) : 0;

            const swapTotalKB = mem.SwapTotal || 0;
            const swapFreeKB = mem.SwapFree || 0;
            const swapUsedKB = Math.max(0, swapTotalKB - swapFreeKB);
            const swapPercent = swapTotalKB > 0 ? Math.round((swapUsedKB / swapTotalKB) * 100) : 0;

            return {
                platform: 'linux',
                totalMB: Math.round(totalKB / 1024),
                availableMB: Math.round(availableKB / 1024),
                usedMB: Math.round(usedKB / 1024),
                usedPercent,
                swapTotalMB: Math.round(swapTotalKB / 1024),
                swapUsedMB: Math.round(swapUsedKB / 1024),
                swapPercent,
                timestamp: Date.now()
            };
        }
    } catch (e) {
        console.error('[System Monitor] Error leyendo /proc/meminfo:', e.message);
    }

    // Fallback multiplataforma (macOS / desarrollo)
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = Math.round((usedBytes / totalBytes) * 100);

    return {
        platform: process.platform,
        totalMB: Math.round(totalBytes / (1024 * 1024)),
        availableMB: Math.round(freeBytes / (1024 * 1024)),
        usedMB: Math.round(usedBytes / (1024 * 1024)),
        usedPercent,
        swapTotalMB: 0,
        swapUsedMB: 0,
        swapPercent: 0,
        timestamp: Date.now()
    };
}

/**
 * Inicia el cron de monitoreo continuo de memoria.
 * Evalúa el consumo cada 3 minutos y envía alertas a WhatsApp si detecta sobrecarga.
 */
function startMemoryMonitor(whatsappClientGetter) {
    console.log('[System Monitor] ✅ Monitor de memoria RAM y Swap inicializado (intervalo: 3 min).');

    setInterval(async () => {
        try {
            const mem = getMemoryUsage();
            const isRamCritical = mem.usedPercent >= RAM_ALERT_THRESHOLD_PERCENT;
            const isSwapCritical = mem.swapTotalMB > 0 && mem.swapPercent >= SWAP_ALERT_THRESHOLD_PERCENT;

            if (isRamCritical || isSwapCritical) {
                const now = Date.now();
                if (now - lastAlertTimestamp >= ALERT_COOLDOWN_MS) {
                    lastAlertTimestamp = now;

                    const totalGB = (mem.totalMB / 1024).toFixed(1);
                    const usedGB = (mem.usedMB / 1024).toFixed(1);
                    const swapTotalGB = (mem.swapTotalMB / 1024).toFixed(1);
                    const swapUsedGB = (mem.swapUsedMB / 1024).toFixed(1);

                    const alertMsg = `⚠️ *[ALERTA DE SISTEMA - MEMORIA CRÍTICA]* ⚠️\n\n` +
                        `🚨 El servidor VPS presenta alta presión de memoria:\n\n` +
                        `📊 *RAM Física:* *${mem.usedPercent}%* (${usedGB} GB usados de ${totalGB} GB)\n` +
                        `🔄 *Memoria Swap:* *${mem.swapPercent}%* (${swapUsedGB} GB usados de ${swapTotalGB} GB)\n\n` +
                        `⚙️ *Recomendación:* Se ha superado el umbral del ${RAM_ALERT_THRESHOLD_PERCENT}%. Si planeas reiniciar el bot o compilar, espera a que descienda la carga para evitar bloqueos del sistema.`;

                    console.warn(`[System Monitor] ⚠️ Presión crítica de memoria detectada: RAM ${mem.usedPercent}%, Swap ${mem.swapPercent}%. Notificando a administradores...`);

                    const client = typeof whatsappClientGetter === 'function' ? whatsappClientGetter() : whatsappClientGetter;
                    if (client && typeof client.sendMessage === 'function') {
                        for (const groupId of ADMIN_GROUPS) {
                            try {
                                await client.sendMessage(groupId, alertMsg);
                            } catch (sendErr) {
                                console.error(`[System Monitor] Error enviando alerta al grupo ${groupId}:`, sendErr.message);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[System Monitor] Error en ciclo de verificación de memoria:', err.message);
        }
    }, 3 * 60 * 1000); // Cada 3 minutos
}

module.exports = {
    getMemoryUsage,
    startMemoryMonitor
};
