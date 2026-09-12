const { authenticator } = require('@otplib/preset-default');
const fs = require('fs');
const path = require('path');

const SECRETS_FILE = path.join(__dirname, 'tokens', 'gpt_secrets.json');
const USAGE_FILE = path.join(__dirname, 'tokens', 'gpt_usage.json');

// Ensure tokens directory exists
if (!fs.existsSync(path.join(__dirname, 'tokens'))) {
    fs.mkdirSync(path.join(__dirname, 'tokens'));
}

/**
 * Generates a TOTP code for a given email.
 * @param {string} email 
 * @returns {string|null}
 */
function generateGPTCode(email) {
    const secrets = loadSecrets();
    const secretVal = secrets[email.toLowerCase().trim()];
    if (!secretVal) return null;

    const secret = typeof secretVal === 'object' ? secretVal.secret : secretVal;

    try {
        return authenticator.generate(secret);
    } catch (error) {
        console.error(`[TOTP Service] Error generating code for ${email}:`, error.message);
        return null;
    }
}

/**
 * Increments the device counter for a user (phone) and account (email).
 * Enforces a 3-device limit with a 15-minute grace window for re-sending codes on the same device.
 * @param {string} phone 
 * @param {string} email 
 * @param {number} [maxAllowed=3]
 * @param {number} [windowMs=900000] (15 mins)
 * @returns {Object} { canRequest, devicesUsed, devicesRemaining, maxDevices, limitReached }
 */
function checkAndIncrementUsage(phone, email, maxAllowed = 3, windowMs = 15 * 60 * 1000, profile = null) {
    const { registerDeviceRequest } = require('./deviceLimitService');
    return registerDeviceRequest(phone, email, null, maxAllowed, windowMs, profile);
}

/**
 * Resets all usage counters.
 */
function resetAllUsage() {
    saveUsage({});
    console.log("[TOTP Service] All GPT usage counters have been reset.");
}

/**
 * Saves a secret for an email.
 * @param {string} email 
 * @param {string} secret 
 * @param {string} service 
 * @param {Object} [auditContext]
 */
function saveSecret(email, secret, service = 'ChatGPT', auditContext = {}) {
    const { logAdminAction } = require('./auditService');
    const secrets = loadSecrets();
    const cleanEmail = email.toLowerCase().trim();
    const existing = secrets[cleanEmail];

    const isUpdate = !!existing;
    const createdAt = existing && typeof existing === 'object' && existing.createdAt ? existing.createdAt : new Date().toISOString();
    const createdBy = existing && typeof existing === 'object' && existing.createdBy ? existing.createdBy : (auditContext.agentName || auditContext.agentEmail || 'Administrador');

    secrets[cleanEmail] = {
        secret: secret.replace(/\s/g, ''),
        service: service,
        createdAt: createdAt,
        createdBy: createdBy,
        updatedAt: new Date().toISOString(),
        updatedBy: auditContext.agentName || auditContext.agentEmail || 'Administrador'
    };
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));

    logAdminAction({
        agentEmail: auditContext.agentEmail || 'admin@sheerit.com',
        agentName: auditContext.agentName || 'Administrador',
        action: isUpdate ? 'UPDATE_2FA_ACCOUNT' : 'ADD_2FA_ACCOUNT',
        target: cleanEmail,
        details: { service, isUpdate }
    });
}

/**
 * Deletes a 2FA secret for an email.
 * @param {string} email 
 * @param {Object} [auditContext]
 */
function deleteSecret(email, auditContext = {}) {
    const { logAdminAction } = require('./auditService');
    const secrets = loadSecrets();
    const cleanEmail = email.toLowerCase().trim();
    if (secrets[cleanEmail]) {
        const deletedService = typeof secrets[cleanEmail] === 'object' ? secrets[cleanEmail].service : '2FA';
        delete secrets[cleanEmail];
        fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));

        logAdminAction({
            agentEmail: auditContext.agentEmail || 'admin@sheerit.com',
            agentName: auditContext.agentName || 'Administrador',
            action: 'DELETE_2FA_ACCOUNT',
            target: cleanEmail,
            details: { service: deletedService }
        });
        return true;
    }
    return false;
}

function loadSecrets() {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function loadUsage() {
    if (!fs.existsSync(USAGE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveUsage(usage) {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

module.exports = {
    generateGPTCode,
    checkAndIncrementUsage,
    resetAllUsage,
    saveSecret,
    deleteSecret,
    loadSecrets
};
