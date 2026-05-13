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
    const secret = secrets[email.toLowerCase().trim()];
    if (!secret) return null;

    try {
        return authenticator.generate(secret);
    } catch (error) {
        console.error(`[TOTP Service] Error generating code for ${email}:`, error.message);
        return null;
    }
}

/**
 * Increments the usage counter for a user (phone) and account (email).
 * Returns true if the user is within the limit (max 3), false otherwise.
 * @param {string} phone 
 * @param {string} email 
 * @returns {boolean}
 */
function checkAndIncrementUsage(phone, email) {
    const usage = loadUsage();
    const key = `${phone}_${email.toLowerCase().trim()}`;
    
    if (!usage[key]) {
        usage[key] = 0;
    }

    if (usage[key] >= 3) {
        return false;
    }

    usage[key]++;
    saveUsage(usage);
    return true;
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
 */
function saveSecret(email, secret) {
    const secrets = loadSecrets();
    secrets[email.toLowerCase().trim()] = secret.replace(/\s/g, ''); // Remove spaces
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
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
    loadSecrets
};
