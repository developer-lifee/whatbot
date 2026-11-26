const fs = require('fs');
const path = require('path');

const TRACES_FILE = path.join(__dirname, '..', 'logs', 'decision_traces.json');
const MAX_TRACES = 250;

let tracesMemory = null;

function loadTraces() {
    if (Array.isArray(tracesMemory)) return tracesMemory;
    try {
        if (fs.existsSync(TRACES_FILE)) {
            const raw = fs.readFileSync(TRACES_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                tracesMemory = parsed.slice(-MAX_TRACES);
                return tracesMemory;
            }
        }
    } catch (e) {
        console.warn('[DecisionTrace] Error cargando trazas previas:', e.message);
    }
    tracesMemory = [];
    return tracesMemory;
}

function saveTraces(list) {
    try {
        const dir = path.dirname(TRACES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(TRACES_FILE, JSON.stringify(list.slice(-MAX_TRACES), null, 2), 'utf8');
    } catch (e) {
        console.warn('[DecisionTrace] Error guardando trazas:', e.message);
    }
}

function normalizeLast10(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Registra una traza estructurada de las 3 capas (Contexto -> Decisor -> Despachador)
 * para acelerar la depuración automática en Errors bot.
 */
function recordDecisionTrace({
    phone = '',
    userId = '',
    clientName = '',
    layer1 = {},
    layer2 = {},
    layer3 = {},
    finalReply = '',
    needsEscalation = false,
    durationMs = 0
}) {
    const list = loadTraces();
    const normPhone = String(phone || userId || '').replace(/@.*/, '').replace(/\D/g, '');
    const entry = {
        timestamp: new Date().toISOString(),
        phone: normPhone,
        userId: String(userId || ''),
        clientName: String(clientName || ''),
        layer1: {
            combinedBodyPreview: String(layer1.combinedBodyPreview || '').slice(0, 220),
            hasMedia: Boolean(layer1.hasMedia),
            mediaCount: Number(layer1.mediaCount || 0),
            accountsCount: Number(layer1.accountsCount || 0),
            platforms: Array.isArray(layer1.platforms) ? layer1.platforms : [],
            siblingAccountsCount: Number(layer1.siblingAccountsCount || 0),
            previousState: layer1.previousState || null
        },
        layer2: {
            action: layer2.action || 'unmeasured_open_case',
            intent: layer2.intent || null,
            platform: layer2.platform || null,
            confidence: layer2.confidence ?? null,
            isUnmeasuredScenario: Boolean(layer2.isUnmeasuredScenario),
            unmeasuredTag: layer2.unmeasuredTag || null,
            reasoning: String(layer2.reasoning || '').slice(0, 260)
        },
        layer3: {
            handler: layer3.handler || 'unknown',
            branch: layer3.branch || '',
            escalated: Boolean(needsEscalation || layer3.escalated),
            replyPreview: String(finalReply || layer3.replyPreview || '').slice(0, 260)
        },
        durationMs: Number(durationMs || 0)
    };

    list.push(entry);
    if (list.length > MAX_TRACES) {
        tracesMemory = list.slice(-MAX_TRACES);
    }
    saveTraces(tracesMemory);
    return entry;
}

function getRecentTracesForPhone(phone, limit = 3) {
    const list = loadTraces();
    const targetLast10 = normalizeLast10(phone);
    const rawStr = String(phone || '').trim();
    if (!targetLast10 && !rawStr) return [];

    const matched = list.filter(t => {
        if (targetLast10 && normalizeLast10(t.phone) === targetLast10) return true;
        if (rawStr && t.userId && t.userId.includes(rawStr)) return true;
        return false;
    });
    return matched.slice(-Math.max(1, limit)).reverse();
}

function formatTracesForErrorsBot(traces) {
    if (!Array.isArray(traces) || traces.length === 0) return '';
    const lines = ['🧭 *Trazas recientes de Decisión (3 Capas):*'];
    traces.forEach((t, idx) => {
        const l1 = t.layer1 || {};
        const l2 = t.layer2 || {};
        const l3 = t.layer3 || {};
        lines.push(
            `#${idx + 1} [${t.timestamp}]` +
            `\n  • Capa 1 (Contexto): msg="${l1.combinedBodyPreview}" | media=${l1.hasMedia} (${l1.mediaCount}) | cuentas=${l1.accountsCount} [${(l1.platforms || []).join(', ')}] | perfiles_hermanos=${l1.siblingAccountsCount} | estado_prev=${l1.previousState || 'none'}` +
            `\n  • Capa 2 (Decisor): action=${l2.action}${l2.isUnmeasuredScenario ? ` [NO_MEDIDO: ${l2.unmeasuredTag || 'open'}]` : ''} | intent=${l2.intent || 'N/A'} | plat=${l2.platform || 'N/A'} | razón="${l2.reasoning}"` +
            `\n  • Capa 3 (Respuesta): handler=${l3.handler}${l3.branch ? ` (${l3.branch})` : ''} | escalado=${l3.escalated} | ${t.durationMs}ms | reply="${l3.replyPreview}"`
        );
    });
    return lines.join('\n');
}

module.exports = {
    recordDecisionTrace,
    getRecentTracesForPhone,
    formatTracesForErrorsBot
};
