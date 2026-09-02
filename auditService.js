// whatbot/auditService.js
const fs = require('fs');
const path = require('path');

const AUDIT_LOG_FILE = path.join(__dirname, 'audit_logs.json');
const AUDIT_TEXT_LOG = path.join(__dirname, 'frontend_audit.log');

function loadAuditLogs() {
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
        return [];
    }
    try {
        const raw = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[Audit Service] Error loading audit logs:', e.message);
        return [];
    }
}

function saveAuditLogs(logs) {
    try {
        // Keep the latest 2000 log entries
        const trimmed = logs.slice(-2000);
        fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    } catch (e) {
        console.error('[Audit Service] Error saving audit logs:', e.message);
    }
}

/**
 * Log an administrative action with agent details and timestamp.
 * @param {Object} param0 
 * @param {string} param0.agentEmail
 * @param {string} param0.agentName
 * @param {string} param0.action
 * @param {string} [param0.target]
 * @param {Object|string} [param0.details]
 */
function logAdminAction({ agentEmail, agentName, action, target, details }) {
    const timestamp = new Date().toISOString();
    const cleanEmail = agentEmail || 'admin_sistema';
    const cleanName = agentName || (cleanEmail.includes('@') ? cleanEmail.split('@')[0] : 'Administrador');

    const entry = {
        id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        timestamp,
        dateFormatted: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
        agentEmail: cleanEmail,
        agentName: cleanName,
        action: action || 'UNKNOWN_ACTION',
        target: target || '',
        details: details || {}
    };

    // 1. Save to JSON store
    const logs = loadAuditLogs();
    logs.push(entry);
    saveAuditLogs(logs);

    // 2. Append to text log
    try {
        const logLine = `[${entry.dateFormatted}] [${entry.agentEmail}] [${entry.agentName}] Action: ${entry.action} Target: ${entry.target} Details: ${JSON.stringify(entry.details)}\n`;
        fs.appendFileSync(AUDIT_TEXT_LOG, logLine, 'utf8');
    } catch (err) {
        console.warn('[Audit Service] Error appending to text log:', err.message);
    }

    return entry;
}

/**
 * Retrieve filtered audit logs.
 */
function getAuditLogs({ limit = 100, action = null, agentEmail = null } = {}) {
    let logs = loadAuditLogs();
    if (action) {
        logs = logs.filter(l => (l.action || '').toLowerCase().includes(action.toLowerCase()));
    }
    if (agentEmail) {
        logs = logs.filter(l => (l.agentEmail || '').toLowerCase().includes(agentEmail.toLowerCase()));
    }
    return logs.slice(-limit).reverse();
}

/**
 * Formats recent audit logs into a clean text block for AI Assistant prompts.
 */
function formatAuditLogsForPrompt(limit = 40) {
    const logs = getAuditLogs({ limit });
    if (logs.length === 0) return 'No hay registros de auditoría recientes.';

    return logs.map(l => 
        `- [${l.dateFormatted}] Usuario: ${l.agentName} (${l.agentEmail}) | Acción: ${l.action} | Objetivo: ${l.target || 'N/A'} | Detalles: ${JSON.stringify(l.details)}`
    ).join('\n');
}

module.exports = {
    logAdminAction,
    getAuditLogs,
    formatAuditLogsForPrompt
};
