// whatbot/adminAssistantService.js
const fs = require('fs');
const path = require('path');
const { getAuditLogs, formatAuditLogsForPrompt } = require('./auditService');
const { loadSecrets } = require('./totpService');
const { getAvailabilityConfig } = require('./availabilityService');
const { formatChunksForPrompt, retrieveRelevantChunks } = require('./wikiRagService');

const ADMIN_KNOWLEDGE_FILE = path.join(__dirname, 'admin_knowledge.json');

// Cache for vector store of admin knowledge
let adminVectorStore = [];
let isVectorizing = false;

/**
 * Loads and segments admin knowledge base.
 */
function loadAdminDocs(query = '') {
    const docs = [];
    if (fs.existsSync(ADMIN_KNOWLEDGE_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(ADMIN_KNOWLEDGE_FILE, 'utf8'));
            if (raw.company_overview) {
                docs.push({
                    id: 'company_overview',
                    category: 'Empresa',
                    text: `Sheerit SAS: ${raw.company_overview.role}. Servicios principales: ${raw.company_overview.core_services.join(', ')}`
                });
            }
            if (raw.operational_protocols) {
                for (const [key, val] of Object.entries(raw.operational_protocols)) {
                    docs.push({
                        id: `proto_${key}`,
                        category: 'Protocolo',
                        text: `Protocolo ${key}: ${val.description || ''}. Procedimiento: ${val.procedure || ''}. Reglas: ${JSON.stringify(val)}`
                    });
                }
            }
            if (raw.role_permissions) {
                docs.push({
                    id: 'role_permissions',
                    category: 'Permisos',
                    text: `Permisos de Roles: Admin (${raw.role_permissions.admin}), Asesor (${raw.role_permissions.advisor})`
                });
            }
            if (raw.wiki_operations) {
                const qLower = (query || '').toLowerCase();
                const wikiKeys = Object.keys(raw.wiki_operations);
                
                // Buscar capítulos relevantes por coincidencia semántica
                let matchedKeys = wikiKeys.filter(k => {
                    const kLower = k.toLowerCase();
                    return qLower.includes(kLower) || 
                           (kLower === 'excel' && (qLower.includes('columna') || qLower.includes('celda') || qLower.includes('hoja') || qLower.includes('credencial'))) ||
                           (kLower === 'cortes en general' && (qLower.includes('corte') || qLower.includes('cortar') || qLower.includes('deudor') || qLower.includes('deben'))) ||
                           (kLower === 'datos importantes' && (qLower.includes('tarjeta') || qLower.includes('baneada') || qLower.includes('no sirve') || qLower.includes('temporal'))) ||
                           (kLower === 'tareas diarias' && (qLower.includes('cobro') || qLower.includes('renovacion') || qLower.includes('contacto') || qLower.includes('diaria'))) ||
                           (kLower === 'netflix' && (qLower.includes('net') || qLower.includes('extra') || qLower.includes('pantalla'))) ||
                           (kLower === 'disney' && (qLower.includes('disney') || qLower.includes('plus'))) ||
                           (kLower === 'hbo' && (qLower.includes('hbo') || qLower.includes('max') || qLower.includes('platino'))) ||
                           (kLower === 'chatgpt' && (qLower.includes('gpt') || qLower.includes('chat') || qLower.includes('openai'))) ||
                           (kLower === 'youtube' && (qLower.includes('yt') || qLower.includes('premium') || qLower.includes('invitacion'))) ||
                           (kLower === 'spotify' && (qLower.includes('musica') || qLower.includes('spoti'))) ||
                           (kLower === 'claude' && (qLower.includes('anthropic') || qLower.includes('code'))) ||
                           (kLower === 'gemini' && (qLower.includes('google') || qLower.includes('advanced')));
                });

                // Si no hay coincidencia específica o la consulta es general, incluir los capítulos esenciales de operaciones
                if (matchedKeys.length === 0) {
                    matchedKeys = ['EXCEL', 'DATOS IMPORTANTES', 'TAREAS DIARIAS', 'CORTES EN GENERAL'];
                }

                matchedKeys.slice(0, 3).forEach(k => {
                    const sec = raw.wiki_operations[k];
                    if (sec && sec.full_text) {
                        docs.push({
                            id: `wiki_${k}`,
                            category: `Wiki Sheerit (${sec.title})`,
                            text: sec.full_text.slice(0, 3500)
                        });
                    }
                });
            }
        } catch (e) {
            console.warn('[Admin RAG] Error reading admin_knowledge.json:', e.message);
        }
    }
    return docs;
}

