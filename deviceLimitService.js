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
 * Genera la clave normalizada conectando el teléfono, la cuenta y el perfil asignado al cliente.
 */
function getNormalizedKey(phone, emailOrPlatform, profile = null) {
    const cleanPhone = (phone || '').toString().replace(/\D/g, '');
    const normPhone = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const cleanIdentifier = (emailOrPlatform || 'general').toString().toLowerCase().trim().replace(/[^a-z0-9@._-]/g, '');
    const cleanProfile = profile ? `_${profile.toString().toLowerCase().trim().replace(/[^a-z0-9]/g, '')}` : '';
    return `${normPhone}_${cleanIdentifier}${cleanProfile}`;
}

/**
 * Consulta el estado actual de dispositivos sin incrementar el conteo.
 */
function getDeviceUsage(phone, emailOrPlatform, maxAllowed = 3, profile = null) {
    if (!phone) {
        return { devicesUsed: 0, devicesRemaining: maxAllowed, maxDevices: maxAllowed, isBlocked: false };
    }

    const usage = loadDeviceUsage();
    const key = getNormalizedKey(phone, emailOrPlatform, profile);
    const legacyKey = profile ? getNormalizedKey(phone, emailOrPlatform, null) : key;
    const record = usage[key] || usage[legacyKey];

    const used = record && typeof record.count === 'number' ? record.count : 0;
    const remaining = Math.max(0, maxAllowed - used);

    return {
        devicesUsed: used,
        devicesRemaining: remaining,
        maxDevices: maxAllowed,
        isBlocked: used >= maxAllowed,
        lastSessionAt: record ? record.lastSessionAt : null
    };
}

/**
 * Registra un intento de acceso / código.
 * Conectado con el perfil asignado al cliente.
 * Si el usuario solicita varios códigos en la misma sesión (ventana de 15 minutos),
 * NO incrementa el número de dispositivos.
 */
function registerDeviceRequest(phone, emailOrPlatform, clientIp = null, maxAllowed = 3, sessionWindowMs = 15 * 60 * 1000, profile = null) {
    if (!phone) {
        return { canRequest: true, devicesUsed: 1, devicesRemaining: maxAllowed - 1, maxDevices: maxAllowed, isNewDevice: true };
    }

    const usage = loadDeviceUsage();
    const key = getNormalizedKey(phone, emailOrPlatform, profile);
    const legacyKey = profile ? getNormalizedKey(phone, emailOrPlatform, null) : key;
    const now = Date.now();

    let record = usage[key] || usage[legacyKey];

    // Si no existe registro previo, es el dispositivo 1
    if (!record || typeof record !== 'object') {
        record = {
            count: 1,
            profile: profile || null,
            firstSeenAt: now,
            lastSessionAt: now,
            lastRequestAt: now,
            sessions: [
                { sessionIndex: 1, timestamp: now, ip: clientIp || 'unknown' }
            ]
        };
        usage[key] = record;
        saveDeviceUsage(usage);

        return {
            canRequest: true,
            devicesUsed: 1,
            devicesRemaining: maxAllowed - 1,
            maxDevices: maxAllowed,
            isNewDevice: true
        };
    }

    // Actualizar perfil si no estaba fijado
    if (!record.profile && profile) {
        record.profile = profile;
    }

    // Verificar si está dentro de la misma sesión activa (ventana de gracia)
    const timeSinceLastSession = now - (record.lastSessionAt || 0);
    const isSameSession = timeSinceLastSession < sessionWindowMs;

    if (isSameSession) {
        record.lastRequestAt = now;
        usage[key] = record;
        saveDeviceUsage(usage);

        return {
            canRequest: true,
            devicesUsed: record.count,
            devicesRemaining: Math.max(0, maxAllowed - record.count),
            maxDevices: maxAllowed,
            isNewDevice: false
        };
    }

    // Es una NUEVA sesión (nuevo dispositivo o nuevo inicio de sesión días/horas después)
    if (record.count >= maxAllowed) {
        return {
            canRequest: false,
            devicesUsed: record.count,
            devicesRemaining: 0,
            maxDevices: maxAllowed,
            isNewDevice: false,
            limitReached: true
        };
    }

    // Incrementamos el dispositivo
    record.count++;
    record.lastSessionAt = now;
    record.lastRequestAt = now;
    if (!Array.isArray(record.sessions)) record.sessions = [];
    record.sessions.push({ sessionIndex: record.count, timestamp: now, ip: clientIp || 'unknown' });

    usage[key] = record;
    saveDeviceUsage(usage);

    return {
        canRequest: true,
        devicesUsed: record.count,
        devicesRemaining: Math.max(0, maxAllowed - record.count),
        maxDevices: maxAllowed,
        isNewDevice: true
    };
}

/**
 * Resetea el contador de dispositivos (para soporte o tras renovación)
 */
function resetDeviceUsage(phone, emailOrPlatform, profile = null) {
    const usage = loadDeviceUsage();
    const key = getNormalizedKey(phone, emailOrPlatform, profile);
    const legacyKey = profile ? getNormalizedKey(phone, emailOrPlatform, null) : key;
    let modified = false;
    if (usage[key]) {
        delete usage[key];
        modified = true;
    }
    if (usage[legacyKey]) {
        delete usage[legacyKey];
        modified = true;
    }
    if (modified) {
        saveDeviceUsage(usage);
        return true;
    }
    return false;
}

module.exports = {
    isAiLimitedPlatform,
    getDeviceUsage,
    registerDeviceRequest,
    resetDeviceUsage
};
