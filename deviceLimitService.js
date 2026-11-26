const fs = require('fs');
const path = require('path');

const DEVICE_USAGE_FILE = path.join(__dirname, 'tokens', 'device_usage.json');

// Asegurar existencia de directorio tokens
if (!fs.existsSync(path.join(__dirname, 'tokens'))) {
    try {
        fs.mkdirSync(path.join(__dirname, 'tokens'), { recursive: true });
    } catch (e) { }
}

function loadDeviceUsage() {
    if (!fs.existsSync(DEVICE_USAGE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(DEVICE_USAGE_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveDeviceUsage(data) {
    try {
        fs.writeFileSync(DEVICE_USAGE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[DeviceLimitService] Error guardando uso de dispositivos:', e.message);
    }
}

/**
 * Determina si una plataforma está sujeta al límite de 3 dispositivos/códigos (exclusivo para Claude y GPT).
 */
function isAiLimitedPlatform(platformName) {
    if (!platformName) return false;
    const p = platformName.toString().toLowerCase();
    return p.includes('gpt') || p.includes('chatgpt') || p.includes('claude');
}

/**
 * Genera la clave normalizada conectando el teléfono, la cuenta, el perfil asignado y opcionalmente el identificador de cupo/fila.
 */
function getNormalizedKey(phone, emailOrPlatform, profile = null, slotId = null) {
    const cleanPhone = (phone || '').toString().replace(/\D/g, '');
    const normPhone = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const cleanIdentifier = (emailOrPlatform || 'general').toString().toLowerCase().trim().replace(/[^a-z0-9@._-]/g, '');
    const cleanProfile = profile ? `_${profile.toString().toLowerCase().trim().replace(/[^a-z0-9]/g, '')}` : '';
    const cleanSlot = slotId !== null && slotId !== undefined && String(slotId).trim() !== ''
        ? `_slot${String(slotId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, '')}`
        : '';
    return `${normPhone}_${cleanIdentifier}${cleanProfile}${cleanSlot}`;
}

function parseDeviceLabelFromUserAgent(ua) {
    const raw = String(ua || '').trim();
    if (!raw) return null;

    let os = 'Equipo';
    if (/iphone/i.test(raw)) os = 'iPhone';
    else if (/ipad/i.test(raw)) os = 'iPad';
    else if (/android/i.test(raw)) os = 'Android';
    else if (/windows/i.test(raw)) os = 'Windows';
    else if (/macintosh|mac os x/i.test(raw)) os = 'Mac';
    else if (/linux/i.test(raw)) os = 'Linux';

    let browser = '';
    if (/edg\//i.test(raw)) browser = 'Edge';
    else if (/opr\//i.test(raw) || /opera/i.test(raw)) browser = 'Opera';
    else if (/chrome|crios/i.test(raw)) browser = 'Chrome';
    else if (/firefox|fxios/i.test(raw)) browser = 'Firefox';
    else if (/safari/i.test(raw)) browser = 'Safari';

    return browser ? `${os} • ${browser}` : os;
}

function extractRegisteredDevices(record) {
    if (!record || !Array.isArray(record.sessions)) return [];
    const seen = new Set();
    const list = [];
    for (const s of record.sessions) {
        const label = s && s.deviceLabel ? String(s.deviceLabel).trim() : '';
        if (label && !seen.has(label)) {
            seen.add(label);
            list.push(label);
        }
    }
    return list;
}

/**
 * Consulta el estado actual de dispositivos sin incrementar el conteo.
 */
function getDeviceUsage(phone, emailOrPlatform, maxAllowed = 3, profile = null, slotId = null) {
    const effectiveMax = (typeof maxAllowed === 'number' && maxAllowed > 0) ? maxAllowed : 3;

    if (!phone) {
        return { devicesUsed: 0, devicesRemaining: effectiveMax, maxDevices: effectiveMax, isBlocked: false, registeredDevices: [] };
    }

    const usage = loadDeviceUsage();
    const key = getNormalizedKey(phone, emailOrPlatform, profile, slotId);
    const legacyKey = (!slotId && profile) ? getNormalizedKey(phone, emailOrPlatform, null, null) : key;
    const record = usage[key] || usage[legacyKey];

    const used = record && typeof record.count === 'number' ? record.count : 0;
    const remaining = Math.max(0, effectiveMax - used);

    return {
        devicesUsed: used,
        devicesRemaining: remaining,
        maxDevices: effectiveMax,
        isBlocked: used >= effectiveMax,
        lastSessionAt: record ? record.lastSessionAt : null,
        registeredDevices: extractRegisteredDevices(record)
    };
}

/**
 * Registra un intento de acceso / código.
 * Si llega con huella web (IP + SO/navegador), reconoce dispositivos ya vinculados sin gastar cupo extra
 * y descuenta de inmediato si entra desde un equipo diferente.
 * Sin huella web (ej. WhatsApp), concede máximo 1 reintento en una ventana corta de 3 minutos.
 */
function registerDeviceRequest(phone, emailOrPlatform, clientIp = null, maxAllowed = 3, sessionWindowMs = 3 * 60 * 1000, profile = null, slotId = null, deviceInfo = null) {
    const effectiveMax = (typeof maxAllowed === 'number' && maxAllowed > 0) ? maxAllowed : 3;
    const deviceLabel = (deviceInfo && deviceInfo.deviceLabel) ||
        (deviceInfo && deviceInfo.userAgent ? parseDeviceLabelFromUserAgent(deviceInfo.userAgent) : null);
    const cleanIp = clientIp ? String(clientIp).replace('::ffff:', '').trim() : null;
    const fingerprint = (cleanIp && deviceLabel) ? `${cleanIp}|${deviceLabel}` : null;

    if (!phone) {
        return {
            canRequest: true,
            devicesUsed: 1,
            devicesRemaining: Math.max(0, effectiveMax - 1),
            maxDevices: effectiveMax,
            isNewDevice: true,
            deviceAlreadyRegistered: false,
            deviceLabel: deviceLabel || null,
            registeredDevices: deviceLabel ? [deviceLabel] : []
        };
    }

    const usage = loadDeviceUsage();
    const key = getNormalizedKey(phone, emailOrPlatform, profile, slotId);
    const legacyKey = (!slotId && profile) ? getNormalizedKey(phone, emailOrPlatform, null, null) : key;
    const now = Date.now();

    let record = usage[key] || usage[legacyKey];

    // Si no existe registro previo, es el dispositivo 1
    if (!record || typeof record !== 'object') {
        const entryLabel = deviceLabel || 'WhatsApp';
        record = {
            count: 1,
            profile: profile || null,
            slotId: slotId || null,
            firstSeenAt: now,
            lastSessionAt: now,
            lastRequestAt: now,
            currentSessionRetries: 0,
            sessions: [
                {
                    sessionIndex: 1,
                    timestamp: now,
                    ip: cleanIp || 'unknown',
                    deviceLabel: entryLabel,
                    ...(fingerprint ? { fingerprint } : {})
                }
            ]
        };
        usage[key] = record;
        saveDeviceUsage(usage);

        return {
            canRequest: true,
            devicesUsed: 1,
            devicesRemaining: Math.max(0, effectiveMax - 1),
            maxDevices: effectiveMax,
            isNewDevice: true,
            deviceAlreadyRegistered: false,
            deviceLabel: entryLabel,
            registeredDevices: extractRegisteredDevices(record)
        };
    }

    // Actualizar perfil / cupo si no estaba fijado
    if (!record.profile && profile) {
        record.profile = profile;
    }
    if (!record.slotId && slotId) {
        record.slotId = slotId;
    }
    if (!Array.isArray(record.sessions)) {
        record.sessions = [];
    }

    // Caso A: Viene desde Web con huella exacta (IP + dispositivo)
    if (fingerprint) {
        const existingSession = record.sessions.find(s => s && s.fingerprint === fingerprint);
        if (existingSession) {
            record.lastRequestAt = now;
            existingSession.lastSeenAt = now;
            usage[key] = record;
            saveDeviceUsage(usage);

            return {
                canRequest: true,
                devicesUsed: record.count,
                devicesRemaining: Math.max(0, effectiveMax - record.count),
                maxDevices: effectiveMax,
                isNewDevice: false,
                deviceAlreadyRegistered: true,
                deviceLabel,
                registeredDevices: extractRegisteredDevices(record)
            };
        }
        // Huella web distinta: verificar límite y registrar de inmediato como dispositivo nuevo
    } else {
        // Caso B: Solicitud sin huella (WhatsApp) -> máximo 1 reintento dentro de ventana corta (3 min por defecto)
        const timeSinceLastSession = now - (record.lastSessionAt || 0);
        const retries = Number(record.currentSessionRetries || 0);
        const isSameSession = timeSinceLastSession < sessionWindowMs && retries < 1;

        if (isSameSession) {
            record.currentSessionRetries = retries + 1;
            record.lastRequestAt = now;
            usage[key] = record;
            saveDeviceUsage(usage);

            return {
                canRequest: true,
                devicesUsed: record.count,
                devicesRemaining: Math.max(0, effectiveMax - record.count),
                maxDevices: effectiveMax,
                isNewDevice: false,
                deviceAlreadyRegistered: false,
                deviceLabel: null,
                registeredDevices: extractRegisteredDevices(record)
            };
        }
    }

    // Es un NUEVO dispositivo o nueva sesión fuera de la gracia
    if (record.count >= effectiveMax) {
        return {
            canRequest: false,
            devicesUsed: record.count,
            devicesRemaining: 0,
            maxDevices: effectiveMax,
            isNewDevice: false,
            deviceAlreadyRegistered: false,
            limitReached: true,
            deviceLabel: deviceLabel || null,
            registeredDevices: extractRegisteredDevices(record)
        };
    }

    // Incrementamos el dispositivo
    record.count++;
    record.lastSessionAt = now;
    record.lastRequestAt = now;
    record.currentSessionRetries = 0;
    const entryLabel = deviceLabel || 'WhatsApp';
    record.sessions.push({
        sessionIndex: record.count,
        timestamp: now,
        ip: cleanIp || 'unknown',
        deviceLabel: entryLabel,
        ...(fingerprint ? { fingerprint } : {})
    });

    usage[key] = record;
    saveDeviceUsage(usage);

    return {
        canRequest: true,
        devicesUsed: record.count,
        devicesRemaining: Math.max(0, effectiveMax - record.count),
        maxDevices: effectiveMax,
        isNewDevice: true,
        deviceAlreadyRegistered: false,
        deviceLabel: entryLabel,
        registeredDevices: extractRegisteredDevices(record)
    };
}

/**
 * Resetea el contador de dispositivos (para soporte, tras renovación o cuando se sacan todas las sesiones).
 * El límite de códigos no aplica cuando sacamos todas las sesiones.
 */
function resetDeviceUsage(phone, emailOrPlatform = null, profile = null, slotId = null, options = {}) {
    const usage = loadDeviceUsage();
    const cleanPhone = (phone || '').toString().replace(/\D/g, '');
    const normPhone = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const resetEntireAccount = options && options.resetEntireAccount !== undefined ? Boolean(options.resetEntireAccount) : true;
    let modified = false;

    // 1. Clave exacta por perfil / plataforma / cupo
    if (emailOrPlatform) {
        const key = getNormalizedKey(phone, emailOrPlatform, profile, slotId);
        const baseKey = getNormalizedKey(phone, emailOrPlatform, profile, null);
        const legacyKey = profile ? getNormalizedKey(phone, emailOrPlatform, null, null) : key;
        if (usage[key]) {
            delete usage[key];
            modified = true;
        }
        if (usage[baseKey]) {
            delete usage[baseKey];
            modified = true;
        }
        if (usage[legacyKey]) {
            delete usage[legacyKey];
            modified = true;
        }
    }

    // 2. Limpieza exhaustiva de cualquier registro que pertenezca al número de teléfono
    if (normPhone) {
        Object.keys(usage).forEach(k => {
            if (k.startsWith(normPhone)) {
                delete usage[k];
                modified = true;
            }
        });
    }

    // 3. Si se pasa una cuenta de correo maestro y se sacaron todas las sesiones de esa cuenta completa
    if (resetEntireAccount && emailOrPlatform && emailOrPlatform.includes('@')) {
        const cleanEmail = emailOrPlatform.toLowerCase().trim();
        Object.keys(usage).forEach(k => {
            if (k.includes(cleanEmail)) {
                delete usage[k];
                modified = true;
            }
        });
    }

    if (modified) {
        saveDeviceUsage(usage);
        return true;
    }
    return false;
}

/**
 * Helper unificado para determinar si una cuenta streaming cuenta con extracción 2FA automatizada
 */
async function checkAccountAutomationStatus(accountEmail, platform) {
    const emailLower = String(accountEmail || "").trim().toLowerCase();
    const platUpper = String(platform || "").trim().toUpperCase();

    if (!emailLower) {
        return { isAutomated: false, type: 'manual', label: 'Manual (Sin Correo)' };
    }

    // 1. Netflix: automatizado mediante portal de Hogar Sheerit
    if (platUpper.includes('NETFLIX')) {
        return { isAutomated: true, type: 'netflix', label: 'Hogar Netflix (Sheerit)' };
    }

    // 2. Token de Gmail activo en carpeta tokens/
    const tokensDir = path.join(__dirname, 'tokens');
    const tokenPath = path.join(tokensDir, `token_${emailLower}.json`);
    if (fs.existsSync(tokenPath)) {
        return { isAutomated: true, type: 'gmail', label: 'Gmail API (Token Activo)' };
    }

    // 3. TOTP Offline (ChatGPT, Amazon con secreto)
    const gptSecretsPath = path.join(tokensDir, 'gpt_secrets.json');
    if (fs.existsSync(gptSecretsPath)) {
        try {
            const gptSecrets = JSON.parse(fs.readFileSync(gptSecretsPath, 'utf8'));
            if (gptSecrets[emailLower]) {
                return { isAutomated: true, type: 'totp', label: 'TOTP 2FA (Generador)' };
            }
        } catch (e) {}
    }

    // 4. Receta RPA vinculada en stream_accounts
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query(
            `SELECT sa.rpa_recipe_id, r.name as recipe_name 
             FROM stream_accounts sa 
             JOIN rpa_recipes r ON sa.rpa_recipe_id = r.id 
             WHERE LOWER(sa.account_email) = ? 
             LIMIT 1`,
            [emailLower]
        );
        if (rows.length > 0 && rows[0].rpa_recipe_id) {
            return { 
                isAutomated: true, 
                type: 'rpa', 
                label: `Receta RPA (${rows[0].recipe_name})`,
                rpaRecipeId: rows[0].rpa_recipe_id,
                rpaRecipeName: rows[0].recipe_name
            };
        }
    } catch (e) {}

    // 5. Manual / Sin automatización configurada
    return { isAutomated: false, type: 'manual', label: 'Manual (Sin Automatización)' };
}

module.exports = {
    isAiLimitedPlatform,
    parseDeviceLabelFromUserAgent,
    getDeviceUsage,
    registerDeviceRequest,
    resetDeviceUsage,
    checkAccountAutomationStatus
};