/**
 * Gathers all real-time dynamic context for the Admin AI Assistant.
 */
function getLiveAdminContext({ query = '', agentName = '', agentEmail = '' } = {}) {
    // 1. Audit Logs
    const recentAudit = formatAuditLogsForPrompt(30);

    // 2. 2FA Accounts
    const secrets = loadSecrets();
    const twoFaSummary = Object.entries(secrets).map(([email, data]) => {
        const srv = typeof data === 'object' ? data.service : '2FA';
        const author = typeof data === 'object' && data.createdBy ? data.createdBy : 'Admin';
        const created = typeof data === 'object' && data.createdAt ? data.createdAt : 'Fecha previa';
        return `- Cuenta: ${email} | Servicio: ${srv} | Creado por: ${author} | Fecha: ${created}`;
    }).join('\n') || 'No hay cuentas 2FA registradas actualmente.';

    // 3. Stock & Incidents
    const availability = getAvailabilityConfig();
    const stockOverrides = Object.entries(availability.platforms || {}).map(([id, cfg]) => 
        `- ID ${id}: Disponible = ${cfg.isAvailable}, Motivo = "${cfg.reason || 'N/A'}", Incidente = "${cfg.incident || 'Ninguno'}"`
    ).join('\n') || 'Todas las plataformas operando con stock normal.';

    // 4. Admin Knowledge docs & Semantic RAG Chunks
    const ragKnowledge = formatChunksForPrompt(query, 4);
    const standardDocs = loadAdminDocs(query).map(d => `[${d.category}] ${d.text}`).join('\n\n');
    const adminDocs = [standardDocs, ragKnowledge].filter(Boolean).join('\n\n---\n\n');

    return {
        recentAudit,
        twoFaSummary,
        stockOverrides,
        adminDocs
    };
}

/**
 * Processes an administrative query using Gemini AI with RAG and Live Tools context.
 * @param {Object} param0 
 * @param {string} param0.query 
 * @param {string} [param0.activeTab] 
 * @param {string} [param0.agentName] 
 * @param {string} [param0.agentEmail] 
 * @param {Array} [param0.history] 
 */
async function processAdminAssistantQuery({ query, activeTab = 'home', agentName = 'Asesor', agentEmail = '', history = [] }) {
    const { recentAudit, twoFaSummary, stockOverrides, adminDocs } = getLiveAdminContext({ query, agentName, agentEmail });

    const systemPrompt = `Eres el Asistente Ejecutivo de Inteligencia Artificial del Panel Administrativo de Sheerit.
Tu objetivo es responder con precisión milimétrica a las consultas de los administradores y asesores de la plataforma.

Tienes acceso en tiempo real a los siguientes datos del sistema:

--- 📚 CONOCIMIENTO ADMINISTRATIVO & PROTOCOLOS ---
${adminDocs}

--- 🔍 REGISTRO DE AUDITORÍA RECIENTE (QUIÉN HIZO QUÉ Y CUÁNDO) ---
${recentAudit}

--- 🔑 INVENTARIO DE CUENTAS 2FA / TOTP (CON AUTOR Y FECHA) ---
${twoFaSummary}

--- 📦 ESTADO DE STOCK & INCIDENTES ACTIVOS ---
${stockOverrides}

--- INFORMACIÓN DE LA SESIÓN ACTUAL ---
Asesor consultando: ${agentName} (${agentEmail || 'correo no especificado'})
Sección activa del panel: ${activeTab}

REGLAS DE RESPUESTA:
1. Si te preguntan "¿Quién agregó X a 2FA?", "¿Quién modificó el stock?", "¿Qué cambios se hicieron?" o por logs:
   - Consulta el registro de auditoría o el inventario de 2FA.
   - Responde con el NOMBRE DEL ASESOR, el CORREO, la FECHA y la ACCIÓN exacta.
   - Si no hay un registro explícito en la lista, indícalo con total transparencia.
2. Si te preguntan por horarios, fechas pasadas (como 15 de julio), o nómina:
   - Explica el cálculo con base en la tarifa estándar ($8,333/hr) o de prueba ($5,000/hr) e indica que el sistema histórico incluye contratos finalizados que estuvieron presentes.
3. Formatea tu respuesta con Markdown enriquecido, emojis elegantes, viñetas claras y negritas.
4. Siempre sé resolutivo, claro y profesional.`;

    try {
        const { callGemini } = require('./aiService');
        const prompt = `Pregunta del Asesor: "${query}"\n\nResponde ahora de forma ejecutiva con base en la información suministrada:`;
        const responseText = await callGemini(prompt, systemPrompt, false);

        if (responseText && responseText.trim()) {
            // Determine relevant interactive buttons based on query context
            const buttons = [];
            const qLower = query.toLowerCase();
            if (qLower.includes('2fa') || qLower.includes('totp') || qLower.includes('authenticator') || qLower.includes('gpt')) {
                buttons.push({ label: '🔑 Ir a Cuentas 2FA', tab: 'gpt-accounts' });
            }
            if (qLower.includes('stock') || qLower.includes('disponibilidad') || qLower.includes('incidente') || qLower.includes('pausa')) {
                buttons.push({ label: '📦 Ir a Disponibilidad & Stock', tab: 'availability' });
            }
            if (qLower.includes('horario') || qLower.includes('turno') || qLower.includes('nomina') || qLower.includes('nómina') || qLower.includes('julio')) {
                buttons.push({ label: '📅 Ir a Horarios & Nómina', tab: 'payments' });
            }
            if (qLower.includes('ticket') || qLower.includes('soporte') || qLower.includes('reclamo')) {
                buttons.push({ label: '🎫 Ir a Tickets de Soporte', tab: 'tickets' });
            }
            if (qLower.includes('precio') || qLower.includes('plan') || qLower.includes('tarifa')) {
                buttons.push({ label: '🏷️ Ir a Precios & Planes', tab: 'pricing' });
            }

            return {
                success: true,
                answer: responseText,
                buttons
            };
        }
    } catch (err) {
        console.error('[Admin Assistant Service] Error generating AI response:', err.message);
    }

    // Fallback response if Gemini API is unreachable (extracts direct answer from Wiki)
    let fallbackText = `🤖 **Resumen del Asistente Sheerit**:\n\n` +
        `He consultado la base de conocimientos y la Wiki oficial para tu consulta: "*${query}*".\n\n`;

    if (adminDocs && adminDocs.includes('Wiki Sheerit')) {
        const wikiExtract = adminDocs.split('Wiki Sheerit').slice(1).map(s => s.slice(0, 900)).join('\n\n---\n\n');
        fallbackText += `📖 **Procedimiento Operativo de la Wiki**:\n${wikiExtract}\n\n`;
    } else {
        fallbackText += `• **Cuentas 2FA**: ${twoFaSummary.split('\n')[0] || 'Sin registros'}\n` +
            `• **Auditoría reciente**: ${recentAudit.split('\n')[0] || 'Sin cambios recientes'}\n\n`;
    }

    fallbackText += `📄 Puedes consultar o descargar el manual completo de 57 páginas en formato PDF desde la sección de Guías o en: \`/docs/wiki_sheerit_completa.pdf\`.`;

    return {
        success: true,
        answer: fallbackText,
        buttons: [
            { label: '📖 Ver PDF de la Wiki (57 págs)', tab: 'policies' }
        ]
    };
}

module.exports = {
    processAdminAssistantQuery,
    getLiveAdminContext
};
