process.env.TZ = 'America/Bogota'; // Forzamos la zona horaria de Colombia a nivel global

const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// Sobrescribir consola para añadir timestamps y desacoplar los logs por origen
const fs = require('fs');
const path = require('path');
const util = require('util');

const originalLog = console.log;
const originalError = console.error;

let logsEnabled = true;
const logsDir = path.join(__dirname, 'logs');
try {
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
} catch (err) {
    originalError.call(console, "Failed to create logs directory:", err.message);
    logsEnabled = false;
}

const botLogPath = path.join(logsDir, 'bot.log');
const apiLogPath = path.join(logsDir, 'api.log');
const errorLogPath = path.join(logsDir, 'error.log');
const generalLogPath = path.join(logsDir, 'general.log');

function writeLog(filePath, text) {
    if (!logsEnabled) return;
    try {
        fs.appendFileSync(filePath, text + '\n', 'utf8');
    } catch (e) {
        originalError.call(console, "Failed writing to log file:", filePath, e.message);
    }
}

console.log = function (...args) {
    const now = new Date();
    const timestamp = `[${now.toLocaleString('es-CO')}]`;

    // Log to console (stdout) for PM2 compatibility
    originalLog.apply(console, [timestamp, ...args]);

    // Format text representation
    const textRepresentation = args.map(arg => typeof arg === 'object' ? util.inspect(arg, { depth: null }) : String(arg)).join(' ');
    const logLine = `${timestamp} ${textRepresentation}`;

    const lowerText = textRepresentation.toLowerCase();

    // Routing logic
    if (
        lowerText.includes('[bot') ||
        lowerText.includes('[ai') ||
        lowerText.includes('[message') ||
        lowerText.includes('[auto')
    ) {
        writeLog(botLogPath, logLine);
    } else if (
        lowerText.includes('[database') ||
        lowerText.includes('[rpa') ||
        lowerText.includes('[gmail') ||
        lowerText.includes('[google') ||
        lowerText.includes('[client') ||
        lowerText.includes('/api/')
    ) {
        writeLog(apiLogPath, logLine);
    } else {
        writeLog(generalLogPath, logLine);
    }
};

console.error = function (...args) {
    const now = new Date();
    const timestamp = `[${now.toLocaleString('es-CO')}]`;

    // Log to console (stderr) for PM2 compatibility
    originalError.apply(console, [timestamp, ...args]);

    const textRepresentation = args.map(arg => arg instanceof Error ? arg.stack : (typeof arg === 'object' ? util.inspect(arg, { depth: null }) : String(arg))).join(' ');
    const logLine = `${timestamp} ${textRepresentation}`;

    writeLog(errorLogPath, logLine);
};
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Funciones auxiliares de estabilidad
const { saveMessage } = require('./messageLogger');
function isCriticalBrowserError(err) {
    if (!err || !err.message) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('target closed') ||
        msg.includes('session closed') ||
        msg.includes('browser has disconnected') ||
        msg.includes('target crashed') ||
        msg.includes('detached frame') ||
        msg.includes('detached') ||
        msg.includes('execution context was destroyed') ||
        msg.includes('frame') ||
        msg.includes('protocol error') ||
        msg.includes('unresponsive') ||
        msg.includes('connection closed');
}
const { pool } = require('./database');

async function initTrackingTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS page_visits (
                id INT AUTO_INCREMENT PRIMARY KEY,
                page_path VARCHAR(255) NOT NULL,
                referrer VARCHAR(512) NULL,
                user_agent TEXT NULL,
                device_type VARCHAR(50) NULL,
                ip_address VARCHAR(45) NULL,
                visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS page_clicks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                page_path VARCHAR(255) NOT NULL,
                x_pct DECIMAL(5, 2) NOT NULL,
                y_pct DECIMAL(5, 2) NOT NULL,
                element_selector VARCHAR(255) NULL,
                screen_width INT NULL,
                screen_height INT NULL,
                clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log("✅ Tracking tables initialized successfully");
    } catch (err) {
        console.error("❌ Failed to initialize tracking tables:", err.message);
    }
}
initTrackingTables();

const { initDailyAutomation } = require('./scheduledTasks');
const { detectPaymentMethod, generateCredentialsResponse, generateEmpatheticFallback, detectInitialIntent, isPaymentReceipt } = require('./aiService');
const { getAccountsByPhone } = require('./apiService');
const { searchContactByPhone, addNewContact } = require('./googleContactsService');
const { getChatHistoryText } = require('./salesService');
const { checkNewPayments, findMatchingPayment } = require('./gmailService');
const { processCheckCredentials } = require('./billingService');
const { initKnowledgeVectors } = require('./ragKnowledgeService');

// Inicialización de la base de conocimiento vectorial RAG
initKnowledgeVectors().catch(e => console.error('[RAG Startup Error]:', e.message));

const PENDING_SALES_FILE = path.join(__dirname, 'pending_sales.json');

function loadPendingSales() {
    try {
        if (fs.existsSync(PENDING_SALES_FILE)) {
            const data = fs.readFileSync(PENDING_SALES_FILE, 'utf8');
            return new Map(Object.entries(JSON.parse(data)));
        }
    } catch (e) {
        console.error("Error loading pending sales:", e);
    }
    return new Map();
}

function savePendingSales(map) {
    try {
        const obj = Object.fromEntries(map);
        fs.writeFileSync(PENDING_SALES_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving pending sales:", e);
    }
}

// --- CONSTANTES Y ESTADOS GLOBALES ---
const USER_STATES_FILE = path.join(__dirname, 'user_states.json');

function decorateMap(mapInstance) {
    const originalSet = mapInstance.set;
    mapInstance.set = function (key, value) {
        if (value && typeof value === 'object') {
            const stateStr = value.state;
            if (stateStr === 'waiting_human') {
                const existing = mapInstance.get(key);
                if (!value.waitingTimestamp) {
                    if (existing && typeof existing === 'object' && existing.state === 'waiting_human' && existing.waitingTimestamp) {
                        value.waitingTimestamp = existing.waitingTimestamp;
                    } else {
                        value.waitingTimestamp = Date.now();
                    }
                }
            }
        }
        return originalSet.call(this, key, value);
    };
    return mapInstance;
}

let userStates = decorateMap(new Map());

// Deduplicador de mensajes para evitar doble procesamiento (Batch vs PendingChats)
const processedMessageIds = new Set();
setInterval(() => processedMessageIds.clear(), 5 * 60 * 1000); // Limpiar cada 5 min

// Control de usuarios en procesamiento activo para evitar ejecuciones simultáneas / duplicadas
const activeProcessingUsers = new Set();

// Cargar estados al iniciar
try {
    if (fs.existsSync(USER_STATES_FILE)) {
        const data = fs.readFileSync(USER_STATES_FILE, 'utf8');
        const parsed = JSON.parse(data);
        userStates = decorateMap(new Map(Object.entries(parsed)));
        console.log(`[System] ${userStates.size} estados de usuario cargados desde el disco.`);
    }
} catch (e) {
    console.error("[System] Error cargando user_states.json:", e.message);
}

/**
 * Guarda los estados actuales en el disco de forma atómica y segura.
 */
function saveUserStates() {
    try {
        const obj = Object.fromEntries(userStates);
        const tmpFile = `${USER_STATES_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(obj, null, 2), 'utf8');
        fs.renameSync(tmpFile, USER_STATES_FILE);
    } catch (e) {
        console.error("[System] Error guardando user_states.json:", e.message);
    }
}

/**
 * Consolida todos los registros LID en una sola identidad canónica (número real @c.us).
 * Elimina duplicados de memoria y de disco usando la tabla chats de MariaDB y userStates.
 */
async function consolidateCanonicalUserStates() {
    let mergedCount = 0;
    const lidToPhoneMap = new Map();

    // 1. Obtener mapeos desde MariaDB
    try {
        const [rows] = await pool.query("SELECT chat_id, customer_phone FROM chats WHERE customer_phone IS NOT NULL AND customer_phone != ''");
        rows.forEach(r => {
            const cleanPhone = r.customer_phone.replace(/\D/g, '');
            if (cleanPhone && cleanPhone.length >= 10) {
                const cleanLid = r.chat_id.replace(/\D/g, '');
                lidToPhoneMap.set(cleanLid, cleanPhone);
                lidToPhoneMap.set(r.chat_id, cleanPhone);
            }
        });
    } catch (e) { }

    // 2. Obtener mapeos desde userStates existentes
    for (const [key, state] of userStates.entries()) {
        if (!state) continue;
        const cleanKey = key.replace(/\D/g, '');
        const realPhone = state.realPhone ? String(state.realPhone).replace(/\D/g, '') : '';
        const chatJid = state.chatJid ? String(state.chatJid).replace(/\D/g, '') : '';
        
        if (cleanKey.length >= 10 && cleanKey.length <= 12 && chatJid && chatJid.length > 12) {
            lidToPhoneMap.set(chatJid, cleanKey);
        }
        if (realPhone && realPhone.length >= 10 && realPhone.length <= 12 && cleanKey.length > 12) {
            lidToPhoneMap.set(cleanKey, realPhone);
        }
    }

    // 3. Consolidar todas las entradas de userStates
    for (const [key, state] of Array.from(userStates.entries())) {
        if (!state) continue;
        const cleanKey = key.replace(/\D/g, '');
        const isLidKey = key.includes('@lid') || cleanKey.length > 12;

        let realPhone = state.realPhone ? String(state.realPhone).replace(/\D/g, '') : '';
        if ((!realPhone || realPhone === cleanKey) && isLidKey) {
            realPhone = lidToPhoneMap.get(cleanKey) || lidToPhoneMap.get(key) || '';
        }

        if (isLidKey && realPhone && realPhone !== cleanKey) {
            const canonicalKey = realPhone + '@c.us';
            const existingCanonical = userStates.get(canonicalKey) || {};

            userStates.set(canonicalKey, {
                ...existingCanonical,
                ...state,
                realPhone,
                chatJid: key.includes('@lid') ? key : (state.chatJid || `${cleanKey}@lid`)
            });
            userStates.delete(key);
            mergedCount++;
        }
    }

    if (mergedCount > 0) {
        console.log(`[Canonical Identity] 🔄 Consolidados ${mergedCount} estados LID duplicados en sus identidades canónicas reales.`);
        saveUserStates();
    }
}

// Ejecutar consolidación inicial
consolidateCanonicalUserStates().catch(err => console.error("[Canonical Identity Init]", err));

// Sobrescribir Map.set y Map.delete para auto-guardar
const originalSet = userStates.set.bind(userStates);
userStates.set = function (key, value) {
    if (value && typeof value === 'object' && value.state === 'waiting_human') {
        if (!value.waitingTimestamp) {
            value.waitingTimestamp = Date.now();
        }
    }
    const result = originalSet(key, value);
    saveUserStates();
    return result;
};

const originalDelete = userStates.delete.bind(userStates);
userStates.delete = function (key) {
    const result = originalDelete(key);
    saveUserStates();
    return result;
};

const pendingConfirmations = new Map();
const GROUP_ID = '120363102144405222@g.us';
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573133890800') + '@c.us';
const ADMIN_RAW_PHONE = OPERATOR_NUMBER.replace('@c.us', '');
let globalBotSleep = false;
let cachedProviderPhones = new Set();
let lastProviderFetch = 0;

async function isProviderSender(userId) {
    if (!userId) return false;
    
    // 1. Obtener número limpio y buscar teléfono real si es un @lid
    let clean = userId.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
    let realPhone = clean;

    if (userId.includes('@lid') || clean.length > 12) {
        try {
            const { pool } = require('./database');
            const [rows] = await pool.query('SELECT customer_phone FROM chats WHERE chat_id = ? AND customer_phone IS NOT NULL LIMIT 1', [userId]);
            if (rows && rows.length > 0 && rows[0].customer_phone) {
                realPhone = rows[0].customer_phone.replace(/\D/g, '');
            }
        } catch (e) {}
    }

    // 2. Refrescar caché de proveedores cada 30s
    if (Date.now() - lastProviderFetch > 30000) {
        try {
            const { pool } = require('./database');
            const [rows] = await pool.query("SELECT DISTINCT phone FROM provider_credentials WHERE phone IS NOT NULL AND phone != ''");
            const newSet = new Set();
            for (const r of rows) {
                const p = (r.phone || '').replace(/\D/g, '');
                if (p) {
                    newSet.add(p);
                    if (p.startsWith('57') && p.length > 10) newSet.add(p.substring(2));
                }
            }
            // Agregar identificadores conocidos de proveedores principales
            newSet.add('573027892574');
            newSet.add('3027892574');
            newSet.add('249723021713571'); // JID @lid de Spotinet Shop
            cachedProviderPhones = newSet;
            lastProviderFetch = Date.now();
        } catch (e) {
            console.error('[Provider Check Error]:', e.message);
        }
    }
    
    for (const provPhone of cachedProviderPhones) {
        if (clean === provPhone || clean.endsWith(provPhone) || provPhone.endsWith(clean) ||
            realPhone === provPhone || realPhone.endsWith(provPhone) || provPhone.endsWith(realPhone)) {
            return true;
        }
    }
    return false;
}

let globalLastPaymentUserId = null; // Memoria del último usuario que envió un comprobante o pidió ayuda
const messageQueues = new Map(); // Cola para agrupar mensajes por usuario
const lastResponseTimestamps = new Map(); // Para evitar múltiples respuestas seguidas
const BATCH_INTERVAL = 12000; // 12 segundos para agrupar mensajes
const RESPONSE_COOLDOWN = 15000; // 15 segundos entre respuestas automáticas (evita ráfagas separadas)
global.supportQueue = []; // Cola global de soporte anti-spam
const {
    startPurchaseProcess,
    handleSubscriptionInterest,
    handleAwaitingPurchasePlatforms,
    handleSelectingPlans,
    handleAddingPlatform
} = require('./salesService');

const {
    handleCobrosParser,
    handleAwaitingCobrosConfirmation,
    processCheckPrices,
    handleAutoCobros
} = require('./billingService');

const { recordNewSale } = require('./salesRegistryService');
const {
    handleBatchUnanswered,
    showAdminFunctions,
    handleAdminPaymentConfirmation,
    processPendingChats,
    handleSendManualPaymentMethods,
    showDetailedHelp,
    getUpcomingExpirationsReport,
    getNetflixMatchReport,
    handleAdminSuggestions,
    executeTestMode,
    executePaymentValidation,
    applyLabelToChat,
    removeLabelFromChat
} = require('./adminService');


// Crear servidor Express
const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(express.json({
    limit: '20mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configure Multer for images
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '_' + file.originalname)
    }
});
const upload = multer({ storage: storage });

// Main App Routes
app.get('/', (req, res) => {
    res.send('Hola, mundo! This is Sheerit Whatbot Express Server.');
});

// Helper interno para resolver la intención por IA + Link directo de YouTube/Music/Spotify
async function resolveMusicLink(query) {
    let aiResult = null;
    try {
        const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
        const DEEPSEEK_API_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";

        if (DEEPSEEK_API_KEY) {
            const response = await fetch(`${DEEPSEEK_API_BASE.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
                },
                body: JSON.stringify({
                    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: 'Eres un asistente musical para iOS Shortcuts y Siri. El usuario te dará un comando de voz como "oye siri reproduce X" o "pon la canción Y". Extrae el título exacto de la canción, el artista y genera el término ideal de búsqueda para encontrar el video o audio oficial. Responde ÚNICAMENTE un objeto JSON válido con los campos: "song" (título de la canción), "artist" (nombre del artista), "searchTerm" (término de búsqueda limpio).'
                        },
                        { role: 'user', content: query }
                    ],
                    response_format: { type: 'json_object' }
                })
            });

            if (response.ok) {
                const data = await response.json();
                const rawContent = data.choices?.[0]?.message?.content || "";
                aiResult = JSON.parse(rawContent);
            }
        }
    } catch (aiErr) {
        console.warn("[Music API] ⚠️ Error en consulta de IA, continuando con búsqueda limpia:", aiErr.message);
    }

    const songTitle = aiResult?.song || query.replace(/^(oye\s+siri\s+)?reproduce\s+/i, '').trim();
    const artistName = aiResult?.artist || "";
    const searchTerm = aiResult?.searchTerm || `${songTitle} ${artistName}`.trim();

    let ytData = null;
    try {
        const ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(searchTerm);
        const ytRes = await fetch(ytUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
            }
        });
        const html = await ytRes.text();
        const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (match && match[1]) {
            ytData = {
                videoId: match[1],
                url: `https://www.youtube.com/watch?v=${match[1]}`,
                musicUrl: `https://music.youtube.com/watch?v=${match[1]}`
            };
        }
    } catch (ytErr) {
        console.warn("[Music API] ⚠️ Error extrayendo link de YouTube:", ytErr.message);
    }

    const directUrl = ytData?.url || `https://www.youtube.com/results?search_query=${encodeURIComponent(searchTerm)}`;
    const musicUrl = ytData?.musicUrl || directUrl;
    const spotifyUrl = `https://open.spotify.com/search/${encodeURIComponent(searchTerm)}`;

    return {
        query,
        song: songTitle,
        artist: artistName,
        searchTerm,
        url: directUrl,
        musicUrl,
        spotifyUrl,
        youtubeVideoId: ytData?.videoId || null
    };
}

// 1. Endpoint JSON Completo (/api/music/search)
app.all('/api/music/search', express.json(), async (req, res) => {
    try {
        const query = req.query.q || req.query.query || req.body?.q || req.body?.query || req.body?.prompt || "";
        if (!query || !query.trim()) {
            return res.status(400).json({ success: false, message: "Proporciona el comando en el parámetro 'q' o 'query'." });
        }

        const data = await resolveMusicLink(query);

        if (req.query.format === 'text' || req.query.raw === 'true' || req.headers.accept?.includes('text/plain')) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(data.url);
        }

        return res.json({
            success: true,
            ...data,
            shortcutAction: "open_url",
            message: `Coincidencia encontrada para "${data.song}"${data.artist ? ' de ' + data.artist : ''}`
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Endpoint Texto Plano (/api/music/link) -> Devuelve ÚNICAMENTE la URL en texto plano
app.all('/api/music/link', express.json(), async (req, res) => {
    try {
        const query = req.query.q || req.query.query || req.body?.q || req.body?.query || req.body?.prompt || "";
        if (!query || !query.trim()) {
            return res.status(400).send("Falta parámetro q");
        }
        const data = await resolveMusicLink(query);
        res.setHeader('Content-Type', 'text/plain');
        return res.send(data.url);
    } catch (error) {
        return res.status(500).send("Error procesando link");
    }
});

// 3. Endpoint Redirección HTTP 302 (/api/music/play) -> Redirecciona directamente a la URL
app.get('/api/music/play', async (req, res) => {
    try {
        const query = req.query.q || req.query.query || "";
        if (!query.trim()) {
            return res.status(400).send("Por favor proporciona el parámetro 'q'.");
        }
        const data = await resolveMusicLink(query);
        return res.redirect(302, data.url);
    } catch (err) {
        return res.status(500).send("Error procesando redirección.");
    }
});

// Netflix Verification Endpoint
app.post('/api/netflix/verify', async (req, res) => {
    try {
        const { phone } = req.body;
        let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        // Clean IP (remove ipv6 wrapper if present)
        if (clientIp.includes('::ffff:')) {
            clientIp = clientIp.replace('::ffff:', '');
        }

        const { getAccountsByPhone, updateExcelData } = require('./apiService');
        let userAccounts = [];
        const isDemo = (typeof isDemoClientPhone === 'function') ? isDemoClientPhone(phone) : (phone === '000' || phone === '57000');
        if (isDemo && typeof DEMO_ACCOUNTS_LIST !== 'undefined') {
            userAccounts = DEMO_ACCOUNTS_LIST.filter(a => (a.Streaming || '').toUpperCase().includes('NETFLIX'));
        } else {
            userAccounts = await getAccountsByPhone(phone);
        }

        // Check if they have a non-extra Netflix account
        const netflixAcct = userAccounts.find(c => {
            const streamingName = (c.Streaming || "").toLowerCase();
            return streamingName.includes('netflix') && !streamingName.includes('extra');
        }) || userAccounts[0];

        if (!netflixAcct) {
            return res.status(404).json({ success: false, message: "No se encontró cuenta de Netflix asociada a este número." });
        }

        // Capture the IP natively into Microsoft Graph Excels (Operador column)
        if (netflixAcct._rowNumber) {
            const oldOperador = (netflixAcct.operador || netflixAcct.Operador || "").toString();
            let newOperadorRecord = oldOperador;

            // Only append IP if it's not already recorded
            if (!oldOperador.includes(clientIp)) {
                newOperadorRecord = oldOperador ? `${oldOperador} | IP: ${clientIp}` : `IP: ${clientIp}`;
                await updateExcelData(netflixAcct._rowNumber, { "operador": newOperadorRecord });
                console.log(`[NETFLIX API] Saved IP ${clientIp} for @${phone} (Row ${netflixAcct._rowNumber})`);
            } else {
                console.log(`[NETFLIX API] IP ${clientIp} was already recorded for @${phone}`);
            }
        }

        // Automated Netflix code/link extraction with retry loop
        let code = null;
        let link = null;
        try {
            const { findRecentCodes } = require('./gmailService');
            for (let attempt = 0; attempt < 3; attempt++) {
                console.log(`[NETFLIX API] Checking recent codes for ${netflixAcct.correo} (Attempt ${attempt + 1})...`);
                const recentCodes = await findRecentCodes(netflixAcct.correo, 15, 'netflix');
                const netflixMail = recentCodes.find(item =>
                    (item.subject || "").toLowerCase().includes('netflix') ||
                    (item.snippet || "").toLowerCase().includes('netflix')
                );

                if (netflixMail && (netflixMail.code || netflixMail.link)) {
                    code = netflixMail.code;
                    link = netflixMail.link;
                    console.log(`[NETFLIX API] Found Netflix code/link for ${netflixAcct.correo}: Code=${code}, Link=${link}`);
                    break;
                }
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        } catch (mailErr) {
            console.error(`[NETFLIX API] Failed to search Netflix codes for ${netflixAcct.correo}:`, mailErr.message);
        }

        if (!code && !link) {
            const tokenPath = path.resolve(__dirname, 'tokens', `token_${netflixAcct.correo.toLowerCase().trim()}.json`);
            if (!fs.existsSync(tokenPath)) {
                return res.json({
                    success: false,
                    message: `Se registró tu conexión, pero la bandeja de correo de la cuenta (${netflixAcct.correo}) no está vinculada al bot. Por favor, solicita el código al soporte técnico de Sheerit para recibirlo manualmente.`,
                    account: netflixAcct.correo
                });
            } else {
                return res.json({
                    success: false,
                    message: `Se registró tu conexión, pero no pudimos extraer ningún código o enlace reciente de Netflix para la cuenta ${netflixAcct.correo}. Por favor, asegúrate de presionar 'Actualizar Hogar' en tu TV para enviar el correo y refresca esta página en unos momentos.`,
                    account: netflixAcct.correo
                });
            }
        }

        res.json({
            success: true,
            message: link
                ? `¡Conexión verificada! Haz clic en el botón rojo de abajo para autorizar este dispositivo.`
                : `¡Conexión verificada! Ingresa el código mostrado a continuación en tu pantalla de Netflix.`,
            account: netflixAcct.correo,
            code,
            link
        });
    } catch (e) {
        console.error("[NETFLIX API Error]:", e);
        res.status(500).json({ error: e.message });
    }
});

// Public Endpoint to get recommended combo based on high stock (libres)
const COMBO_CACHE_FILE = path.join(__dirname, 'recommended_combo.json');

async function updateRecommendedComboCache() {
    console.log('[COMBO CACHE] 🔄 Actualizando caché de combo recomendado...');
    try {
        const { fetchRawData } = require('./apiService');
        const rawData = await fetchRawData();

        const stockMap = {};
        rawData.forEach(row => {
            const streaming = (row.Streaming || '').trim();
            if (!streaming) return;

            const name = (row.Nombre || '').toLowerCase().trim();
            const wa = (row.whatsapp || '').trim();
            const isLibre = !wa && (name === 'libre' || name === '');

            if (isLibre) {
                stockMap[streaming] = (stockMap[streaming] || 0) + 1;
            }
        });

        // Sort platforms by count of free spots descending
        const sortedPlatforms = Object.entries(stockMap)
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);

        const data = {
            success: true,
            sortedPlatforms,
            stockMap,
            updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(COMBO_CACHE_FILE, JSON.stringify(data, null, 2));
        console.log('[COMBO CACHE] ✅ Caché de combo recomendado actualizada con éxito.');
        return data;
    } catch (e) {
        console.error('[COMBO CACHE] ❌ Error actualizando caché:', e.message);
        return null;
    }
}

// Programar actualización cada hora
setInterval(() => {
    updateRecommendedComboCache().catch(console.error);
}, 60 * 60 * 1000);

// Ejecutar una vez al arrancar de forma asíncrona
setTimeout(() => {
    updateRecommendedComboCache().catch(console.error);
}, 10000);

app.get('/api/public/recommended-combo', async (req, res) => {
    try {
        if (fs.existsSync(COMBO_CACHE_FILE)) {
            const cached = JSON.parse(fs.readFileSync(COMBO_CACHE_FILE, 'utf8'));
            // Si la caché tiene más de 1 hora, disparar actualización silenciosa en segundo plano
            const ageMs = Date.now() - new Date(cached.updatedAt).getTime();
            if (ageMs > 60 * 60 * 1000) {
                updateRecommendedComboCache().catch(console.error);
            }
            return res.json(cached);
        }

        // Fallback si no existe la caché
        const data = await updateRecommendedComboCache();
        if (data) {
            return res.json(data);
        }
        res.status(500).json({ error: 'No se pudo generar el combo' });
    } catch (e) {
        console.error("[Recommended Combo API Error]:", e);
        res.status(500).json({ error: e.message });
    }
});


// Admin Dashboard Endpoints
app.get('/api/admin/clients', async (req, res) => {
    try {
        const { fetchCustomersData } = require('./apiService');
        const force = req.query.force === 'true';
        const clients = await fetchCustomersData(3, 2000, force);
        res.json(clients);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/web-sales/pending', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT * FROM web_sales_pending ORDER BY createdAt DESC');
        res.json({ success: true, sales: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/web-sales/approved', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT * FROM web_sales_approved ORDER BY approvedAt DESC');
        res.json({ success: true, sales: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/web-sales/pending/approve', express.json(), async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ success: false, error: 'OrderId is required' });
        const result = await approveBoldOrder(orderId);
        if (result.status === 'APPROVED') {
            return res.json({ success: true, message: 'Venta pendiente aprobada exitosamente y notificada por WhatsApp', sale: result.sale });
        }
        res.status(404).json({ success: false, error: 'Venta no encontrada en pendientes' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/web-sales/pending/delete', express.json(), async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ success: false, error: 'OrderId is required' });
        const { pool } = require('./database');
        const [result] = await pool.query('DELETE FROM web_sales_pending WHERE order_id = ?', [orderId]);
        if (result.affectedRows > 0) {
            return res.json({ success: true, message: 'Venta pendiente eliminada' });
        }
        res.status(404).json({ success: false, error: 'Venta no encontrada' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

const crypto = require('crypto');

app.post('/api/bold/generate-token', async (req, res) => {
    try {
        const { platform, customer, numbers } = req.body;
        if (!platform || !customer || !numbers) {
            return res.status(400).json({ error: 'Faltan campos obligatorios' });
        }

        const apiKey = process.env.BOLD_IDENTITY_KEY;
        const secretKey = process.env.BOLD_SECRET_KEY;
        if (!apiKey) throw new Error("Llave BOLD_IDENTITY_KEY no configurada en .env");

        const random = Math.floor(1000 + Math.random() * 9000);
        const orderId = `inv${random}`;
        const amountNum = Math.round(Number(String(platform.price).replace(/\D/g, '')));
        const currency = 'COP';

        // Guardar estado pendiente en base de datos.
        const { pool } = require('./database');
        await pool.query(
            'INSERT INTO web_sales_pending (order_id, firstName, lastName, email, whatsapp, platformName, amount, numbersStr) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
                orderId,
                customer.firstName || '',
                customer.lastName || '',
                customer.email || '',
                customer.whatsapp || '',
                platform.name,
                amountNum,
                numbers.join(',')
            ]
        );

        // Crear Link de Pago oficial de Bold vía API v1
        let paymentUrl = null;
        try {
            const cleanDescription = `Suscripcion a ${platform.name}`.replace(/[^\w\s-]/gi, '').substring(0, 50);
            const boldRes = await fetch('https://integrations.api.bold.co/online/link/v1', {
                method: 'POST',
                headers: {
                    'Authorization': `x-api-key ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    amount_type: 'CLOSE',
                    reference_id: orderId,
                    amount: {
                        total_amount: amountNum,
                        currency: currency
                    },
                    description: cleanDescription,
                    callback_url: `https://sheerit.co/?orderId=${orderId}&payment=success`
                })
            });

            const boldData = await boldRes.json();
            if (boldData && boldData.payload && boldData.payload.url) {
                paymentUrl = boldData.payload.url;
                console.log(`[Bold API] ✅ Link de pago creado exitosamente para orden ${orderId}: ${paymentUrl}`);
            } else {
                console.error("[Bold API] Error en respuesta de Bold:", boldData);
            }
        } catch (boldErr) {
            console.error("[Bold API] Error conectando con API de Bold:", boldErr.message);
        }

        const concatenated = `${orderId}${amountNum}${currency}${secretKey || ''}`;
        const integritySignature = secretKey ? crypto.createHash('sha256').update(concatenated).digest('hex') : '';

        res.json({
            orderId,
            apiKey,
            amount: amountNum.toString(),
            currency,
            description: `Suscripción a ${platform.name}`,
            tax: 'vat-19',
            integritySignature,
            paymentUrl,
            url: paymentUrl,
            redirectionUrl: `https://sheerit.co/?orderId=${orderId}&payment=success`
        });
    } catch (e) {
        console.error("Bold Generate Token Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bold/webhook', async (req, res) => {
    try {
        const signatureHeader = req.headers['x-bold-signature'] || req.headers['x-signature'] || req.headers['bold-signature'] || '';
        const secretKey = process.env.BOLD_SECRET_KEY;

        if (secretKey && signatureHeader && req.rawBody) {
            try {
                const computedSignature = crypto.createHmac('sha256', secretKey).update(req.rawBody).digest('hex');
                if (computedSignature !== signatureHeader && computedSignature.toLowerCase() !== signatureHeader.toLowerCase()) {
                    console.log(`[Bold Webhook] Advertencia de firma. Recibida: ${signatureHeader} Calculada: ${computedSignature}`);
                }
            } catch (sigErr) {
                console.error("[Bold Webhook] Error comprobando firma:", sigErr.message);
            }
        }

        const data = req.body || {};
        const eventType = (data.type || data.event || data.event_type || '').toUpperCase();
        const status = (data.data?.status || data.status || '').toUpperCase();

        let orderId = null;
        if (data.data?.metadata?.reference) orderId = data.data.metadata.reference;
        else if (data.data?.reference) orderId = data.data.reference;
        else if (data.subject) orderId = data.subject;
        else if (data.orderId) orderId = data.orderId;
        else if (data.reference) orderId = data.reference;

        console.log(`[Bold Webhook] Evento: ${eventType}, Status: ${status}, OrderId: ${orderId}`);

        const isApproved = eventType === 'SALE_APPROVED' || eventType === 'SALE.APPROVED' || eventType === 'PAYMENT_SUCCESS' || status === 'APPROVED' || status === 'SUCCESS' || status === 'PAID';

        if (isApproved && orderId) {
            const result = await approveBoldOrder(orderId);
            if (result.status === 'APPROVED') {
                return res.json({ message: 'Compra aprobada y proceso iniciado' });
            } else {
                return res.status(404).json({ message: 'No hay datos en cache para esta orden' });
            }
        } else {
            return res.json({ message: 'Evento recibido: ' + eventType });
        }

    } catch (e) {
        console.error("Webhook Error:", e);
        res.status(500).json({ error: e.message });
    }
});

async function approveBoldOrder(orderId) {
    const { pool } = require('./database');
    const [approvedRows] = await pool.query('SELECT * FROM web_sales_approved WHERE order_id = ?', [orderId]);
    if (approvedRows.length > 0) {
        return { status: 'APPROVED', sale: approvedRows[0] };
    }

    const [rows] = await pool.query('SELECT * FROM web_sales_pending WHERE order_id = ?', [orderId]);
    const customerData = rows[0];
    if (!customerData) {
        return { status: 'NOT_FOUND' };
    }

    console.log(`[Bold Approve] Procesando venta aprobada para orden ${orderId} (${customerData.firstName} ${customerData.lastName})`);

    const { recordNewSale } = require('./salesRegistryService');

    let formattedPhone = (customerData.whatsapp || '').replace(/\D/g, '');
    if (formattedPhone.length === 10 && !formattedPhone.startsWith('57') && !formattedPhone.startsWith('52')) {
        formattedPhone = '57' + formattedPhone;
    }
    const numericPhone = parseInt(formattedPhone) || 0;

    const userState = {
        items: [{ platform: { name: customerData.platformName } }],
        subscriptionType: 'mensual',
        nombre: `${customerData.firstName} ${customerData.lastName}`,
        phoneData: {
            raw: formattedPhone,
            numeric: numericPhone,
            excelFormatted: `'${formattedPhone}`
        }
    };

    const phoneId = `${formattedPhone}@c.us`;
    const results = await recordNewSale(phoneId, userState, "Bold Pagos");
    console.log("[Bold Approve] Resultados guardado en Excel via Bold:", results);

    let credentialsMsg = `¡Hola ${customerData.firstName}! 👋\n\nHemos recibido tu pago exitosamente. 🎉\n\n`;
    let hasAnyCredentials = false;
    const { getMaskedAccessData } = require('./aiService');
    const { getDynamicSupportExpectationMessage } = require('./adminService');

    results.forEach(res => {
        if (res.status === 'success' && res.correo) {
            hasAnyCredentials = true;
            const masked = getMaskedAccessData(res);

            const labelPin = (res.name || "").toLowerCase().includes('spotify') ? "DIRECCIÓN/LINK" : "PIN";
            const pinLine = res.pin ? `📌 ${labelPin}: \`${res.pin}\`\n` : "";
            const vencStr = res.vencimiento || "";
            const vencLine = vencStr ? `📅 Vence: *${vencStr}*\n` : "";

            credentialsMsg += `📺 *${masked.streamingName}*\n📧 Usuario: \`${masked.correo}\`\n🔑 Contraseña: \`${masked.clave}\`\n${pinLine}${vencLine}\n`;
        }
    });

    const manualItems = results.filter(res => res.status !== 'success');

    if (hasAnyCredentials) {
        const customerName = customerData.firstName || "";
        const profileTip = customerName ? `\n💡 *Importante:* Por favor crea tu perfil usando exactamente el nombre *${customerName}* (como está registrado en nuestro sistema) para poder llevar el control de tu cuenta. 😊` : `\n💡 *Importante:* Por favor crea tu perfil usando tu nombre registrado en nuestro sistema para poder llevar el control de tu cuenta. 😊`;
        credentialsMsg += profileTip;

        if (manualItems.length > 0) {
            const manualPlats = manualItems.map(item => item.name.toUpperCase()).join(', ');
            const expectation = getDynamicSupportExpectationMessage();
            credentialsMsg += `\n\n⚠️ *Nota:* Tu servicio de *${manualPlats}* requiere activación manual o invitación familiar. ${expectation}`;
            try {
                const groupChat = await client.getChatById(GROUP_ID);
                if (groupChat) {
                    await groupChat.sendMessage(`🚨 *ACTIVACIÓN MANUAL PARCIAL REQUERIDA* (@${phoneId.replace('@c.us', '')})\n` +
                        `Servicios manuales: ${manualPlats}\n` +
                        `Por favor, envíale la invitación manualmente.`);
                }
            } catch (e) { }
        }

        await client.sendMessage(phoneId, credentialsMsg);

        if (manualItems.length > 0) {
            const hasAppleOne = manualItems.some(item => (item.name || "").toLowerCase().includes('apple'));
            if (hasAppleOne) {
                const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                    `Para poder enviarte la invitación familiar, por favor envíame el *correo electrónico de tu Apple ID* (el que usas en tu iPhone/iPad/iCloud).\n\n` +
                    `*(Ejemplo: miusuario@icloud.com o miusuario@gmail.com)*`;
                await client.sendMessage(phoneId, appleMsg);
                userStates.set(phoneId, { state: 'awaiting_apple_one_details', chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
            } else {
                userStates.set(phoneId, { state: 'waiting_human', waitingCount: 1, chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
            }
            await applyLabelToChat(phoneId, client, ['pago', 'revisión', 'manual']).catch(() => { });
        } else {
            userStates.set(phoneId, { state: 'main_menu', nombre: `${customerData.firstName} ${customerData.lastName}`, chatJid: phoneId, lastPaymentValidated: Date.now() });
        }
    } else {
        const newManualItems = manualItems.filter(item => item.type !== 'renewal');
        const renewalItems = results.filter(item => item.type === 'renewal' || item.status === 'success');

        if (newManualItems.length > 0) {
            const hasAppleOne = newManualItems.some(item => (item.name || "").toLowerCase().includes('apple'));
            if (hasAppleOne) {
                const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                    `Para poder enviarte la invitación familiar, por favor envíame el *correo electrónico de tu Apple ID* (el que usas en tu iPhone/iPad/iCloud).\n\n` +
                    `*(Ejemplo: miusuario@icloud.com o miusuario@gmail.com)*`;
                await client.sendMessage(phoneId, appleMsg);
                userStates.set(phoneId, { state: 'awaiting_apple_one_details', chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
            } else {
                let manualMsg = `🤖 ¡Tu pago ha sido verificado con éxito! 🎉\n\n`;
                const formatCleanPlatformTitle = (rawName) => {
                    if (!rawName) return "tu servicio";
                    let str = rawName.toString().replace(/^COMBO\s*\([^)]*\)\s*:\s*/i, '').trim();
                    if (str.toUpperCase().includes('CLAUDE')) {
                        if (str.toUpperCase().includes('X5') || str.toUpperCase().includes(' 5')) return 'Claude Max x5';
                        if (str.toUpperCase().includes('MAX')) return 'Claude Max';
                        if (str.toUpperCase().includes('X2') || str.toUpperCase().includes(' 2')) return 'Claude Pro x2';
                        return 'Claude Pro';
                    }
                    if (str.includes(' - ')) {
                        const parts = str.split(' - ');
                        const platform = parts[0].trim();
                        const plan = parts[1] ? parts[1].trim() : "";
                        if (plan.toLowerCase().includes('correo') || plan.toLowerCase().includes('familiar') || plan.toLowerCase().includes('invitaci')) {
                            return `${platform} (${plan})`;
                        }
                        return platform;
                    }
                    return str;
                };
                const platformsStr = newManualItems.map(item => formatCleanPlatformTitle(item.name)).join(', ');
                const expectation = getDynamicSupportExpectationMessage();
                manualMsg += `Noté que tu servicio de *${platformsStr}* requiere de una activación personalizada, invitación de plan familiar o asignación manual.\n\n` +
                    `${expectation}`;
                await client.sendMessage(phoneId, manualMsg);

                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        let ticketTag = "";
                        try {
                            await pool.query(
                                'INSERT INTO chats (chat_id, customer_phone, last_message_text, updated_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE updated_at = NOW()',
                                [phoneId, phoneId.replace(/\D/g, ''), `Activación Manual Bold: ${platformsStr}`]
                            );
                            const [tRes] = await pool.query(
                                'INSERT INTO tickets (chat_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)',
                                [
                                    phoneId,
                                    `Activación Manual: ${platformsStr}`,
                                    `Pago Web Bold de $${customerData.amount || ''} para ${platformsStr}`,
                                    'open',
                                    'high'
                                ]
                            );
                            if (tRes && tRes.insertId) ticketTag = ` (#TK-${tRes.insertId})`;
                        } catch (tErr) { }

                        await groupChat.sendMessage(`🚨 *ACTIVACIÓN MANUAL REQUERIDA*${ticketTag} (@${phoneId.replace('@c.us', '')})\n` +
                            `Servicios: ${platformsStr}\n` +
                            `Monto: $${customerData.amount || ''}\n` +
                            `Por favor, un asesor debe enviarle la invitación o acceso manualmente.`);
                    }
                } catch (e) { }

                userStates.set(phoneId, { state: 'waiting_human', waitingCount: 1, chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
            }
            await applyLabelToChat(phoneId, client, ['pago', 'revisión', 'manual']).catch(() => { });
        } else if (renewalItems.length > 0) {
            const renewalPlats = renewalItems.map(item => item.name.toUpperCase()).join(', ');
            const venc = renewalItems[0].vencimiento || "";
            const vencLine = venc ? `\n📅 *Nueva fecha de vencimiento:* ${venc}` : "";
            const successMsg = `🤖 ¡Tu pago ha sido verificado con éxito! 🎉\n\nTu suscripción de *${renewalPlats}* ha sido renovada exitosamente.${vencLine}\n\n¡Gracias por renovar con Sheerit! 😊`;
            await client.sendMessage(phoneId, successMsg);
            userStates.set(phoneId, { state: 'main_menu', nombre: `${customerData.firstName} ${customerData.lastName}`, chatJid: phoneId, lastPaymentValidated: Date.now() });
        } else {
            const successMsg = `¡Hola ${customerData.firstName}! 👋\n\nHemos recibido tu pago exitosamente y tu pedido ya está registrado en nuestro sistema. En breve te enviaremos tus credenciales.`;
            await client.sendMessage(phoneId, successMsg);
            userStates.set(phoneId, { state: 'main_menu', nombre: `${customerData.firstName} ${customerData.lastName}`, chatJid: phoneId, lastPaymentValidated: Date.now() });
        }
    }

    try {
        await pool.query(
            'INSERT INTO web_sales_approved (order_id, firstName, lastName, email, whatsapp, platformName, amount, numbersStr, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                orderId,
                customerData.firstName || '',
                customerData.lastName || '',
                customerData.email || '',
                customerData.whatsapp || '',
                customerData.platformName || '',
                customerData.amount || 0,
                customerData.numbersStr || '',
                customerData.createdAt ? new Date(customerData.createdAt) : null
            ]
        );
        await pool.query('DELETE FROM web_sales_pending WHERE order_id = ?', [orderId]);
    } catch (dbErr) {
        console.error("Error inserting approved web sale into DB:", dbErr.message);
    }
    return { status: 'APPROVED', sale: customerData, deliveryResults: results };
}

app.get('/api/bold/check-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { pool } = require('./database');

        // 1. Verificar si ya fue aprobada en MariaDB
        const [approvedRows] = await pool.query('SELECT * FROM web_sales_approved WHERE order_id = ?', [orderId]);
        if (approvedRows.length > 0) {
            return res.json({
                success: true,
                status: 'APPROVED',
                sale: approvedRows[0]
            });
        }

        // 2. Verificar si está pendiente en MariaDB
        const [pendingRows] = await pool.query('SELECT * FROM web_sales_pending WHERE order_id = ?', [orderId]);
        if (pendingRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Orden no encontrada' });
        }

        // 3. Consultar estado en tiempo real a la API de Bold o verificar parámetro de redirección exitosa
        const apiKey = process.env.BOLD_IDENTITY_KEY;
        let boldStatus = 'PENDING';
        const isSuccessRedirect = req.query.payment === 'success' || req.query.status === 'APPROVED' || req.query.status === 'success';

        if (apiKey) {
            try {
                const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                const boldRes = await fetch(`https://integrations.api.bold.co/online/payment/v1/orders/${orderId}`, {
                    method: 'GET',
                    headers: {
                        'x-api-key': apiKey,
                        'Content-Type': 'application/json'
                    }
                });

                if (boldRes.ok) {
                    const boldData = await boldRes.json();
                    const bState = (boldData.status || boldData.data?.status || boldData.payment_status || '').toUpperCase();
                    if (bState === 'APPROVED' || bState === 'SALE_APPROVED' || bState === 'SUCCESS' || bState === 'PAID') {
                        boldStatus = 'APPROVED';
                    }
                }
            } catch (boldApiErr) {
                console.error("[Bold Check Status API Error]:", boldApiErr.message);
            }
        }

        // 4. Si el estado en Bold es APROBADO o viene redirigido con pago exitoso, procesar la orden inmediatamente
        if (boldStatus === 'APPROVED' || isSuccessRedirect) {
            console.log(`[Bold Check Status] 🚀 Aprobando orden ${orderId} al instante (boldStatus: ${boldStatus}, isSuccessRedirect: ${isSuccessRedirect})`);
            const approveRes = await approveBoldOrder(orderId);
            return res.json({
                success: true,
                status: 'APPROVED',
                sale: approveRes.sale
            });
        }

        return res.json({
            success: true,
            status: 'PENDING',
            message: 'Esperando confirmación del banco o Nequi...'
        });

    } catch (e) {
        console.error("Error checking Bold order status:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const { fetchCustomersData, getJsDateFromExcel, fetchHistoricoData } = require('./apiService');
        const { pool } = require('./database');
        const { timeframe } = req.query; // 'last_30_days', 'last_6_months', 'this_month', 'all_time'

        const clients = await fetchCustomersData();
        const now = new Date();
        now.setHours(0, 0, 0, 0);

        const stats = {
            totalClients: clients.length,
            byPlatform: {},
            byStatus: { active: 0, expired: 0, warning: 0 },
            expirations: { next7Days: 0, next15Days: 0, next30Days: 0 },
            revenueEstimate: 0,
            historyTrend: [],
            newsCount: 0,
            renewalsCount: 0,
            churnedCount: 0,
            financials: { totalIncome: 0, totalExpense: 0, netProfit: 0, trend: [] },
            loyalty: { topPurchasers: [], topRenewals: [], topSpenders: [] }
        };

        let historico = {};
        try {
            historico = await fetchHistoricoData();
        } catch (hErr) {
            console.error("[Stats API] Failed to fetch historico for calculations:", hErr.message);
        }

        const activePhones = new Set(clients.map(c => {
            const num = (c.numero || c.Numero || "").toString().replace(/\D/g, "");
            return num.slice(-10);
        }).filter(Boolean));

        clients.forEach(c => {
            const plat = (c.Streaming || 'Otros').split(' ')[0] || 'Otros';
            stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;

            const dateVal = c.deben || c.vencimiento;
            if (dateVal) {
                const venc = getJsDateFromExcel(dateVal);
                if (venc && !isNaN(venc.getTime())) {
                    venc.setHours(0, 0, 0, 0);
                    const diffTime = venc.getTime() - now.getTime();
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    if (diffDays < 0) {
                        stats.byStatus.expired++;
                    } else if (diffDays <= 5) {
                        stats.byStatus.warning++;
                        stats.byStatus.active++;
                    } else {
                        stats.byStatus.active++;
                    }

                    if (diffDays >= 0 && diffDays <= 7) stats.expirations.next7Days++;
                    if (diffDays >= 0 && diffDays <= 15) stats.expirations.next15Days++;
                    if (diffDays >= 0 && diffDays <= 30) stats.expirations.next30Days++;
                }
            }

            // Calculate New vs Renewal
            const cleanPhone = (c.numero || c.Numero || "").toString().replace(/\D/g, "");
            const targetTail = cleanPhone.slice(-10);
            const histKey = Object.keys(historico).find(k => k.endsWith(targetTail));
            const histRecord = histKey ? historico[histKey] : null;

            if (histRecord && histRecord.historial && histRecord.historial.length > 0) {
                const currentPlat = (c.Streaming || "").toLowerCase().trim();
                const hasPriorPurchase = histRecord.historial.some(h => {
                    const prevPlat = (h.streaming || "").toLowerCase().trim();
                    return prevPlat.includes(currentPlat) || currentPlat.includes(prevPlat);
                });
                if (hasPriorPurchase) {
                    stats.renewalsCount++;
                } else {
                    stats.newsCount++;
                }
            } else {
                stats.newsCount++;
            }
        });

        // Calculate Churn (Desistidos) - Active in the last 45 days of history but not in current list
        const fortyFiveDaysAgo = new Date();
        fortyFiveDaysAgo.setDate(now.getDate() - 45);

        for (const phone in historico) {
            const tail = phone.slice(-10);
            if (!activePhones.has(tail)) {
                const clientObj = historico[phone];
                if (clientObj && Array.isArray(clientObj.historial) && clientObj.historial.length > 0) {
                    let latestDate = null;
                    clientObj.historial.forEach(h => {
                        const d = getJsDateFromExcel(h.vencimiento || h.fecha_corte);
                        if (d && !isNaN(d.getTime())) {
                            if (!latestDate || d > latestDate) {
                                latestDate = d;
                            }
                        }
                    });

                    if (latestDate && latestDate >= fortyFiveDaysAgo && latestDate <= now) {
                        stats.churnedCount++;
                    }
                }
            }
        }

        // Cargar tendencia histórica de ventas
        try {
            const monthCounts = {};

            for (const phone in historico) {
                const clientObj = historico[phone];
                if (clientObj && Array.isArray(clientObj.historial)) {
                    clientObj.historial.forEach(h => {
                        const dateVal = h.deben || h.vencimiento || h.fecha_corte;
                        if (dateVal) {
                            const date = getJsDateFromExcel(dateVal);
                            if (date && !isNaN(date.getTime())) {
                                const monthName = date.toLocaleDateString('es-ES', { month: 'short' });
                                const year = date.getFullYear();
                                const key = `${monthName} ${year}`;
                                monthCounts[key] = (monthCounts[key] || 0) + 1;
                            }
                        }
                    });
                }
            }

            const trend = Object.entries(monthCounts).map(([name, ventas]) => {
                const parts = name.split(' ');
                const months = {
                    ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
                    jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
                };
                const m = months[parts[0].toLowerCase().substring(0, 3)] || 0;
                const y = parseInt(parts[1]) || 2026;
                const sortKey = y * 12 + m;
                return { name, ventas, sortKey };
            })
                .sort((a, b) => a.sortKey - b.sortKey)
                .slice(-8)
                .map(({ name, ventas }) => ({ name, ventas }));

            stats.historyTrend = trend;
        } catch (histErr) {
            console.error("[Stats API] Error computing history trend:", histErr.message);
        }

        // ---- NUEVOS CÁLCULOS FINANCIEROS Y FIDELIZACIÓN ----
        let dateFilterCashFlow = "";
        let dateFilterExcel = "";

        if (timeframe === 'last_30_days') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
            dateFilterExcel = "WHERE vencimiento >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        } else if (timeframe === 'last_6_months') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)";
            dateFilterExcel = "WHERE vencimiento >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)";
        } else if (timeframe === 'this_month') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
            dateFilterExcel = "WHERE vencimiento >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
        }

        // Finanzas
        try {
            const [flowSummary] = await pool.query(`
                SELECT 
                    SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
                    SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense
                FROM cash_flow_entries
                ${dateFilterCashFlow}
            `);
            if (flowSummary.length > 0) {
                stats.financials.totalIncome = Math.round(flowSummary[0].total_income || 0);
                stats.financials.totalExpense = Math.round(flowSummary[0].total_expense || 0);
                stats.financials.netProfit = stats.financials.totalIncome - stats.financials.totalExpense;
            }

            const [flowTrend] = await pool.query(`
                SELECT 
                    DATE_FORMAT(entry_date, '%b %Y') as month_year,
                    SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
                    SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
                    YEAR(entry_date) as y, MONTH(entry_date) as m
                FROM cash_flow_entries
                ${dateFilterCashFlow}
                GROUP BY month_year, y, m
                ORDER BY y ASC, m ASC
                LIMIT 12
            `);
            stats.financials.trend = flowTrend.map(f => ({
                name: f.month_year,
                ingresos: Math.round(f.income || 0),
                egresos: Math.round(f.expense || 0),
                ganancias: Math.round((f.income || 0) - (f.expense || 0))
            }));
        } catch (fErr) {
            console.error("[Stats API] Error calculating financials:", fErr.message);
        }

        // Fidelización / Mejores Clientes
        const getCustomerNameMap = async () => {
            const [rows] = await pool.query('SELECT phone, fullname FROM customers');
            const map = {};
            rows.forEach(r => { map[r.phone] = r.fullname; });
            return map;
        };

        try {
            const nameMap = await getCustomerNameMap();

            // 1. Clientes con más plataformas
            const [purchRows] = await pool.query(`
                SELECT customer_phone, COUNT(DISTINCT streaming_platform) as count 
                FROM excel_historical_records 
                ${dateFilterExcel}
                GROUP BY customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topPurchasers = await Promise.all(purchRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: r.count };
            }));

            // 2. Clientes con más renovaciones
            const [renewRows] = await pool.query(`
                SELECT customer_phone, COUNT(*) as count 
                FROM excel_historical_records 
                ${dateFilterExcel}
                GROUP BY customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topRenewals = await Promise.all(renewRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: r.count };
            }));

            // 3. Clientes con mayor inversión
            const [spentRows] = await pool.query(`
                SELECT customer_phone, SUM(amount_paid) as count 
                FROM excel_historical_records 
                ${dateFilterExcel}
                GROUP BY customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topSpenders = await Promise.all(spentRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: Math.round(r.count || 0) };
            }));
        } catch (lErr) {
            console.error("[Stats API] Error calculating loyalty stats:", lErr.message);
        }

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to retrieve specific client profile by phone number (including subscriptions, payments, and notes)
app.get('/api/admin/client-history', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const { resolveRealPhoneFromJid } = require('./billingService');
        const resolvedPhone = await resolveRealPhoneFromJid(phone.toString());
        const targetPhone = resolvedPhone || phone.toString();

        const { pool } = require('./database');
        const cleanPhone = targetPhone.replace(/\D/g, '');
        const targetTail = cleanPhone.slice(-10);

        if (cleanPhone.length < 7) {
            return res.json({ fullname: "", phone: cleanPhone, email: "", notes: "", subscriptions: [], purchases: [] });
        }

        // 1. Get customer info & notes
        const [custRows] = await pool.query(
            "SELECT * FROM customers WHERE phone LIKE ? OR phone = ?",
            [`%${targetTail}`, cleanPhone]
        );
        let customer = custRows[0] || { phone: cleanPhone, fullname: '', email: '', notes: '' };

        // 2. Get active/expired subscriptions from subscriptions table
        const [subRows] = await pool.query(
            "SELECT streaming_platform, account_email, account_password, profile_pin, expiration_date, status, payment_method, notes FROM subscriptions WHERE customer_phone LIKE ? OR customer_phone = ? ORDER BY expiration_date DESC",
            [`%${targetTail}`, cleanPhone]
        );

        // 3. Get approved purchases from web_sales_approved table
        const [saleRows] = await pool.query(
            "SELECT platformName, amount, createdAt, approvedAt, order_id FROM web_sales_approved WHERE whatsapp LIKE ? OR whatsapp = ? ORDER BY approvedAt DESC",
            [`%${targetTail}`, cleanPhone]
        );

        const forceSync = req.query.force === 'true';

        // Check if there are already records in the DB for this client
        const [existingDbRows] = await pool.query(
            "SELECT 1 FROM excel_historical_records WHERE customer_phone LIKE ? OR customer_phone = ? LIMIT 1",
            [`%${targetTail}`, cleanPhone]
        );

        if (forceSync || existingDbRows.length === 0) {
            // Sync matching records from Excel to DB on-demand
            try {
                const { fetchHistoricoData } = require('./apiService');
                const historicoData = await fetchHistoricoData();

                let matchedPhoneInExcel = null;
                let excelRowsToSync = [];
                let excelProfileName = "";

                for (const [keyPhone, obj] of Object.entries(historicoData)) {
                    const cleanKeyPhone = keyPhone.replace(/\D/g, '');
                    if (cleanKeyPhone.endsWith(targetTail) || targetTail.endsWith(cleanKeyPhone.slice(-10))) {
                        matchedPhoneInExcel = cleanKeyPhone;
                        excelRowsToSync = obj.historial || [];
                        excelProfileName = `${obj.nombre || ''} ${obj.apellido || ''}`.trim();
                        break;
                    }
                }

                if (excelRowsToSync.length > 0 && matchedPhoneInExcel) {
                    for (const hist of excelRowsToSync) {
                        const streaming = (hist.streaming || "").toString().trim();
                        const emailAcct = (hist.correo || "").toString().toLowerCase().trim();
                        const cutDate = (hist.fecha_corte || "").toString().trim();

                        if (!streaming || !emailAcct || !cutDate) continue;

                        // Parse amount_paid (deben) - Ignorar si la casilla contiene una fecha (ej: 29/04/2026 -> 29042026)
                        let amountPaid = 0;
                        if (hist.deben) {
                            const parsed = parseInt(hist.deben.toString().replace(/\D/g, ''));
                            if (!isNaN(parsed) && parsed < 200000) {
                                amountPaid = parsed;
                            }
                        }

                        // Format vencimiento
                        let vencimientoDate = null;
                        if (hist.vencimiento) {
                            const { getJsDateFromExcel } = require('./apiService');
                            const jsDate = getJsDateFromExcel(hist.vencimiento);
                            if (jsDate) {
                                vencimientoDate = jsDate.toISOString().slice(0, 10);
                            }
                        }

                        await pool.query(
                            `INSERT INTO excel_historical_records 
                                (customer_phone, streaming_platform, account_email, profile_name, profile_pin, fecha_corte, vencimiento, payment_method, amount_paid)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE 
                                profile_name = VALUES(profile_name),
                                profile_pin = VALUES(profile_pin),
                                vencimiento = VALUES(vencimiento),
                                payment_method = VALUES(payment_method),
                                amount_paid = VALUES(amount_paid)`,
                            [
                                matchedPhoneInExcel,
                                streaming,
                                emailAcct,
                                excelProfileName || null,
                                hist.pin_perfil || null,
                                cutDate,
                                vencimientoDate,
                                hist.metodo_pago || null,
                                amountPaid
                            ]
                        );
                    }
                }
            } catch (histErr) {
                console.error("[client-history] Error syncing excel historico to DB on-demand:", histErr.message);
            }
        }

        // Query the excel_historical_records table to return it
        let excelHistory = [];
        try {
            const [dbHistRows] = await pool.query(
                "SELECT streaming_platform AS streaming, account_email AS correo, profile_pin, fecha_corte, vencimiento, payment_method, amount_paid AS deben FROM excel_historical_records WHERE customer_phone LIKE ? OR customer_phone = ? ORDER BY id DESC",
                [`%${targetTail}`, cleanPhone]
            );
            excelHistory = dbHistRows;
        } catch (dbHistErr) {
            console.error("[client-history] Error querying excel_historical_records from DB:", dbHistErr.message);
        }

        res.json({
            fullname: customer.fullname || '',
            phone: customer.phone || cleanPhone,
            email: customer.email || '',
            notes: customer.notes || '',
            subscriptions: subRows,
            purchases: saleRows,
            excelHistory: excelHistory
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to retrieve specific account history by email
app.get('/api/admin/account-history', async (req, res) => {
    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }
    try {
        const [rows] = await pool.query(
            `SELECT h.fecha_corte, h.vencimiento, h.payment_method, h.amount_paid AS deben, h.profile_name, h.profile_pin, h.customer_phone, c.fullname AS customer_name
             FROM excel_historical_records h
             LEFT JOIN customers c ON h.customer_phone = c.phone
             WHERE h.account_email = ?
             ORDER BY h.id DESC`,
            [email.toString().trim().toLowerCase()]
        );
        res.json(rows);
    } catch (e) {
        console.error("Error retrieving account history:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to save/update customer notes (conocimientos)
app.post('/api/admin/client-history/save-notes', express.json(), async (req, res) => {
    try {
        const { phone, notes, fullname, email } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el teléfono' });

        const { resolveRealPhoneFromJid } = require('./billingService');
        const resolvedPhone = await resolveRealPhoneFromJid(phone.toString());
        const targetPhone = resolvedPhone || phone.toString();

        const { pool } = require('./database');
        const cleanPhone = targetPhone.replace(/\D/g, '');

        await pool.query(`
            INSERT INTO customers (phone, fullname, email, notes)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                notes = VALUES(notes),
                fullname = VALUES(fullname),
                email = VALUES(email)
        `, [cleanPhone, fullname || '', email || '', notes || '']);

        res.json({ success: true, message: 'Conocimientos del cliente actualizados.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint para editar la fecha de vencimiento (deben) de un cliente a gusto del administrador
app.post('/api/admin/client/update-expiration', express.json(), async (req, res) => {
    try {
        const { rowNumber, phone, streaming, newDate, password } = req.body;
        if (password !== 'admin123') {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        if (!newDate) {
            return res.status(400).json({ success: false, message: 'Fecha de vencimiento requerida' });
        }

        const { updateExcelData, fetchRawData } = require('./apiService');
        let targetRow = parseInt(rowNumber);

        if (!targetRow || isNaN(targetRow)) {
            const allRows = await fetchRawData();
            const cleanPhone = (phone || '').toString().replace(/\D/g, '');
            const target = allRows.find(r => {
                const rPhone = (r.numero || r.Numero || r.whatsapp || '').toString().replace(/\D/g, '');
                const rStreaming = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                const matchPhone = cleanPhone && rPhone.includes(cleanPhone.slice(-10));
                const matchStreaming = !streaming || rStreaming.includes(streaming.toLowerCase());
                return matchPhone && matchStreaming;
            });
            if (target) {
                targetRow = target._rowNumber || (allRows.indexOf(target) + 2);
            }
        }

        if (!targetRow || isNaN(targetRow)) {
            return res.status(404).json({ success: false, message: 'No se encontró la fila del cliente en Excel' });
        }

        const formattedDate = newDate.toString().trim();
        const updates = { "deben": formattedDate, "observaciones": `Vencimiento editado manualmente (${formattedDate})` };

        console.log(`[Admin API] Editando vencimiento en fila ${targetRow} -> ${formattedDate}`);
        const result = await updateExcelData(targetRow, updates);

        res.json({
            success: true,
            message: `Vencimiento actualizado a ${formattedDate} exitosamente.`,
            rowNumber: targetRow,
            newDate: formattedDate,
            result
        });
    } catch (e) {
        console.error("[Admin API] Error actualizando vencimiento:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/actions/send-info', async (req, res) => {
    try {
        const { phone, type, password, message: customMessage, platform } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const cleanPhone = phone ? phone.toString().replace(/\D/g, '') : '';
        if (!cleanPhone) {
            return res.status(400).json({ success: false, error: 'Número de teléfono inválido', message: 'Número de teléfono inválido' });
        }

        const formatExcelDate = (excelDate) => {
            if (!excelDate) return '-';
            const str = excelDate.toString().trim();
            if (isNaN(str)) {
                return str;
            }
            try {
                const serial = parseFloat(str);
                const date = new Date((serial - 25569) * 86400 * 1000);
                if (!isNaN(date.getTime())) {
                    const year = date.getUTCFullYear();
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                }
            } catch (e) { }
            return str;
        };

        let message = "";

        if (type === 'custom') {
            message = customMessage || "";
        } else {
            const { getAccountsByPhone } = require('./apiService');
            let accounts = await getAccountsByPhone(cleanPhone);
            if (!accounts || accounts.length === 0) return res.status(404).json({ success: false, message: 'Client not found', error: 'Client not found' });

            if (platform && platform.toString().trim() !== "") {
                const targetPlat = platform.toString().toLowerCase().trim();
                const filteredAccounts = accounts.filter(acc => {
                    const streaming = (acc.Streaming || acc.Plataforma || '').toString().toLowerCase();
                    return streaming.includes(targetPlat) || targetPlat.includes(streaming);
                });
                if (filteredAccounts.length > 0) {
                    accounts = filteredAccounts;
                }
            }

            if (type === 'credentials') {
                message = `*Tus Credenciales de Sheer IT* 🔑\n\n`;
                accounts.forEach((clientData) => {
                    const streaming = (clientData.Streaming || 'N/A').toString().trim();
                    const streamingLower = streaming.toLowerCase();
                    const pass = clientData['pin perfil'] || clientData.contraseña || clientData.Clave || clientData.clave || clientData.password || '';
                    const pin = clientData['pin perfil'] || clientData.pin || clientData.pin_perfil || '';
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    const customerMail = clientData['customer mail'] || clientData.customerMail || clientData['Customer Mail'] || '';

                    const isFamilyOrInvitation = streamingLower.includes('youtube') ||
                        streamingLower.includes('apple') ||
                        streamingLower.includes('spotify familiar') ||
                        streamingLower.includes('extra');

                    message += `🍿 *Servicio:* ${streaming.toUpperCase()}\n`;
                    if (isFamilyOrInvitation && customerMail) {
                        message += `📧 *Correo registrado:* ${customerMail}\n` +
                            `📌 *Estado:* Acceso por invitación / perfil propio\n`;
                    } else {
                        message += `📧 *Usuario:* ${clientData.correo || 'N/A'}\n`;
                        if (pass && pass !== 'N/A') message += `🔑 *Contraseña:* ${pass}\n`;
                        if (pin && pin !== pass) message += `📍 *Pin Perfil:* ${pin}\n`;
                    }
                    message += `📅 *Vence:* ${venc}\n\n`;
                });
                message += `¡Disfruta tu servicio! 🤖`;
            } else if (type === 'payment') {
                const clientName = accounts[0].Nombre || 'Cliente';
                message = `¡Hola ${clientName}! 👋\n\n` +
                    `Te recordamos que tus siguientes servicios están próximos a vencer:\n\n`;
                accounts.forEach((clientData) => {
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    message += `• *${(clientData.Streaming || 'N/A').toUpperCase()}* - Vence: ${venc}\n`;
                });
                message += `\n` +
                    `Puedes renovar realizando tu transferencia aquí:\n` +
                    `*Nequi / Daviplata / Bre-B (Llave):* 0087387259 ⚡\n\n` +
                    `Una vez realizado, envíanos el comprobante por este medio. ¡Gracias!`;
            }
        }

        const chatId = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@c.us`;

        if (req.body.scheduledTime) {
            const { scheduleNewMessage } = require('./scheduledMessageService');
            const result = await scheduleNewMessage(client, chatId, message, req.body.scheduledTime);
            return res.json({ success: true, isScheduled: true, formattedTime: result.formattedTime, message: 'Mensaje programado con éxito' });
        }

        const { safeSend } = require('./billingService');
        await safeSend(null, message, chatId, client);

        res.json({ success: true, message: 'Message sent via WhatsApp' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, message: e.message });
    }
});

app.post('/api/admin/sales/create', async (req, res) => {
    try {
        const { phone, name, items, duration, total, isRenewal, paymentMethod, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const { recordNewSale } = require('./salesRegistryService');

        let subscriptionType = 'mensual';
        if (duration === '3') subscriptionType = 'trimestral';
        if (duration === '6') subscriptionType = 'semestral';
        if (duration === '12') subscriptionType = 'anual';

        const userState = {
            isRenewal: !!isRenewal,
            items: items.map(it => ({
                platform: { name: it.platformName },
                _rowNumber: it._rowNumber || it.index || null,
                correo: it.correo || null,
                contraseña: it.contraseña || null,
                pin: it.pin || null,
                deben: it.deben || null
            })),
            subscriptionType,
            nombre: name,
            total: parseFloat(total) || 0
        };

        const phoneId = phone.includes('@') ? phone : `${phone}@c.us`;
        const results = await recordNewSale(phoneId, userState, paymentMethod || "Web Admin", parseInt(duration) || null);

        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/match', async (req, res) => {
    try {
        const isp = req.query.isp || '';
        const { getNetflixMatchReport } = require('./adminService');
        const matchData = await getNetflixMatchReport(isp);
        res.json(matchData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

let probablyFinishedTickets = new Set();
let aiTicketsSummaries = new Map();
let classifiedTicketsCache = new Map(); // phone -> { lastMessage, state, summary }
let lastAiClassificationTime = 0;
const AI_CLASSIFICATION_INTERVAL = 45 * 1000; // run classification every 45 seconds

const AI_CACHE_FILE = path.join(__dirname, 'ticket_ai_cache.json');

function loadAiClassificationCache() {
    try {
        if (fs.existsSync(AI_CACHE_FILE)) {
            const raw = fs.readFileSync(AI_CACHE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.probablyFinished)) {
                probablyFinishedTickets = new Set(data.probablyFinished);
            }
            if (data.summaries && typeof data.summaries === 'object') {
                aiTicketsSummaries = new Map(Object.entries(data.summaries));
            }
            if (data.cache && typeof data.cache === 'object') {
                classifiedTicketsCache = new Map(Object.entries(data.cache));
            }
            console.log(`[AI Cache] 💾 ${classifiedTicketsCache.size} tickets cargados desde memoria persistente (disco).`);
        }
    } catch (err) {
        console.error('[AI Cache] Error cargando caché desde disco:', err.message);
    }
}

function saveAiClassificationCache() {
    try {
        const payload = {
            probablyFinished: Array.from(probablyFinishedTickets),
            summaries: Object.fromEntries(aiTicketsSummaries),
            cache: Object.fromEntries(classifiedTicketsCache)
        };
        fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        console.error('[AI Cache] Error guardando caché en disco:', err.message);
    }
}

// Cargar caché de tickets al inicializar el servidor
loadAiClassificationCache();

async function updateAiTicketsClassification() {
    try {
        if (!client || currentWhatsappStatus !== 'CONNECTED') {
            // Omitir clasificacion por IA si el bot no esta activo en WhatsApp
            return;
        }
        const now = Date.now();
        if (now - lastAiClassificationTime < AI_CLASSIFICATION_INTERVAL) return;
        lastAiClassificationTime = now;

        // Build list of active tickets and determine delta
        const activeTickets = [];
        const ticketsToClassify = [];
        const currentActivePhones = new Set();

        for (const [userId, state] of userStates.entries()) {
            if (!state) continue;
            const stateStr = typeof state === 'object' ? state.state : state;
            const pendingStates = ['waiting_human', 'awaiting_payment_confirmation', 'waiting_admin_confirmation'];
            if (!pendingStates.includes(stateStr)) continue;

            const phone = userId.replace('@c.us', '');
            currentActivePhones.add(phone);

            let lastMessage = typeof state === 'object' ? (state.lastMessage || "") : "";
            let lastMessageTime = typeof state === 'object' ? (state.lastMessageTime || null) : null;
            let summary = "";

            if (typeof state === 'object') {
                if (state.state === 'awaiting_payment_confirmation') {
                    summary = "💸 Validando Pago";
                } else if (state.state === 'waiting_human' && state.advisorReason) {
                    summary = `🚨 Motivo: "${state.advisorReason}"`;
                } else if (state.items && state.items.length > 0) {
                    const itemNames = state.items.map(it => it.platform?.name || it.platformName || '').filter(Boolean).join(', ');
                    summary = `🛒 Interés: ${itemNames}`;
                }
            }

            const timeDiff = lastMessageTime ? `${Math.round((now - lastMessageTime) / 60000)}m ago` : "unknown";
            const ticketData = {
                phone,
                nombre: (typeof state === 'object' ? state.nombre : 'Cliente') || 'Cliente',
                lastMessage: lastMessage.substring(0, 200),
                summary,
                state: stateStr,
                time: timeDiff
            };

            activeTickets.push(ticketData);

            // Compare with cache
            const cached = classifiedTicketsCache.get(phone);
            if (!cached || cached.lastMessage !== ticketData.lastMessage || cached.state !== ticketData.state || cached.summary !== ticketData.summary) {
                ticketsToClassify.push(ticketData);
            }
        }

        // Clean up stale cache items
        let cacheDirty = false;
        for (const cachedPhone of classifiedTicketsCache.keys()) {
            if (!currentActivePhones.has(cachedPhone)) {
                classifiedTicketsCache.delete(cachedPhone);
                probablyFinishedTickets.delete(cachedPhone);
                aiTicketsSummaries.delete(cachedPhone);
                cacheDirty = true;
            }
        }

        if (ticketsToClassify.length === 0) {
            if (cacheDirty) saveAiClassificationCache();
            console.log(`[AI Classification Cache] No changes in active tickets. Skipping LLM classification call.`);
            return;
        }

        console.log(`[AI Classification Cache] Classifying ${ticketsToClassify.length} new/changed tickets out of ${activeTickets.length} total active.`);

        const { callGemini } = require('./aiService');
        const prompt = `Analiza la siguiente lista de tickets de soporte técnico y ventas en formato JSON:
${JSON.stringify(ticketsToClassify, null, 2)}

Realiza dos tareas:
1. Determina cuáles de ellos están **probablemente terminados o solucionados** y ya no requieren atención inmediata de un asesor (ej. agradecimientos rápidos, respuestas afirmativas simples o inactividad tras resolver).
   *REGLAS MUY IMPORTANTES PARA DETERMINAR SI UN TICKET ESTÁ TERMINADO:*
   - Si un ticket tiene state "waiting_human" (en cola de espera de asesor humano), "awaiting_payment_confirmation" (esperando validación de pago) o "waiting_admin_confirmation", y el último mensaje es del cliente pidiendo ayuda, reclamando, saludando o consultando, NUNCA lo consideres como terminado. Estos tickets requieren atención obligatoria.
   - Solo puedes marcar como terminados (probablyFinished) aquellos tickets donde el cliente dice gracias, se despide, confirma que ya quedó solucionado, o tras una resolución explícita no ha vuelto a escribir nada relevante.
2. Genera para **CADA ticket** un resumen descriptivo en español de 3 a 5 palabras explicando el motivo real o falla técnica reportada basándote en su "lastMessage" o "summary" (ej. "Pide código de Disney", "Netflix caída de hogar", "Problema de facturación", "Pregunta por catálogo"). Si el "summary" ya contiene un motivo manual claro (como Pago o Interés), consérvalo.

Devuelve **únicamente** un objeto JSON estructurado así (sin marcas markdown de bloque):
{
  "probablyFinished": [],
  "summaries": {
    "573166568300": "Falla Netflix Hogar",
    "573185160611": "Solicita código Disney"
  }
}`;

        const responseJson = await callGemini(prompt, "Eres un analista experto de soporte técnico que resume problemas en 3 a 5 palabras.", true);
        const parsed = typeof responseJson === 'object' ? responseJson : JSON.parse(responseJson.replace(/```json/g, '').replace(/```/g, '').trim());

        if (parsed) {
            // Remove previous finished status for reclassified tickets before merging new results
            ticketsToClassify.forEach(t => {
                probablyFinishedTickets.delete(t.phone);
            });

            if (Array.isArray(parsed.probablyFinished)) {
                parsed.probablyFinished.forEach(p => probablyFinishedTickets.add(String(p)));
            }
            if (parsed.summaries && typeof parsed.summaries === 'object') {
                for (const [phone, sum] of Object.entries(parsed.summaries)) {
                    aiTicketsSummaries.set(phone, sum);
                }
            }

            // Update cache for these tickets
            ticketsToClassify.forEach(t => {
                classifiedTicketsCache.set(t.phone, {
                    lastMessage: t.lastMessage,
                    state: t.state,
                    summary: t.summary
                });
            });

            saveAiClassificationCache();
            console.log(`[AI Classification Cache] Re-classified ${ticketsToClassify.length} tickets. Cache size: ${classifiedTicketsCache.size}. Probably finished total: ${probablyFinishedTickets.size}`);
        }
    } catch (err) {
        console.error("[AI Classification] Error running AI batch classification:", err.message);
    }
}

app.get('/api/admin/tickets', async (req, res) => {
    try {
        // Run classification asynchronously in background
        updateAiTicketsClassification().catch(err => console.error("[AI Classification Async]", err));

        const showAllChats = req.query.allChats === 'true';
        let targetEntries = [];

        const botWidUser = (client && client.info && client.info.wid) ? client.info.wid.user : '3118587974';
        const isBotSender = (id) => {
            if (!id) return true;
            return id.includes('3118587974') || 
                   id.includes('269285859545110') || 
                   id.includes(':') || 
                   id.includes('@broadcast') || 
                   id.includes('@g.us') ||
                   (botWidUser && id.includes(botWidUser));
        };

        if (showAllChats) {
            let dbChats = [];
            try {
                const [rows] = await pool.query(`
                    SELECT chat_id, customer_phone, last_message_text, last_message_time 
                    FROM chats 
                    WHERE chat_id NOT LIKE '%3118587974%'
                      AND chat_id NOT LIKE '%269285859545110%'
                      AND chat_id NOT LIKE '%:%'
                      AND chat_id NOT LIKE '%@g.us'
                    ORDER BY last_message_time DESC 
                    LIMIT 150
                `);
                dbChats = rows;
            } catch (dbErr) {
                console.error("Error querying db chats:", dbErr.message);
            }

            targetEntries = dbChats.filter(row => !isBotSender(row.chat_id)).map(row => {
                const userId = row.chat_id;
                const state = userStates.get(userId) || { state: 'bot_active', lastMessage: row.last_message_text, lastMessageTime: row.last_message_time ? new Date(row.last_message_time).getTime() : null };
                return [userId, state];
            });
        } else {
            targetEntries = Array.from(userStates.entries()).map(([userId, state]) => {
                if (!state || isBotSender(userId)) return null;
                const stateStr = typeof state === 'object' ? state.state : state;
                const pendingStates = ['waiting_human', 'waiting_admin_confirmation'];
                if (!pendingStates.includes(stateStr)) return null;

                // Si el estado fue puesto por mensaje saliente del asesor (recordatorio/cobro manual)
                // y el cliente aun NO ha respondido (clientWaitingSince es null), no se suma a Tickets Libres
                if (typeof state === 'object' && state.waiting_human_mode === 'advisor' && !state.clientWaitingSince) {
                    return null;
                }

                return [userId, state];
            }).filter(Boolean);
        }

        // 1. Obtener dump de contactos de WhatsApp Web en UNA sola llamada Puppeteer
        const contactMap = new Map();
        if (client && client.pupPage) {
            try {
                const contacts = await Promise.race([
                    client.pupPage.evaluate(() => {
                        if (!window.Store || !window.Store.Contact) return [];
                        const all = window.Store.Contact._models || (window.Store.Contact.getModelsArray ? window.Store.Contact.getModelsArray() : []);
                        return all.map(c => {
                            const id = (c.id && (c.id._serialized || c.id.user || c.id)) || '';
                            const lid = (c.lid && (c.lid._serialized || c.lid.user || c.lid)) || '';
                            
                            let pn = '';
                            if (c.phoneNumber) pn = typeof c.phoneNumber === 'object' ? (c.phoneNumber.user || c.phoneNumber._serialized || '') : c.phoneNumber;
                            else if (c.pn) pn = typeof c.pn === 'object' ? (c.pn.user || c.pn._serialized || '') : c.pn;
                            else if (c.number) pn = c.number;
                            else if (c.formattedNumber) pn = c.formattedNumber;
                            else if (c.userid && !String(c.userid).includes('lid') && String(c.userid).length <= 12) pn = c.userid;
                            else if (c.__x_phoneNumber) pn = typeof c.__x_phoneNumber === 'object' ? (c.__x_phoneNumber.user || c.__x_phoneNumber._serialized || '') : c.__x_phoneNumber;
                            else if (c.__x_pn) pn = typeof c.__x_pn === 'object' ? (c.__x_pn.user || c.__x_pn._serialized || '') : c.__x_pn;
                            
                            if (!pn && window.Store.Lid && typeof window.Store.Lid.getPhoneNumber === 'function') {
                                try {
                                    const lidObj = c.lid || c.id;
                                    const resLid = window.Store.Lid.getPhoneNumber(lidObj);
                                    if (resLid) pn = typeof resLid === 'object' ? (resLid.user || resLid._serialized || '') : resLid;
                                } catch(e) {}
                            }

                            const name = c.name || c.pushname || c.shortName || '';
                            return { id, lid, pn: String(pn || ''), name };
                        });
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout contacts dump")), 2000))
                ]).catch(() => []);

                for (const c of contacts) {
                    const cleanLid = c.lid ? c.lid.split('@')[0].replace(/\D/g, '') : '';
                    const cleanId = c.id ? c.id.split('@')[0].replace(/\D/g, '') : '';
                    if (cleanLid) contactMap.set(cleanLid, c);
                    if (cleanId) contactMap.set(cleanId, c);
                }
            } catch(e) {}
        }

        // 2. Obtener datos de Excel en memoria UNA sola vez
        const { fetchRawData } = require('./apiService');
        const excelRows = await fetchRawData().catch(() => []);

        const isInvalidName = (name) => {
            if (!name) return true;
            const clean = String(name).trim();
            if (clean === "Cliente" || clean === "Cliente WhatsApp") return true;
            if (clean.startsWith("Cliente ") && /^\d+$/.test(clean.substring(8).trim())) return true;
            if (/^\+?\d[\d\s\-]+$/.test(clean)) return true;
            return false;
        };

        const ticketsPromises = targetEntries.map(async ([userId, state]) => {
            const cleanDigits = userId.replace(/\D/g, '');
            const isLid = userId.includes('@lid') || (!cleanDigits.startsWith('57') && cleanDigits.length > 10) || cleanDigits.length > 12;

            // 1. Obtener y resolver el NOMBRE y TELÉFONO del contacto
            let resolvedName = typeof state === 'object' ? state.nombre : null;
            let resolvedPhoneFromLid = null;
            const contactInfo = contactMap.get(cleanDigits);

            if (contactInfo) {
                const nameCand = contactInfo.name || contactInfo.pushname || contactInfo.shortName;
                if (!isInvalidName(nameCand)) resolvedName = nameCand;
                if (contactInfo.pn) {
                    const cleanPn = contactInfo.pn.replace(/\D/g, '');
                    if (cleanPn.length >= 7 && cleanPn.length <= 12 && cleanPn !== cleanDigits) {
                        resolvedPhoneFromLid = cleanPn;
                    }
                }
            }

            if (client && client.info && (isInvalidName(resolvedName) || !resolvedPhoneFromLid)) {
                try {
                    const contact = await Promise.race([
                        client.getContactById(userId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000))
                    ]).catch(() => null);
                    if (contact) {
                        const nameCandidate = contact.name || contact.pushname;
                        if (!isInvalidName(nameCandidate)) {
                            resolvedName = nameCandidate;
                        }
                        if (!resolvedPhoneFromLid && contact.number) {
                            const cleanCNum = String(contact.number).replace(/\D/g, '');
                            if (cleanCNum.length >= 7 && cleanCNum.length <= 12 && cleanCNum !== cleanDigits) {
                                resolvedPhoneFromLid = cleanCNum;
                            }
                        }
                        if (!resolvedPhoneFromLid && typeof contact.getFormattedNumber === 'function') {
                            try {
                                const formatted = await contact.getFormattedNumber();
                                const cleanFNum = String(formatted).replace(/\D/g, '');
                                if (cleanFNum.length >= 7 && cleanFNum.length <= 12 && cleanFNum !== cleanDigits) {
                                    resolvedPhoneFromLid = cleanFNum;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) { }
            }

            if (isInvalidName(resolvedName)) {
                try {
                    const [nameMsgRows] = await pool.query(
                        'SELECT body FROM messages WHERE chat_id = ? ORDER BY id ASC LIMIT 10',
                        [userId]
                    );
                    for (const row of nameMsgRows) {
                        const txt = row.body || '';
                        const mMatch = txt.match(/(?:hola|dia|tarde|noches|buen d[ií]a|gracias)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]{3,20})/i);
                        if (mMatch && !isInvalidName(mMatch[1])) {
                            resolvedName = mMatch[1].charAt(0).toUpperCase() + mMatch[1].slice(1).toLowerCase();
                            break;
                        }
                    }
                } catch(e) {}
            }

            if (isInvalidName(resolvedName)) {
                resolvedName = "Cliente";
            }

            // 2. === Resolver LID a teléfono real ===
            let phone = userId.replace('@c.us', '').replace('@lid', '');

            if (isLid) {
                // A. Buscar en userStates por si ya tiene un teléfono mapeado valido (no LID)
                const stObj = typeof state === 'object' ? state : null;
                if (stObj && stObj.realPhone) {
                    const cleanRP = String(stObj.realPhone).replace(/\D/g, '');
                    if (cleanRP.length >= 7 && cleanRP.length <= 12 && cleanRP !== cleanDigits) {
                        resolvedPhoneFromLid = cleanRP;
                    }
                }
                // B. Buscar en la tabla chats
                if (!resolvedPhoneFromLid) {
                    try {
                        const [chatMapRows] = await pool.query(
                            'SELECT customer_phone FROM chats WHERE (chat_id = ? OR chat_id LIKE ?) AND customer_phone IS NOT NULL LIMIT 1',
                            [userId, `%${cleanDigits}%`]
                        );
                        if (chatMapRows.length > 0 && chatMapRows[0].customer_phone) {
                            const cp = chatMapRows[0].customer_phone.replace(/\D/g, '');
                            if (cp && cp.length >= 7 && cp.length <= 12 && cp !== cleanDigits) {
                                resolvedPhoneFromLid = cp;
                            }
                        }
                    } catch (e) { }
                }
                // C. Buscar en contactMap de WhatsApp Web
                if (!resolvedPhoneFromLid && contactInfo) {
                    if (contactInfo.pn) {
                        const cleanPn = contactInfo.pn.replace(/\D/g, '');
                        if (cleanPn.length >= 7 && cleanPn.length <= 12) {
                            resolvedPhoneFromLid = cleanPn;
                        }
                    }
                    if (!resolvedPhoneFromLid && contactInfo.id && !contactInfo.id.includes('lid')) {
                        const cleanId = contactInfo.id.replace(/\D/g, '');
                        if (cleanId.length >= 7 && cleanId.length <= 12) {
                            resolvedPhoneFromLid = cleanId;
                        }
                    }
                }


                // E.2 Extraer teléfono de 10 dígitos (ej: 3227922392) directamente del texto de los mensajes recientes en BD
                if (!resolvedPhoneFromLid) {
                    try {
                        const [msgTextRows] = await pool.query(
                            "SELECT body FROM messages WHERE (chat_id = ? OR sender_id = ?) AND body REGEXP '3[0-9]{9}' ORDER BY created_at DESC LIMIT 5",
                            [userId, userId]
                        );
                        if (msgTextRows && msgTextRows.length > 0) {
                            for (const mRow of msgTextRows) {
                                const pMatch = (mRow.body || '').match(/3\d{9}/);
                                if (pMatch) {
                                    const extracted = '57' + pMatch[0];
                                    console.log(`[LID Resolution API] 📱 Número +${extracted} extraído del texto de los mensajes para ${userId}`);
                                    resolvedPhoneFromLid = extracted;
                                    break;
                                }
                            }
                        }
                    } catch (e) {}
                }

                // E.3 Intentar resolver con API interna de Puppeteer de WhatsApp Web
                if (!resolvedPhoneFromLid) {
                    try {
                        const { resolveRealPhoneFromJid } = require('./billingService');
                        const pFound = await resolveRealPhoneFromJid(userId, client, resolvedName);
                        if (pFound && pFound.replace(/\D/g, '').length >= 7 && pFound.replace(/\D/g, '').length <= 13 && !pFound.includes('3118587974')) {
                            resolvedPhoneFromLid = pFound.replace(/\D/g, '');
                        }
                    } catch(e) {}
                }

                // E. Guardar en base de datos para futuras consultas
                if (resolvedPhoneFromLid) {
                    pool.query('UPDATE chats SET customer_phone = ? WHERE chat_id = ?', [resolvedPhoneFromLid, userId]).catch(() => {});
                }

                const botNum = (client && client.info && client.info.wid) ? client.info.wid.user : '3118587974';
                if (resolvedPhoneFromLid && resolvedPhoneFromLid !== '573118587974' && resolvedPhoneFromLid !== botNum) {
                    phone = String(resolvedPhoneFromLid).replace(/\D/g, '');
                    if (typeof state === 'object') {
                        state.realPhone = phone;
                    }
                } else {
                    phone = userId.replace('@c.us', '').replace('@lid', '');
                }
            }

            const displayPhone = phone; // Este es el número limpio para mostrar
            const stateStr = typeof state === 'object' ? state?.state : state;
            let lastMessage = typeof state === 'object' ? (state.lastMessage || "") : "";
            let lastMessageTime = typeof state === 'object' ? (state.lastMessageTime || null) : null;
            let lastMessageFromMe = false;

            // Try to fetch last message from Puppeteer, but with a very short timeout and in parallel
            try {
                if (client && client.info) {
                    const chat = await Promise.race([
                        client.getChatById(userId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout client.getChatById")), 1500))
                    ]);
                    const messages = await Promise.race([
                        chat.fetchMessages({ limit: 1 }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout chat.fetchMessages")), 1000))
                    ]);
                    if (messages && messages.length > 0) {
                        lastMessage = messages[0].body || "";
                        lastMessageTime = messages[0].timestamp * 1000;
                        lastMessageFromMe = messages[0].fromMe;
                    }
                }
            } catch (err) {
                // Keep the cached values on timeout
            }

            let accounts = [];

            if (isInvalidName(resolvedName)) {
                try {
                    const { getAccountsByPhone } = require('./apiService');
                    accounts = await getAccountsByPhone(displayPhone);
                    if (accounts && accounts.length > 0) {
                        const firstAcc = accounts[0];
                        const first = (typeof (firstAcc.Nombre || firstAcc.nombre) === 'string') ? (firstAcc.Nombre || firstAcc.nombre) : "";
                        const last = (typeof (firstAcc.apellido || firstAcc.Apellido) === 'string') ? (firstAcc.apellido || firstAcc.Apellido) : "";
                        if (first && first.trim()) {
                            resolvedName = `${first} ${last}`.trim();
                        }
                    }
                } catch (err) { }
            }

            if (isInvalidName(resolvedName)) {
                try {
                    const [custRows] = await pool.query("SELECT fullname FROM customers WHERE phone = ?", [displayPhone]);
                    if (custRows.length > 0 && custRows[0].fullname) {
                        const fn = custRows[0].fullname;
                        if (!isInvalidName(fn)) {
                            resolvedName = fn;
                        }
                    }
                } catch (err) { }
            }

            if (!isInvalidName(resolvedName) && typeof state === 'object') {
                state.nombre = resolvedName;
                userStates.set(userId, state);
            }

            let summary = "";
            if (typeof state === 'object') {
                if (state.state === 'awaiting_payment_confirmation') {
                    summary = `💰 Pago: ${state.bank || 'N/A'} - $${state.amount || 'N/A'}`;
                } else if (state.advisorReason) {
                    summary = `🚨 Motivo: "${state.advisorReason}"`;
                } else if (state.items && state.items.length > 0) {
                    const itemNames = state.items.map(it => {
                        const platName = it.platform?.name || it.platformName || '';
                        const planName = it.chosenPlan?.name || '';
                        return planName ? `${platName} (${planName})` : platName;
                    }).filter(Boolean).join(', ');
                    summary = `🛒 Interés: ${itemNames} - Total: $${state.total || 'N/A'}`;
                }
            }

            // Fallback: If no manual summary exists, use the dynamic AI summary generated by Gemini
            if (!summary && aiTicketsSummaries.has(displayPhone)) {
                summary = `🤖 AI: ${aiTicketsSummaries.get(displayPhone)}`;
            }

            const { getQueuePosition } = require('./supportScheduleService');
            const queuePosition = getQueuePosition(userId, userStates);

            const isProbablyFinished = probablyFinishedTickets.has(displayPhone);

            return {
                userId,
                phone: displayPhone,
                nombre: resolvedName,
                state: stateStr,
                total: typeof state === 'object' ? state.total : null,
                saldo: typeof state === 'object' ? state.saldo : null,
                lastHumanInteraction: typeof state === 'object' ? state.lastHumanInteraction : null,
                agent: typeof state === 'object' ? state.agent : null,
                lastMessage,
                lastMessageTime,
                lastMessageFromMe,
                isProbablyFinished,
                summary,
                waitingHumanMode: typeof state === 'object' ? (state.waiting_human_mode || 'bot') : 'bot',
                queuePosition,
                accounts: accounts.map(a => ({
                    streaming: a.Streaming || a.streaming || '',
                    correo: a.correo || a.Correo || '',
                    nombrePerfil: a.Nombre || a.nombre || ''
                }))
            };
        });

        const resolvedTickets = await Promise.all(ticketsPromises);

        // Deduplicar tarjetas por teléfono y por nombre exacto del cliente
        const uniqueMap = new Map();
        const nameToPhoneMap = new Map();

        // 1. Mapear nombres a números de teléfono reales
        for (const t of resolvedTickets.filter(Boolean)) {
            const cleanP = t.phone ? t.phone.replace(/\D/g, '') : '';
            if (cleanP && !t.userId.includes('@lid') && cleanP.length >= 10 && t.nombre && t.nombre !== 'Cliente') {
                nameToPhoneMap.set(t.nombre.toLowerCase().trim(), cleanP);
            }
        }

        // 2. Deduplicar
        for (const t of resolvedTickets.filter(Boolean)) {
            let cleanP = t.phone ? t.phone.replace(/\D/g, '') : t.userId;
            const normName = (t.nombre || '').toLowerCase().trim();

            if (t.userId.includes('@lid') && normName && nameToPhoneMap.has(normName)) {
                cleanP = nameToPhoneMap.get(normName);
                t.phone = cleanP;
                pool.query('UPDATE chats SET customer_phone = ? WHERE chat_id = ?', [cleanP, t.userId]).catch(() => {});
            }

            if (!uniqueMap.has(cleanP)) {
                uniqueMap.set(cleanP, t);
            } else {
                const prev = uniqueMap.get(cleanP);
                if ((prev.userId.includes('@lid') || prev.nombre === 'Cliente') && (!t.userId.includes('@lid') || t.nombre !== 'Cliente')) {
                    uniqueMap.set(cleanP, t);
                }
            }
        }

        res.json(Array.from(uniqueMap.values()));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tickets/claim', async (req, res) => {
    try {
        const { phone, agent, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        const currentState = userStates.get(userId);

        if (!currentState) {
            return res.status(404).json({ success: false, message: 'No active state found for this user' });
        }

        let updatedState = {};
        const newMode = agent ? 'advisor' : 'bot';
        if (typeof currentState === 'string') {
            updatedState = { state: currentState, agent: agent, waiting_human_mode: newMode, claimedAt: agent ? Date.now() : null };
        } else {
            updatedState = { ...currentState, agent: agent, waiting_human_mode: newMode, claimedAt: agent ? Date.now() : null };
        }

        userStates.set(userId, updatedState);
        res.json({ success: true, message: agent ? `Ticket asignado a ${agent}` : 'Ticket liberado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tickets/update-mode', async (req, res) => {
    try {
        const { phone, mode, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';

        if (mode === 'bot') {
            userStates.delete(userId);
            return res.json({ success: true, message: 'Modo actualizado a bot (chat liberado y bot reactivado)' });
        }

        const currentState = userStates.get(userId);

        if (!currentState) {
            userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: mode, claimedAt: mode === 'advisor' ? Date.now() : null });
            return res.json({ success: true, message: `Estado creado y modo configurado a ${mode}` });
        }

        let updatedState = {};
        if (typeof currentState === 'string') {
            updatedState = { state: currentState, waiting_human_mode: mode, claimedAt: mode === 'advisor' ? Date.now() : null };
        } else {
            updatedState = { ...currentState, waiting_human_mode: mode, claimedAt: mode === 'advisor' ? Date.now() : null };
        }

        if (mode === 'advisor') {
            updatedState.lastHumanInteraction = Date.now();
        }

        userStates.set(userId, updatedState);
        res.json({ success: true, message: `Modo actualizado a ${mode}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tickets/update-state', async (req, res) => {
    try {
        const { phone, state, total, saldo, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el teléfono' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        const currentState = userStates.get(userId) || {};

        let updatedState = { ...currentState };
        if (state !== undefined) updatedState.state = state;
        if (total !== undefined) updatedState.total = total === null ? null : parseInt(total) || 0;
        if (saldo !== undefined) updatedState.saldo = saldo === null ? null : parseInt(saldo) || 0;

        userStates.set(userId, updatedState);
        res.json({ success: true, message: 'Estado del ticket actualizado con éxito', state: updatedState });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/tickets/release', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        userStates.delete(userId);
        res.json({ success: true, message: 'Bot reactivado y chat liberado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tickets/force-bot-reply', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (password !== 'admin123' && password !== 'admin') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const cleanPhone = (phone || '').replace(/\D/g, '').slice(-10);
        const userId = phone.includes('@') ? phone : (cleanPhone ? (cleanPhone.length === 10 ? '57' + cleanPhone : cleanPhone) + '@c.us' : phone);

        // Resetear estado del bot y marcar isForceBot para procesar el contexto conversacional sin bloqueo por horario
        userStates.set(userId, { state: 'idle', isForceBot: true });
        if (cleanPhone) {
            userStates.set(`57${cleanPhone}@c.us`, { state: 'idle', isForceBot: true });
            userStates.set(`${cleanPhone}@c.us`, { state: 'idle', isForceBot: true });
        }

        let rawMessages = [];
        let chat = await client.getChatById(userId).catch(() => null);
        if (!chat && cleanPhone) {
            chat = await client.getChatById(`57${cleanPhone}@c.us`).catch(() => null);
        }

        if (chat) {
            await chat.syncHistory().catch(() => { });
            rawMessages = await chat.fetchMessages({ limit: 15 }).catch(() => []);
        }

        // Fallback a Base de Datos MariaDB si Puppeteer no tiene mensajes en caché
        if (!rawMessages || rawMessages.length === 0) {
            const { pool } = require('./database');
            const [dbMsgs] = await pool.query(
                "SELECT * FROM messages WHERE chat_id LIKE ? OR sender_id LIKE ? ORDER BY created_at DESC LIMIT 15",
                [`%${cleanPhone}%`, `%${cleanPhone}%`]
            );

            if (dbMsgs && dbMsgs.length > 0) {
                const targetChatId = dbMsgs[0].chat_id || userId;
                rawMessages = dbMsgs.reverse().map(m => ({
                    id: { _serialized: m.message_id || `msg_${m.id}` },
                    from: m.sender_id || targetChatId,
                    to: m.chat_id || targetChatId,
                    body: m.body || '',
                    fromMe: m.is_from_me === 1,
                    timestamp: Math.floor(new Date(m.created_at).getTime() / 1000),
                    reply: async (text) => client.sendMessage(targetChatId, text),
                    getContact: async () => ({ number: cleanPhone, name: m.sender_name || cleanPhone })
                }));
            }
        }

        // Buscar últimos mensajes del cliente
        const clientMessages = [];
        if (rawMessages && rawMessages.length > 0) {
            for (let i = rawMessages.length - 1; i >= 0; i--) {
                const m = rawMessages[i];
                if (!m.fromMe && !m.body.includes('🤖')) {
                    clientMessages.unshift(m);
                } else if (clientMessages.length > 0) {
                    break;
                }
            }
        }

        const messagesToProcess = clientMessages.length > 0 ? clientMessages : (rawMessages.length > 0 ? [rawMessages[rawMessages.length - 1]] : []);

        if (messagesToProcess.length > 0) {
            console.log(`[Force Bot Reply] 🚀 Procesando ${messagesToProcess.length} mensajes para @${cleanPhone || phone}`);
            processIncomingMessage(messagesToProcess).catch(err => {
                console.error('[Force Bot Reply] Error en procesamiento:', err.message);
            });
        } else {
            // Si no hay mensajes en ningún lado, enviar saludo/ayuda inicial del bot
            console.log(`[Force Bot Reply] Enviando respuesta inicial por defecto para @${cleanPhone || phone}`);
            const targetJid = userId;
            await client.sendMessage(targetJid, `🤖 ¡Hola! 👋 ¿En qué te puedo colaborar el día de hoy? Cuéntame tu duda o envíame foto de lo que necesitas. 😊`);
        }

        res.json({ success: true, message: 'Respuesta del bot forzada y reactivada con éxito' });
    } catch (e) {
        console.error('[Force Bot Reply Error]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/tickets/resolve', async (req, res) => {
    try {
        const { phone, password, resolveAll, agentName: bodyAgentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const cleanPhone = phone.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
        const userId = cleanPhone + '@c.us';
        const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

        // 1. Obtener estado previo del ticket que se está resolviendo
        const targetState = userStates.get(userId) || userStates.get(cleanPhone + '@lid') || userStates.get(cleanPhone + '@c.us') || {};
        const targetRealPhone = targetState.realPhone ? String(targetState.realPhone).replace(/\D/g, '') : '';
        const targetNombre = (targetState.nombre || '').toLowerCase().trim();

        // Obtener todos los posibles JIDs asociados a este teléfono (LID y teléfono real)
        const possibleJids = [cleanPhone + '@c.us', cleanPhone + '@lid'];
        if (targetRealPhone) {
            possibleJids.push(targetRealPhone + '@c.us', targetRealPhone + '@lid');
        }

        let resolvedDbPhone = '';
        const isLid = cleanPhone.length > 12 || (!cleanPhone.startsWith('57') && cleanPhone.length > 10);
        if (isLid) {
            try {
                const [chatRows] = await pool.query(
                    'SELECT customer_phone FROM chats WHERE chat_id = ? OR chat_id = ? LIMIT 1',
                    [cleanPhone + '@lid', cleanPhone + '@c.us']
                );
                if (chatRows.length > 0 && chatRows[0].customer_phone) {
                    resolvedDbPhone = chatRows[0].customer_phone.replace(/\D/g, '');
                    possibleJids.push(resolvedDbPhone + '@c.us', resolvedDbPhone + '@lid');
                }
            } catch (e) { }
        } else {
            try {
                const [chatRows] = await pool.query(
                    'SELECT chat_id FROM chats WHERE customer_phone = ? OR customer_phone LIKE ?',
                    [cleanPhone, `%${cleanPhone.slice(-10)}%`]
                );
                chatRows.forEach(row => {
                    if (row.chat_id) possibleJids.push(row.chat_id);
                });
            } catch (e) { }
        }

        const canonicalPhone = resolvedDbPhone || (targetRealPhone.length >= 10 && targetRealPhone.length <= 12 ? targetRealPhone : '') || (cleanPhone.length >= 10 && cleanPhone.length <= 12 ? cleanPhone : '');

        const phoneVariants = new Set([cleanPhone, targetRealPhone, resolvedDbPhone, canonicalPhone].filter(Boolean));
        phoneVariants.forEach(p => {
            if (p.length >= 10) phoneVariants.add(p.slice(-10));
        });

        // Emparejar todos los JIDs y LIDs en userStates que correspondan a este teléfono O nombre
        for (const [sKey, sVal] of Array.from(userStates.entries())) {
            if (!sVal) continue;
            const sClean = sKey.replace(/\D/g, '');
            const sReal = sVal.realPhone ? String(sVal.realPhone).replace(/\D/g, '') : '';
            const sPhone = sVal.phone ? String(sVal.phone).replace(/\D/g, '') : '';
            const sChatJid = sVal.chatJid ? String(sVal.chatJid).replace(/\D/g, '') : '';
            const sNombre = (sVal.nombre || '').toLowerCase().trim();

            let matched = false;
            for (const pVar of phoneVariants) {
                if (
                    sClean === pVar || 
                    sReal === pVar || 
                    sPhone === pVar || 
                    sChatJid === pVar ||
                    (pVar.length >= 7 && (sClean.includes(pVar) || sReal.includes(pVar) || sPhone.includes(pVar) || sChatJid.includes(pVar)))
                ) {
                    matched = true;
                    break;
                }
            }

            // Coincidencia por nombre exacto si el nombre no es genérico
            if (!matched && targetNombre && targetNombre !== 'cliente' && targetNombre !== 'cliente whatsapp') {
                if (sNombre === targetNombre) {
                    matched = true;
                }
            }

            if (matched) {
                possibleJids.push(sKey);
                // Si es una clave LID o duplicada huérfana, eliminarla de inmediato
                if (sKey.includes('@lid') || sClean.length > 12) {
                    userStates.delete(sKey);
                }
            }
        }
        if (canonicalPhone) {
            possibleJids.push(canonicalPhone + '@c.us');
        }
        const uniqueJids = Array.from(new Set(possibleJids));

        // Obtener correos asociados a este teléfono
        let targetEmails = [];
        try {
            const { getAccountsByPhone } = require('./apiService');
            const userAccs = await getAccountsByPhone(cleanPhone);
            targetEmails = userAccs.map(a => String(a.correo || a.Correo || '').toLowerCase().trim()).filter(Boolean);
        } catch (e) {
            console.error('[Tickets Resolve] Error obteniendo cuentas para:', cleanPhone, e.message);
        }

        // Helper para resolver el nombre real del cliente
        const getRealCustomerName = async (tgtPhone, defaultName) => {
            if (defaultName && defaultName !== 'Cliente WhatsApp') return defaultName;
            try {
                const { searchContactByPhone } = require('./googleContactsService');
                const matchedContactName = await searchContactByPhone(tgtPhone).catch(() => null);
                if (matchedContactName) return matchedContactName;

                const { getAccountsByPhone } = require('./apiService');
                const userAccs = await getAccountsByPhone(tgtPhone);
                if (userAccs.length > 0) {
                    const rowWithName = userAccs.find(a => a.Nombre || a.nombre);
                    if (rowWithName) return rowWithName.Nombre || rowWithName.nombre;
                }
            } catch (e) {
                console.error('[Resolve Name Helper] Error:', e.message);
            }
            return 'Cliente WhatsApp';
        };

        // Resolver el ticket actual
        const stateData = userStates.get(userId) || {};
        const agentName = bodyAgentName || stateData.agent || 'Bot / Sistema';
        const customerName = await getRealCustomerName(cleanPhone, stateData.nombre);
        const category = stateData.category || (stateData.churnPlatforms ? 'Corte / Churn' : (stateData.isRenewal ? 'Renovación / Cobro' : 'Atención General'));
        const claimedAtDate = stateData.claimedAt ? new Date(stateData.claimedAt) : null;
        const durationSeconds = stateData.claimedAt ? Math.round((Date.now() - stateData.claimedAt) / 1000) : 0;

        // Log resolved ticket con categoría y tiempo de resolución
        try {
            await pool.query(
                'INSERT INTO resolved_tickets_log (phone, customerName, agent, category, claimedAt, durationSeconds) VALUES (?, ?, ?, ?, ?, ?)',
                [cleanPhone, customerName, agentName, category, claimedAtDate, durationSeconds]
            );
        } catch (logErr) {
            console.error('[Resolved Log] Error logging resolved ticket:', logErr.message);
        }

        // Actualizar el estado de los tickets en la base de datos MariaDB
        try {
            await pool.query(
                'UPDATE tickets SET status = "resolved", updated_at = NOW() WHERE chat_id IN (?) OR chat_id LIKE ?',
                [uniqueJids, `%${last10}%`]
            );
            await pool.query(
                'UPDATE chats SET status = "bot", updated_at = NOW() WHERE chat_id IN (?) OR customer_phone LIKE ?',
                [uniqueJids, `%${last10}%`]
            );
        } catch (dbErr) {
            console.error('[Tickets DB Resolve] Error actualizando tabla tickets en MariaDB:', dbErr.message);
        }

        for (const targetJid of uniqueJids) {
            const curState = userStates.get(targetJid) || {};
            userStates.set(targetJid, {
                ...(typeof curState === 'object' ? curState : { state: curState }),
                state: 'resolved',
                agent: agentName,
                resolvedAt: Date.now(),
                botMuted: false
            });
            const cleanTarget = targetJid.replace('@c.us', '').replace('@lid', '');
            probablyFinishedTickets.delete(cleanTarget);
            probablyFinishedTickets.delete(cleanPhone);
        }

        // Auto-resolver tickets de otras personas que tengan las mismas cuentas/correos
        let resolvedOthersCount = 0;
        if (resolveAll && targetEmails.length > 0) {
            const { getAccountsByPhone } = require('./apiService');
            for (const [otherUserId, otherState] of userStates.entries()) {
                if (!otherState) continue;
                const otherStateStr = typeof otherState === 'object' ? otherState.state : otherState;
                if (otherStateStr === 'waiting_human' && otherUserId !== userId) {
                    const otherPhone = otherUserId.replace('@c.us', '');
                    try {
                        const otherAccs = await getAccountsByPhone(otherPhone);
                        const hasSharedEmail = otherAccs.some(a => {
                            const email = (a.correo || a.Correo || '').toLowerCase().trim();
                            return email && targetEmails.includes(email);
                        });
                        if (hasSharedEmail) {
                            const otherStateData = typeof otherState === 'object' ? otherState : { state: otherState };
                            const otherAgentName = bodyAgentName || otherStateData.agent || 'Bot / Sistema';
                            const otherCustomerName = await getRealCustomerName(otherPhone, otherStateData.nombre);

                            try {
                                await pool.query(
                                    'INSERT INTO resolved_tickets_log (phone, customerName, agent) VALUES (?, ?, ?)',
                                    [otherPhone, otherCustomerName, otherAgentName]
                                );
                            } catch (logErr) { }

                            userStates.set(otherUserId, {
                                ...otherStateData,
                                state: 'resolved',
                                agent: otherAgentName,
                                resolvedAt: Date.now(),
                                botMuted: false
                            });
                            resolvedOthersCount++;
                        }
                    } catch (e) {
                        console.error('[Tickets Resolve] Error al emparejar otro teléfono:', otherPhone, e.message);
                    }
                }
            }
        }

        saveUserStates();
        console.log(`[Tickets Resolve] ✅ Ticket para ${cleanPhone} (y ${uniqueJids.length} JIDs asociados) resuelto exitosamente.`);

        let message = 'Ticket resuelto y bot reactivado';
        if (resolvedOthersCount > 0) {
            message += `. También se resolvieron automáticamente ${resolvedOthersCount} ticket(s) con la misma cuenta compartida.`;
        }

        res.json({ success: true, message });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === ENDPOINT DE MÉTRICAS DE PRODUCTIVIDAD Y DESEMPEÑO DE ASESORES ===
app.get('/api/admin/metrics/agent-performance', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let query = `SELECT id, phone, customerName, agent, category, claimedAt, durationSeconds, resolvedAt FROM resolved_tickets_log`;
        let params = [];

        if (startDate && endDate) {
            query += ` WHERE resolvedAt BETWEEN ? AND ?`;
            params.push(startDate + ' 00:00:00', endDate + ' 23:59:59');
        }

        query += ` ORDER BY resolvedAt DESC LIMIT 500`;

        const [rows] = await pool.query(query, params);

        const agentStats = {};
        rows.forEach(r => {
            const agent = r.agent || 'Sin Asesor';
            if (!agentStats[agent]) {
                agentStats[agent] = {
                    agentName: agent,
                    totalResolved: 0,
                    categories: {},
                    totalDurationSeconds: 0,
                    avgDurationSeconds: 0
                };
            }

            agentStats[agent].totalResolved++;
            const cat = r.category || 'Atención General';
            agentStats[agent].categories[cat] = (agentStats[agent].categories[cat] || 0) + 1;

            if (r.durationSeconds > 0) {
                agentStats[agent].totalDurationSeconds += r.durationSeconds;
            }
        });

        Object.values(agentStats).forEach(stat => {
            if (stat.totalResolved > 0 && stat.totalDurationSeconds > 0) {
                stat.avgDurationSeconds = Math.round(stat.totalDurationSeconds / stat.totalResolved);
            }
        });

        res.json({
            success: true,
            totalLogs: rows.length,
            agentStats: Object.values(agentStats),
            logs: rows
        });
    } catch (e) {
        console.error('[Metrics Error]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/tickets/archive', async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        userStates.delete(userId);
        return res.json({ success: true, message: 'Ticket archivado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/tickets/create', express.json(), async (req, res) => {
    try {
        const { phone, name, reason, agentName, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });

        // Clean and format phone number to JID format
        const cleanPhone = phone.replace(/\D/g, '');
        const jid = `${cleanPhone}@c.us`;

        // Check if there is already a state, or create one
        const existingState = userStates.get(jid) || {};

        // Try to resolve name from accounts or contacts if not provided
        let resolvedName = name || existingState.nombre;
        if (!resolvedName || resolvedName === 'Cliente' || resolvedName === 'Cliente WhatsApp') {
            try {
                const { getAccountsByPhone } = require('./apiService');
                const accounts = await getAccountsByPhone(cleanPhone);
                if (accounts && accounts.length > 0) {
                    const first = accounts[0].Nombre || accounts[0].nombre || "";
                    const last = accounts[0].apellido || accounts[0].Apellido || "";
                    resolvedName = `${first} ${last}`.trim();
                }
            } catch (err) { }
            if (!resolvedName) {
                try {
                    const { searchContactByPhone } = require('./googleContactsService');
                    resolvedName = await searchContactByPhone(cleanPhone).catch(() => null);
                } catch (e) { }
            }
        }
        if (!resolvedName) {
            resolvedName = `Cliente ${cleanPhone}`;
        }

        const newState = {
            ...existingState,
            state: 'waiting_human',
            agent: agentName || null,
            nombre: resolvedName,
            lastMessage: 'Chat iniciado por asesor',
            lastMessageTime: Date.now(),
            advisorReason: reason || 'Contacto directo'
        };

        userStates.set(jid, newState);

        // Intenta silenciar las respuestas del bot
        try {
            await pool.query('INSERT INTO user_modes (phone, mode) VALUES (?, ?) ON DUPLICATE KEY UPDATE mode = ?', [cleanPhone, 'human', 'human']);
        } catch (e) { }

        res.json({
            success: true,
            message: 'Ticket creado y chat iniciado correctamente',
            ticket: {
                userId: jid,
                phone: cleanPhone,
                nombre: resolvedName,
                state: 'waiting_human',
                agent: agentName || null,
                lastMessage: 'Chat iniciado por asesor',
                lastMessageTime: Date.now(),
                summary: `🚨 Motivo: "${reason || 'Contacto directo'}"`,
                accounts: []
            }
        });
    } catch (e) {
        console.error('[Create Ticket] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/tickets/metrics', async (req, res) => {
    try {
        const [summary] = await pool.query(`
            SELECT agent, COUNT(*) as count 
            FROM resolved_tickets_log 
            GROUP BY agent 
            ORDER BY count DESC
        `);

        const [summaryToday] = await pool.query(`
            SELECT agent, COUNT(*) as count 
            FROM resolved_tickets_log 
            WHERE DATE(DATE_SUB(resolvedAt, INTERVAL 5 HOUR)) = DATE(DATE_SUB(NOW(), INTERVAL 5 HOUR))
            GROUP BY agent 
            ORDER BY count DESC
        `);

        const [weeklyFlow] = await pool.query(`
            SELECT 
                DATE_FORMAT(DATE_SUB(resolvedAt, INTERVAL 5 HOUR), '%d/%m') as day_label, 
                agent,
                COUNT(*) as count 
            FROM resolved_tickets_log 
            WHERE resolvedAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(DATE_SUB(resolvedAt, INTERVAL 5 HOUR)), day_label, agent
            ORDER BY DATE(DATE_SUB(resolvedAt, INTERVAL 5 HOUR)) ASC, count DESC
        `);

        const [recent] = await pool.query(`
            SELECT phone, customerName, agent, resolvedAt 
            FROM resolved_tickets_log 
            ORDER BY resolvedAt DESC 
            LIMIT 100
        `);

        res.json({ success: true, summary, summaryToday, recent, weeklyFlow });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to read manual stock/platform availability configuration
app.get('/api/admin/availability', (req, res) => {
    try {
        const { getAvailabilityConfig } = require('./availabilityService');
        const config = getAvailabilityConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to write manual stock/platform availability configuration
app.post('/api/admin/availability/save', (req, res) => {
    try {
        const { config, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config || typeof config !== 'object') return res.status(400).json({ success: false, message: 'Configuración inválida' });

        const { saveAvailabilityConfig } = require('./availabilityService');
        const { logAdminAction } = require('./auditService');
        saveAvailabilityConfig(config);

        logAdminAction({
            agentEmail: agentEmail || 'admin@sheerit.com',
            agentName: agentName || 'Administrador',
            action: 'UPDATE_STOCK_AVAILABILITY',
            target: 'Plataformas & Planes',
            details: { platformsModified: Object.keys(config.platforms || {}).length }
        });

        res.json({ success: true, message: 'Disponibilidad de stock actualizada y auditada' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- HEAVY TICKETS / INTERNAL TASKS ENDPOINTS ---
app.get('/api/admin/heavy-tickets', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT ht.*, 
                   (SELECT COUNT(*) FROM heavy_ticket_comments WHERE ticket_id = ht.id) as comments_count
            FROM heavy_tickets ht
            ORDER BY ht.created_at DESC
        `);
        res.json({ success: true, tickets: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/heavy-tickets', express.json(), async (req, res) => {
    try {
        const { title, description, priority, assigned_agent, password, initial_comment } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

        const [result] = await pool.query(
            'INSERT INTO heavy_tickets (title, description, priority, assigned_agent) VALUES (?, ?, ?, ?)',
            [title, description || '', priority || 'medium', assigned_agent || null]
        );

        const ticketId = result.insertId;

        if (initial_comment && initial_comment.trim()) {
            await pool.query(
                'INSERT INTO heavy_ticket_comments (ticket_id, agent_name, comment) VALUES (?, ?, ?)',
                [ticketId, assigned_agent || 'Sistema', initial_comment.trim()]
            );
        }

        res.json({ success: true, ticketId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/heavy-tickets/:id', express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, priority, status, assigned_agent, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        await pool.query(
            'UPDATE heavy_tickets SET title = ?, description = ?, priority = ?, status = ?, assigned_agent = ? WHERE id = ?',
            [title, description || '', priority || 'medium', status || 'pending', assigned_agent || null, id]
        );

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/heavy-tickets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password || req.body?.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        await pool.query('DELETE FROM heavy_tickets WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/heavy-tickets/:id/comments', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            'SELECT * FROM heavy_ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, comments: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/heavy-tickets/:id/comments', express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { agent_name, comment, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!comment || !comment.trim()) return res.status(400).json({ success: false, message: 'Comment is required' });

        await pool.query(
            'INSERT INTO heavy_ticket_comments (ticket_id, agent_name, comment) VALUES (?, ?, ?)',
            [id, agent_name || 'Sistema', comment.trim()]
        );

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to read human support schedule configuration
app.get('/api/admin/support-schedule', async (req, res) => {
    try {
        const { getSupportScheduleConfig, isSupportOpen } = require('./supportScheduleService');
        const config = getSupportScheduleConfig();
        const supportStatus = await isSupportOpen();
        res.json({
            ...config,
            is_open: supportStatus.open,
            reason: supportStatus.reason
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET Public Support & Contact Configuration for Frontend Website
app.get('/api/public/support-config', async (req, res) => {
    try {
        const { getSupportScheduleConfig, isSupportOpen } = require('./supportScheduleService');
        const config = getSupportScheduleConfig();
        const supportStatus = await isSupportOpen();
        res.json({
            whatsapp_contact_number: config.whatsapp_contact_number || "573118587974",
            is_open: supportStatus.open,
            reason: supportStatus.reason,
            weekday_start: config.weekday_start,
            weekday_end: config.weekday_end,
            weekend_start: config.weekend_start,
            weekend_end: config.weekend_end
        });
    } catch (e) {
        res.status(500).json({ whatsapp_contact_number: "573118587974", is_open: true, error: e.message });
    }
});

// --- CONTABILIDAD Y PRECIOS ENDPOINTS ---
const accountingService = require('./accountingService');

app.get('/api/admin/prices', async (req, res) => {
    try {
        const prices = await accountingService.getPrices();
        res.json(prices);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function syncPlatformPrices(platforms, dbPrices) {
    const priceMap = {};
    dbPrices.forEach(p => {
        const clean = p.platform.toUpperCase().trim();
        priceMap[clean] = parseFloat(p.normal_price);
    });

    return platforms.map(p => {
        const nameUpper = (p.name || '').toUpperCase().trim();
        
        // Mapeo de precio base de la plataforma (Claude primero para no confundir con HBO Max)
        if (nameUpper.includes('CLAUDE') && priceMap['CLAUDE'] !== undefined) p.price = priceMap['CLAUDE'];
        else if (nameUpper.includes('NETFLIX') && priceMap['NETFLIX'] !== undefined) p.price = priceMap['NETFLIX'];
        else if (nameUpper.includes('DISNEY') && priceMap['DISNEY'] !== undefined) p.price = priceMap['DISNEY'];
        else if ((nameUpper.includes('HBO') || (nameUpper.includes('MAX') && !nameUpper.includes('CLAUDE'))) && priceMap['HBO'] !== undefined) p.price = priceMap['HBO'];
        else if ((nameUpper.includes('PRIME') || nameUpper.includes('AMAZON')) && priceMap['AMAZON'] !== undefined) p.price = priceMap['AMAZON'];
        else if (nameUpper.includes('VIX') && priceMap['VIX'] !== undefined) p.price = priceMap['VIX'];
        else if (nameUpper.includes('APPLE') && priceMap['APPLE TV'] !== undefined) p.price = priceMap['APPLE TV'];
        else if (nameUpper.includes('YOUTUBE') && priceMap['YOUTUBE'] !== undefined) p.price = priceMap['YOUTUBE'];
        else if (nameUpper.includes('PARAMOUNT') && priceMap['PARAMOUNT'] !== undefined) p.price = priceMap['PARAMOUNT'];
        else if (nameUpper.includes('SPOTIFY') && priceMap['SPOTIFY'] !== undefined) p.price = priceMap['SPOTIFY'];
        else if (nameUpper.includes('CRUNCHY') && priceMap['CRUNCHY ROLL'] !== undefined) p.price = priceMap['CRUNCHY ROLL'];
        else if (nameUpper.includes('PLATZI') && priceMap['PLATZI COMPARTIDA'] !== undefined) p.price = priceMap['PLATZI COMPARTIDA'];
        else if (nameUpper.includes('IPTV') && priceMap['IPTV'] !== undefined) p.price = priceMap['IPTV'];
        else if (nameUpper.includes('GEMINI') && priceMap['GEMINI COMPARTIDA'] !== undefined) p.price = priceMap['GEMINI COMPARTIDA'];
        else if (nameUpper.includes('CANVA') && priceMap['CANVA'] !== undefined) p.price = priceMap['CANVA'];
        else if (nameUpper.includes('CHATGPT') || nameUpper.includes('GPT')) {
            if (priceMap['GPT'] !== undefined) p.price = priceMap['GPT'];
        } else if (nameUpper.includes('MICROSOFT')) {
            if (priceMap['MICROSOFT COMPARTIDA'] !== undefined) p.price = priceMap['MICROSOFT COMPARTIDA'];
        }

        // Mapeo detallado de planes individuales
        if (p.plans && p.plans.length > 0) {
            p.plans = p.plans.map(plan => {
                const planUpper = (plan.name || '').toUpperCase().trim();
                
                // Claude
                if (nameUpper.includes('CLAUDE')) {
                    if (planUpper.includes('ESTÁNDAR') && priceMap['CLAUDE'] !== undefined) plan.price = priceMap['CLAUDE'];
                }
                // Netflix
                else if (nameUpper.includes('NETFLIX')) {
                    if (planUpper.includes('EXTRA') && priceMap['NETFLIX EXTRA'] !== undefined) plan.price = priceMap['NETFLIX EXTRA'];
                    else if (priceMap['NETFLIX'] !== undefined) plan.price = priceMap['NETFLIX'];
                }
                // HBO / Max
                else if (nameUpper.includes('HBO') || (nameUpper.includes('MAX') && !nameUpper.includes('CLAUDE'))) {
                    if (planUpper.includes('PLATINO') && priceMap['HBO PLATINO'] !== undefined) plan.price = priceMap['HBO PLATINO'];
                    else if (priceMap['HBO'] !== undefined) plan.price = priceMap['HBO'];
                }
                // Microsoft
                else if (nameUpper.includes('MICROSOFT')) {
                    if (planUpper.includes('PERSONAL') && priceMap['MICROSOFT'] !== undefined) plan.price = priceMap['MICROSOFT'];
                    else if (priceMap['MICROSOFT COMPARTIDA'] !== undefined) plan.price = priceMap['MICROSOFT COMPARTIDA'];
                }
                // Spotify
                else if (nameUpper.includes('SPOTIFY')) {
                    if ((planUpper.includes('PERSONAL') || planUpper.includes('TU CORREO') || planUpper.includes('OWNER')) && priceMap['SPOTIFY OWNER'] !== undefined) plan.price = priceMap['SPOTIFY OWNER'];
                    else if (priceMap['SPOTIFY'] !== undefined) plan.price = priceMap['SPOTIFY'];
                }
                // YouTube
                else if (nameUpper.includes('YOUTUBE')) {
                    if (planUpper.includes('OWNER') && priceMap['YOUTUBE OWNER'] !== undefined) plan.price = priceMap['YOUTUBE OWNER'];
                    else if (priceMap['YOUTUBE'] !== undefined) plan.price = priceMap['YOUTUBE'];
                }
                // Apple
                else if (nameUpper.includes('APPLE')) {
                    if (planUpper.includes('ONE') && priceMap['APPLE ONE'] !== undefined) plan.price = priceMap['APPLE ONE'];
                    else if (planUpper.includes('TV') && priceMap['APPLE TV'] !== undefined) plan.price = priceMap['APPLE TV'];
                }
                // Gemini
                else if (nameUpper.includes('GEMINI')) {
                    if ((planUpper.includes('CORREO PROPIO') || planUpper.includes('PERSONAL')) && priceMap['GEMINI'] !== undefined) plan.price = priceMap['GEMINI'];
                    else if (priceMap['GEMINI COMPARTIDA'] !== undefined) plan.price = priceMap['GEMINI COMPARTIDA'];
                }
                // Platzi
                else if (nameUpper.includes('PLATZI')) {
                    if ((planUpper.includes('TRIMESTRAL') || planUpper.includes('PERSONAL')) && priceMap['PLATZI'] !== undefined) plan.price = priceMap['PLATZI'];
                    else if (priceMap['PLATZI COMPARTIDA'] !== undefined) plan.price = priceMap['PLATZI COMPARTIDA'];
                }
                // Canva
                else if (nameUpper.includes('CANVA')) {
                    if (planUpper.includes('MENSUAL') && priceMap['CANVA'] !== undefined) plan.price = priceMap['CANVA'];
                }
                // Disney / Prime / Vix / IPTV / Paramount / GPT
                else if (nameUpper.includes('DISNEY') && priceMap['DISNEY'] !== undefined) plan.price = priceMap['DISNEY'];
                else if ((nameUpper.includes('PRIME') || nameUpper.includes('AMAZON')) && priceMap['AMAZON'] !== undefined) plan.price = priceMap['AMAZON'];
                else if (nameUpper.includes('VIX') && priceMap['VIX'] !== undefined) plan.price = priceMap['VIX'];
                else if (nameUpper.includes('PARAMOUNT') && priceMap['PARAMOUNT'] !== undefined) plan.price = priceMap['PARAMOUNT'];
                else if (nameUpper.includes('CRUNCHY') && priceMap['CRUNCHY ROLL'] !== undefined) plan.price = priceMap['CRUNCHY ROLL'];
                else if (nameUpper.includes('IPTV') && priceMap['IPTV'] !== undefined) plan.price = priceMap['IPTV'];
                else if ((nameUpper.includes('CHATGPT') || nameUpper.includes('GPT')) && priceMap['GPT'] !== undefined) plan.price = priceMap['GPT'];

                return plan;
            });
        }
        return p;
    });
}

app.get('/api/public/platforms', async (req, res) => {
    try {
        const { getPlatformsFromDb } = require('./platformsDbService');
        const { getAvailabilityConfig } = require('./availabilityService');
        const config = getAvailabilityConfig();
        const rawPlatforms = await getPlatformsFromDb();

        const platforms = rawPlatforms.map(p => {
            const pKey = p.name;
            const pOverride = config[pKey] || {};
            const isPlatformAvailable = pOverride.immediate !== false;
            const pReason = pOverride.reason || '';
            const pIncident = pOverride.incident || '';

            const plans = (p.plans || []).map(pl => {
                const planKey = `${p.name} ${pl.name}`;
                const planOverride = config[planKey] || {};
                const isPlanAvailable = isPlatformAvailable && (planOverride.immediate !== false);
                const planReason = planOverride.reason || pReason;

                return {
                    ...pl,
                    isAvailable: isPlanAvailable,
                    reason: planReason || undefined
                };
            });

            // If all plans are unavailable, mark the platform overall as unavailable
            const hasAnyAvailablePlan = plans.length === 0 ? isPlatformAvailable : plans.some(pl => pl.isAvailable);

            return {
                ...p,
                isAvailable: isPlatformAvailable && hasAnyAvailablePlan,
                reason: pReason || undefined,
                incident: pIncident || undefined,
                plans
            };
        });

        res.json(platforms);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- TRACKING & HEATMAP ENDPOINTS ---

app.post('/api/public/track-visit', async (req, res) => {
    try {
        const { pagePath, referrer, userAgent, deviceType } = req.body;
        let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        if (clientIp.includes('::ffff:')) {
            clientIp = clientIp.replace('::ffff:', '');
        }

        await pool.query(
            'INSERT INTO page_visits (page_path, referrer, user_agent, device_type, ip_address) VALUES (?, ?, ?, ?, ?)',
            [pagePath || '/', referrer || null, userAgent || null, deviceType || 'unknown', clientIp]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Error tracking page visit:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/public/track-click', async (req, res) => {
    try {
        const { pagePath, xPct, yPct, elementSelector, screenWidth, screenHeight } = req.body;
        await pool.query(
            'INSERT INTO page_clicks (page_path, x_pct, y_pct, element_selector, screen_width, screen_height) VALUES (?, ?, ?, ?, ?, ?)',
            [pagePath || '/', xPct, yPct, elementSelector || null, screenWidth || null, screenHeight || null]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Error tracking page click:', e.message);
        res.status(500).json({ error: e.message });
    }
});

const getTimeframeFilter = (timeframe, dateCol) => {
    if (timeframe === 'today') {
        return `DATE(${dateCol}) = CURDATE()`;
    } else if (timeframe === '7d') {
        return `${dateCol} >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    } else if (timeframe === '30d') {
        return `${dateCol} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    }
    return '1=1';
};

app.get('/api/admin/visit-stats', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilterVisits = getTimeframeFilter(timeframe, 'visited_at');
        const timeFilterClicks = getTimeframeFilter(timeframe, 'clicked_at');

        const [totalVisitsRows] = await pool.query(`SELECT COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [uniqueVisitsRows] = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [totalClicksRows] = await pool.query(`SELECT COUNT(*) as count FROM page_clicks WHERE ${timeFilterClicks}`);

        const [deviceBreakdown] = await pool.query(`SELECT device_type as name, COUNT(*) as value FROM page_visits WHERE ${timeFilterVisits} GROUP BY device_type`);
        const [topPages] = await pool.query(`SELECT page_path as page, COUNT(*) as visits FROM page_visits WHERE ${timeFilterVisits} GROUP BY page_path ORDER BY visits DESC LIMIT 10`);
        const [clicksByPage] = await pool.query(`SELECT page_path as page, COUNT(*) as clicks FROM page_clicks WHERE ${timeFilterClicks} GROUP BY page_path`);
        const [visitsHistory] = await pool.query(`SELECT DATE_FORMAT(visited_at, "%Y-%m-%d") as date, COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits} GROUP BY DATE(visited_at) ORDER BY date DESC LIMIT 15`);
        
        // Excluir dominios propios del referrer para evitar falsos orígenes
        const [rawReferrers] = await pool.query(`
            SELECT referrer, COUNT(*) as count 
            FROM page_visits 
            WHERE referrer IS NOT NULL AND referrer != '' 
              AND referrer NOT LIKE '%sheerit.com.co%' 
              AND referrer NOT LIKE '%sheerit.co%' 
              AND referrer NOT LIKE '%localhost%' 
              AND referrer NOT LIKE '%127.0.0.1%'
              AND ${timeFilterVisits}
            GROUP BY referrer 
            ORDER BY count DESC 
            LIMIT 15
        `);

        const topReferrers = rawReferrers.map(r => {
            let clean = r.referrer;
            try {
                const url = new URL(r.referrer.startsWith('http') ? r.referrer : `https://${r.referrer}`);
                clean = url.hostname.replace(/^www\./, '');
                if (clean.includes('google')) clean = 'Google Search';
                else if (clean.includes('bold.co')) clean = 'Pasarela Bold';
                else if (clean.includes('bing')) clean = 'Bing Search';
                else if (clean.includes('instagram')) clean = 'Instagram';
                else if (clean.includes('whatsapp') || clean.includes('wa.me')) clean = 'WhatsApp';
                else if (clean.includes('facebook') || clean.includes('fb.com')) clean = 'Facebook';
                else if (clean.includes('tiktok')) clean = 'TikTok';
            } catch (e) { }
            return { name: clean, value: r.count };
        });

        res.json({
            summary: {
                totalVisits: totalVisitsRows[0]?.count || 0,
                uniqueVisits: uniqueVisitsRows[0]?.count || 0,
                totalClicks: totalClicksRows[0]?.count || 0
            },
            deviceBreakdown,
            topPages,
            clicksByPage,
            visitsHistory: visitsHistory.reverse(),
            topReferrers
        });
    } catch (e) {
        console.error('Error fetching admin visit stats:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/click-heatmap', async (req, res) => {
    try {
        const { page, device, timeframe } = req.query;
        const pagePath = page || '/';
        const timeFilter = getTimeframeFilter(timeframe, 'clicked_at');
        let query = `SELECT x_pct, y_pct, element_selector, screen_width, screen_height, clicked_at FROM page_clicks WHERE page_path = ? AND ${timeFilter}`;
        const params = [pagePath];

        if (device === 'mobile') {
            query += ' AND (screen_width IS NULL OR screen_width < 768)';
        } else if (device === 'desktop') {
            query += ' AND screen_width >= 768';
        }

        query += ' ORDER BY clicked_at DESC LIMIT 2000';

        const [clicks] = await pool.query(query, params);
        res.json({ clicks });
    } catch (e) {
        console.error('Error fetching admin click heatmap:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/element-clicks', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilter = getTimeframeFilter(timeframe, 'clicked_at');

        const [rows] = await pool.query(`
            SELECT 
                COALESCE(element_selector, 'Área General de Página') as raw_element,
                COUNT(*) as total_clicks,
                SUM(CASE WHEN screen_width < 768 THEN 1 ELSE 0 END) as mobile_clicks,
                SUM(CASE WHEN screen_width >= 768 THEN 1 ELSE 0 END) as desktop_clicks
            FROM page_clicks
            WHERE ${timeFilter}
            GROUP BY raw_element
            ORDER BY total_clicks DESC
            LIMIT 40
        `);

        const formatElementName = (raw) => {
            if (!raw) return 'Área General de Página';
            if (raw.startsWith('Botón:') || raw.startsWith('Enlace:') || raw.startsWith('Campo:') || raw.startsWith('Tarjeta:') || raw.startsWith('Selector:') || raw.startsWith('Texto:')) {
                return raw;
            }
            const lower = raw.toLowerCase();
            if (lower === 'button.w-full' || lower.includes('button.w-full')) return 'Botón Principal (Comprar / Acción)';
            if (lower === 'button.px-2' || lower === 'button.p-1.5' || lower.includes('button.inline-flex')) return 'Botón Secundario / Opciones';
            if (lower === 'input.w-full' || lower.includes('input')) return 'Buscador de Servicios';
            if (lower === 'svg' || lower === 'path') return 'Ícono / Botón Interactivo';
            if (lower === 'div.w-full' || lower === 'div.p-4' || lower.includes('div.flex') || lower.includes('div.absolute')) return 'Tarjeta de Servicio / Catálogo';
            if (lower.startsWith('span') || lower === 'font' || lower.includes('span.text')) return 'Etiqueta / Detalles de Cuenta';
            if (lower.startsWith('a.')) return 'Enlace de Navegación';
            return raw;
        };

        const aggregated = new Map();
        rows.forEach(r => {
            const cleanName = formatElementName(r.raw_element);
            if (!aggregated.has(cleanName)) {
                aggregated.set(cleanName, {
                    element: cleanName,
                    total_clicks: 0,
                    mobile_clicks: 0,
                    desktop_clicks: 0
                });
            }
            const item = aggregated.get(cleanName);
            item.total_clicks += Number(r.total_clicks);
            item.mobile_clicks += Number(r.mobile_clicks);
            item.desktop_clicks += Number(r.desktop_clicks);
        });

        const elements = Array.from(aggregated.values())
            .sort((a, b) => b.total_clicks - a.total_clicks)
            .slice(0, 15);

        res.json({ elements });
    } catch (e) {
        console.error('Error fetching element clicks:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/purchase-funnel', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilterVisits = getTimeframeFilter(timeframe, 'visited_at');
        const timeFilterClicks = getTimeframeFilter(timeframe, 'clicked_at');
        const timeFilterSales = getTimeframeFilter(timeframe, 'created_at');

        const [visits] = await pool.query(`SELECT COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [clicks] = await pool.query(`SELECT COUNT(*) as count FROM page_clicks WHERE ${timeFilterClicks}`);
        const [payClicks] = await pool.query(`
            SELECT COUNT(*) as count FROM page_clicks 
            WHERE (element_selector LIKE '%bold%' 
               OR element_selector LIKE '%pagar%' 
               OR element_selector LIKE '%comprar%' 
               OR element_selector LIKE '%button%'
               OR element_selector LIKE '%Botón%')
              AND ${timeFilterClicks}
        `);
        const [sales] = await pool.query(`SELECT COUNT(*) as count FROM web_sales_approved WHERE ${timeFilterSales}`);

        const totalVisits = visits[0]?.count || 0;
        const totalClicks = clicks[0]?.count || 0;
        const totalPayClicks = payClicks[0]?.count || 0;
        const totalSales = sales[0]?.count || 0;

        res.json({
            funnel: [
                { step: 'Visitas a la Web', count: totalVisits, pct: 100 },
                { step: 'Interacción / Clics', count: totalClicks, pct: totalVisits ? Math.round((totalClicks / totalVisits) * 100) : 0 },
                { step: 'Inicios de Pago (Bold)', count: totalPayClicks, pct: totalVisits ? Math.round((totalPayClicks / totalVisits) * 100) : 0 },
                { step: 'Ventas Completadas', count: totalSales, pct: totalVisits ? Math.round((totalSales / totalVisits) * 100) : 0 },
            ],
            conversionRate: totalVisits ? ((totalSales / totalVisits) * 100).toFixed(2) : '0.00'
        });
    } catch (e) {
        console.error('Error fetching purchase funnel:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/prices/save', async (req, res) => {
    try {
        const { platform, price, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.savePrice(platform, price);
        res.json({ success: true, message: 'Precio actualizado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/plans/price', async (req, res) => {
    try {
        const { planId, price, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { updatePlanPriceInDb } = require('./platformsDbService');
        await updatePlanPriceInDb(planId, price);
        res.json({ success: true, message: 'Precio de plan actualizado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/platforms/sync-db', async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { forceSyncJsonToDb } = require('./platformsDbService');
        const result = await forceSyncJsonToDb();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/costs', async (req, res) => {
    try {
        const costs = await accountingService.getCosts();
        res.json(costs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/costs/save', async (req, res) => {
    try {
        const { costData, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.saveCost(costData);
        res.json({ success: true, message: 'Costo actualizado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/costs/delete', async (req, res) => {
    try {
        const { id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.deleteCost(id);
        res.json({ success: true, message: 'Costo eliminado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/accounting/daily', async (req, res) => {
    try {
        const data = await accountingService.calculateDailyAccounting();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/accounting/real', async (req, res) => {
    try {
        const data = await accountingService.calculateRealCashFlow();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/accounting/transaction', async (req, res) => {
    try {
        const { type, platform, amount, description, entryDate, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.addTransaction(type, platform, amount, description, entryDate, 0);
        res.json({ success: true, message: 'Transacción registrada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// Endpoint to write human support schedule configuration
app.post('/api/admin/support-schedule/save', (req, res) => {
    try {
        const { config, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config || typeof config !== 'object') return res.status(400).json({ success: false, message: 'Configuración inválida' });

        const { saveSupportScheduleConfig } = require('./supportScheduleService');
        saveSupportScheduleConfig(config);
        res.json({ success: true, message: 'Configuración de horario de soporte actualizada con éxito.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/admin/gpt-accounts', (req, res) => {
    try {
        const { loadSecrets } = require('./totpService');
        const { authenticator } = require('@otplib/preset-default');
        const secrets = loadSecrets();
        const list = [];
        for (const email of Object.keys(secrets)) {
            let code = "";
            let timeRemaining = 30;
            const secretVal = secrets[email];
            const secret = typeof secretVal === 'object' ? secretVal.secret : secretVal;
            let service = typeof secretVal === 'object' ? secretVal.service : null;
            if (!service) {
                if (email.toLowerCase().includes('amazon') || email.toLowerCase().includes('prime')) {
                    service = 'Amazon';
                } else if (email.toLowerCase().includes('netflix')) {
                    service = 'Netflix';
                } else {
                    service = 'ChatGPT';
                }
            }
            try {
                code = authenticator.generate(secret);
                timeRemaining = authenticator.timeRemaining();
            } catch (e) {
                code = "Error";
            }
            list.push({ email, code, timeRemaining, service });
        }
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/ai-assistant/query', express.json(), async (req, res) => {
    try {
        const { query, activeTab, agentName, agentEmail, history } = req.body;
        if (!query) return res.status(400).json({ success: false, message: 'Falta la consulta (query)' });

        const { processAdminAssistantQuery } = require('./adminAssistantService');
        const response = await processAdminAssistantQuery({ query, activeTab, agentName, agentEmail, history });
        res.json(response);
    } catch (e) {
        console.error('[AI Assistant API Error]:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/audit-logs', (req, res) => {
    try {
        const { limit, action, agentEmail } = req.query;
        const { getAuditLogs } = require('./auditService');
        const logs = getAuditLogs({ 
            limit: limit ? parseInt(limit) : 100, 
            action: action || null, 
            agentEmail: agentEmail || null 
        });
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/gpt-accounts/save', (req, res) => {
    try {
        const { email, secret, service, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !secret) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { saveSecret } = require('./totpService');
        saveSecret(email, secret, service || 'ChatGPT', { agentEmail, agentName });
        res.json({ success: true, message: 'Cuenta 2FA guardada y auditada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/payment-config', (req, res) => {
    try {
        const { getPaymentConfig } = require('./paymentConfigService');
        const config = getPaymentConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/payment-config', (req, res) => {
    try {
        const { config, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config) return res.status(400).json({ error: 'Falta configuración en la solicitud' });

        const { savePaymentConfig } = require('./paymentConfigService');
        savePaymentConfig(config);
        res.json({ success: true, message: 'Configuración de pagos guardada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/trigger-auto-cobros', async (req, res) => {
    try {
        if (!client || !client.info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }
        const { handleAutoCobros } = require('./billingService');
        const fakeMsg = {
            from: '120363161345379149@g.us',
            to: '120363161345379149@g.us',
            body: '@bot cobros automáticos',
            reply: async (text) => console.log('[Trigger Cobros Reply]:', text)
        };
        handleAutoCobros(fakeMsg, '120363161345379149@g.us', userStates, pendingConfirmations, client).catch(err => {
            console.error('[Trigger Auto-Cobros API Error]:', err);
        });
        res.json({ success: true, message: 'Cobros automáticos iniciados correctamente en segundo plano.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/groups', async (req, res) => {
    try {
        if (!client || !client.info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat && chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Sin Nombre',
                unreadCount: chat.unreadCount || 0
            }));
        res.json(groups);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gpt-accounts/delete', (req, res) => {
    try {
        const { email, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { deleteSecret } = require('./totpService');
        const deleted = deleteSecret(email, { agentEmail, agentName });
        if (deleted) {
            res.json({ success: true, message: 'Cuenta 2FA eliminada y auditada con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/accounts/add', async (req, res) => {
    try {
        const { streaming, correo, contraseña, perfiles, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!streaming || !correo || !contraseña || !perfiles) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const { fetchRawData, updateExcelData } = require('./apiService');
        const allRows = await fetchRawData();
        const startRow = allRows.length + 2;

        const numPerfiles = parseInt(perfiles) || 1;
        for (let i = 0; i < numPerfiles; i++) {
            const rowNumber = startRow + i;
            const updates = {
                "Streaming": streaming,
                "correo": correo,
                "contraseña": contraseña,
                "Nombre": "libre",
                "whatsapp": "",
                "numero": "",
                "deben": ""
            };
            await updateExcelData(rowNumber, updates);
        }

        res.json({ success: true, message: `Se agregaron ${numPerfiles} perfiles para la cuenta de ${streaming} (${correo}) en el inventario.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/provider-emails', (req, res) => {
    try {
        const file = path.join(__dirname, 'provider_emails.json');
        if (fs.existsSync(file)) {
            const data = fs.readFileSync(file, 'utf8');
            return res.json(JSON.parse(data));
        }
        res.json([]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/provider-emails/save', (req, res) => {
    try {
        const { email, providerNumber, notes, rpaRecipeId, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !providerNumber) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const file = path.join(__dirname, 'provider_emails.json');
        let data = [];
        if (fs.existsSync(file)) {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
        }

        const cleanEmail = email.toLowerCase().trim();
        const index = data.findIndex(item => item.email.toLowerCase().trim() === cleanEmail);
        const newItem = {
            email: cleanEmail,
            providerNumber: providerNumber.trim(),
            notes: (notes || "").trim(),
            rpaRecipeId: rpaRecipeId ? parseInt(rpaRecipeId) : null
        };

        if (index !== -1) {
            data[index] = newItem;
        } else {
            data.push(newItem);
        }

        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        res.json({ success: true, message: 'Correo de proveedor guardado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET: Lista de recetas RPA disponibles para el selector de proveedor
app.get('/api/admin/rpa/recipes', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT id, name, platform FROM rpa_recipes ORDER BY id ASC');
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// SUBSCRIPTIONS API (BD como fuente de verdad)
// ==========================================

// GET: Listar cuentas de streaming con filtros opcionales (is_provider, search, etc.)
app.get('/api/admin/subscriptions', async (req, res) => {
    try {
        const { pool } = require('./database');
        const { is_provider, status, platform, search } = req.query;

        let where = [];
        let params = [];

        if (is_provider !== undefined) {
            where.push('sa.is_provider = ?');
            params.push(parseInt(is_provider));
        }
        if (status) {
            where.push('sa.status = ?');
            params.push(status);
        }
        if (platform) {
            where.push('sa.streaming_platform LIKE ?');
            params.push(`%${platform}%`);
        }
        if (search) {
            where.push('(sa.account_email LIKE ? OR aa.customer_phone LIKE ? OR c.fullname LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const whereStr = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

        // Retornamos las cuentas únicas y les anexamos info del cliente principal o lista de clientes asignados
        const [rows] = await pool.query(
            `SELECT 
                sa.id,
                sa.account_email,
                sa.streaming_platform,
                sa.is_provider,
                sa.provider_name,
                sa.rpa_recipe_id,
                sa.notes,
                r.name as recipe_name,
                -- Agrupamos teléfonos y nombres de clientes vinculados
                GROUP_CONCAT(aa.customer_phone SEPARATOR ', ') as customer_phone,
                GROUP_CONCAT(c.fullname SEPARATOR ', ') as fullname,
                MAX(aa.expiration_date) as expiration_date
             FROM stream_accounts sa
             LEFT JOIN account_assignments aa ON aa.account_id = sa.id
             LEFT JOIN customers c ON c.phone = aa.customer_phone
             LEFT JOIN rpa_recipes r ON r.id = sa.rpa_recipe_id
             ${whereStr}
             GROUP BY sa.id
             ORDER BY expiration_date ASC`,
            params
        );
        res.json({ success: true, data: rows, total: rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Guardar/actualizar cuenta de streaming
app.post('/api/admin/subscriptions/save', express.json(), async (req, res) => {
    try {
        const { id, account_email, streaming_platform, is_provider, provider_name,
            rpa_recipe_id, notes, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!streaming_platform || !account_email) {
            return res.status(400).json({ success: false, error: 'Faltan campos obligatorios' });
        }
        const { pool } = require('./database');
        if (id) {
            await pool.query(
                `UPDATE stream_accounts SET account_email=?, streaming_platform=?,
                  is_provider=?, provider_name=?, rpa_recipe_id=?, notes=? WHERE id=?`,
                [account_email, streaming_platform, is_provider ? 1 : 0, provider_name || null,
                    rpa_recipe_id || null, notes || null, id]
            );
        } else {
            await pool.query(
                `INSERT INTO stream_accounts (account_email, streaming_platform, is_provider,
                  provider_name, rpa_recipe_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
                [account_email, streaming_platform, is_provider ? 1 : 0, provider_name || null,
                    rpa_recipe_id || null, notes || null]
            );
        }
        res.json({ success: true, message: 'Cuenta guardada correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular rpaRecipeId a múltiples cuentas de streaming (en lote)
app.post('/api/admin/subscriptions/set-recipe-bulk', express.json(), async (req, res) => {
    try {
        const { ids, rpa_recipe_id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de IDs vacía o inválida' });
        }
        const { pool } = require('./database');
        await pool.query('UPDATE stream_accounts SET rpa_recipe_id = ? WHERE id IN (?)', [rpa_recipe_id || null, ids]);
        res.json({ success: true, message: `Se asignó la receta a ${ids.length} cuentas.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular provider_name a múltiples cuentas de streaming (en lote)
app.post('/api/admin/subscriptions/set-provider-bulk', express.json(), async (req, res) => {
    try {
        const { ids, provider_name, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de IDs vacía o inválida' });
        }
        const { pool } = require('./database');
        await pool.query('UPDATE stream_accounts SET provider_name = ? WHERE id IN (?)', [provider_name || null, ids]);
        res.json({ success: true, message: `Se asignó el proveedor a ${ids.length} cuentas.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular provider_name a una cuenta específica
app.post('/api/admin/subscriptions/set-provider', express.json(), async (req, res) => {
    try {
        const { id, provider_name, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { pool } = require('./database');
        await pool.query('UPDATE stream_accounts SET provider_name = ? WHERE id = ?', [provider_name || null, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular rpaRecipeId a una cuenta de streaming específica
app.post('/api/admin/subscriptions/set-recipe', express.json(), async (req, res) => {
    try {
        const { id, rpa_recipe_id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { pool } = require('./database');
        await pool.query('UPDATE stream_accounts SET rpa_recipe_id = ? WHERE id = ?', [rpa_recipe_id || null, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Disparar sincronización Excel → BD desde el panel
app.post('/api/admin/subscriptions/sync-excel', express.json(), async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { syncExcelToDb, syncHistoricoToDb } = require('./scripts/sync_excel_to_db');

        console.log('[Sync API] Sincronizando suscripciones actuales...');
        const result = await syncExcelToDb();

        console.log('[Sync API] Sincronizando cortes históricos...');
        const historicoResult = await syncHistoricoToDb();

        res.json({
            success: true,
            current: result,
            historico: historicoResult
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


app.post('/api/admin/provider-emails/delete', (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const file = path.join(__dirname, 'provider_emails.json');
        if (fs.existsSync(file)) {
            let data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const cleanEmail = email.toLowerCase().trim();
            const filtered = data.filter(item => item.email.toLowerCase().trim() !== cleanEmail);
            fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
            res.json({ success: true, message: 'Correo de proveedor eliminado con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Archivo no encontrado' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/gmail-inboxes', (req, res) => {
    try {
        const tokensDir = path.join(__dirname, 'tokens');
        if (!fs.existsSync(tokensDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(tokensDir);
        const emails = files
            .filter(f => f.startsWith('token_') && f.endsWith('.json'))
            .map(f => f.replace('token_', '').replace('.json', ''))
            .filter(email => email.includes('@') && email !== 'contacts');
        res.json(emails);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/gmail-inboxes/emails', async (req, res) => {
    try {
        const { email, password } = req.query;
        if (password !== 'admin123') return res.status(401).json({ error: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Falta el correo' });

        const { getEmailsFromInbox } = require('./gmailService');
        const emailsList = await getEmailsFromInbox(email, 15);
        res.json(emailsList);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/auth-url', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email no válido' });

        const { google } = require('googleapis');
        const credFile = fs.existsSync(path.join(__dirname, 'credentials_pagos.json'))
            ? path.join(__dirname, 'credentials_pagos.json')
            : path.join(__dirname, 'credentials.json');

        if (!fs.existsSync(credFile)) {
            return res.status(500).json({ error: 'No se encontraron las credenciales de Google API en el servidor.' });
        }

        const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/gmail.readonly'],
            prompt: 'consent'
        });

        res.json({ success: true, authUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/confirm-code', async (req, res) => {
    try {
        const { email, codeOrUrl, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !codeOrUrl) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { google } = require('googleapis');
        const credFile = fs.existsSync(path.join(__dirname, 'credentials_pagos.json'))
            ? path.join(__dirname, 'credentials_pagos.json')
            : path.join(__dirname, 'credentials.json');

        if (!fs.existsSync(credFile)) {
            return res.status(500).json({ error: 'No se encontraron las credenciales en el servidor.' });
        }

        const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
            const urlParts = new URL(codeOrUrl);
            code = urlParts.searchParams.get('code');
        }

        oAuth2Client.getToken(code, (err, token) => {
            if (err) {
                console.error('[Google Auth API Error]:', err.message);
                return res.status(500).json({ error: 'Error al verificar el código de Google: ' + err.message });
            }

            const safeEmail = email.toLowerCase().trim();
            const tokenPath = path.join(__dirname, 'tokens', `token_${safeEmail}.json`);
            fs.writeFileSync(tokenPath, JSON.stringify(token));

            const { clearCachedClient } = require('./googleAuthService');
            clearCachedClient('gmail', safeEmail);

            res.json({ success: true, message: `Bandeja ${email} vinculada con éxito.` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/delete', (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Falta el correo' });

        const safeEmail = email.toLowerCase().trim();
        const tokenPath = path.join(__dirname, 'tokens', `token_${safeEmail}.json`);
        if (fs.existsSync(tokenPath)) {
            fs.unlinkSync(tokenPath);
            const { clearCachedClient } = require('./googleAuthService');
            clearCachedClient('gmail', safeEmail);
            res.json({ success: true, message: 'Bandeja desvinculada con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Bandeja no encontrada' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/streaming/tokens', async (req, res) => {
    try {
        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        if (!fs.existsSync(TOKENS_FILE)) {
            return res.json([]);
        }
        const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        res.json(tokens);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/streaming/tokens/add', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!token) return res.status(400).json({ success: false, message: 'Token is required' });

        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        const dir = path.dirname(TOKENS_FILE);
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (err) {
                console.error("Failed to create tokens directory:", err.message);
            }
        }

        let tokens = [];
        if (fs.existsSync(TOKENS_FILE)) {
            try {
                tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
            } catch (e) {
                tokens = [];
            }
        }

        const cleanToken = token.trim().toLowerCase().replace(/\s+/g, '_');
        if (!tokens.includes(cleanToken)) {
            tokens.push(cleanToken);
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        }
        res.json({ success: true, tokens });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/streaming/tokens/delete', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!token) return res.status(400).json({ success: false, message: 'Token is required' });

        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        let tokens = [];
        if (fs.existsSync(TOKENS_FILE)) {
            try {
                tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
            } catch (e) {
                tokens = [];
            }
        }
        tokens = tokens.filter(t => t !== token);
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        res.json({ success: true, tokens });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/streaming/sessions', async (req, res) => {
    try {
        const http = require('http');
        const request = http.get('http://127.0.0.1:5000/sessions', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                try {
                    res.json(JSON.parse(data));
                } catch (e) {
                    res.json({});
                }
            });
        });
        request.on('error', (err) => {
            console.warn("[Streaming API] MediaMTX is offline or port 5000 is unreachable:", err.message);
            res.json({});
        });
    } catch (e) {
        res.json({});
    }
});

// Legacy PHP logic migration: Support Management
app.get('/api/support', (req, res) => {
    try {
        const supportData = fs.readFileSync(path.join(__dirname, 'support.json'), 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(supportData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/support/save', upload.none(), (req, res) => {
    try {
        const { password, action, data } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        if (action === 'save' && data) {
            const jsonPath = path.join(__dirname, 'support.json');
            if (fs.existsSync(jsonPath)) {
                fs.copyFileSync(jsonPath, path.join(__dirname, 'support_backup.json'));
            }
            fs.writeFileSync(jsonPath, data, 'utf8');
            res.json({ success: true, message: 'Datos guardados (respaldo creado)' });
        } else {
            res.json({ success: false, message: 'Datos inválidos' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/support/upload', upload.single('image'), (req, res) => {
    try {
        const password = req.body.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (req.file) {
            const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const host = req.get('host');
            const publicUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
            res.json({ success: true, url: publicUrl });
        } else {
            res.json({ success: false, message: 'No se envió ninguna imagen' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/audit-log', express.json(), (req, res) => {
    try {
        const { agentEmail, agentName, action, details } = req.body;
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${agentEmail || 'Unknown'}] [${agentName || 'Unknown'}] Action: ${action || 'None'} - Details: ${JSON.stringify(details || {})}\n`;

        fs.appendFileSync(path.join(__dirname, 'frontend_audit.log'), logLine, 'utf8');
        res.json({ success: true });
    } catch (e) {
        console.error("Error writing audit log:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/policies', (req, res) => {
    try {
        const policiesPath = path.join(__dirname, 'policies.json');
        if (fs.existsSync(policiesPath)) {
            const data = fs.readFileSync(policiesPath, 'utf8');
            return res.json(JSON.parse(data));
        }
        res.status(404).json({ error: 'Archivo de políticas no encontrado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/policies/save', (req, res) => {
    try {
        const { password, policies } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!policies) return res.status(400).json({ success: false, message: 'Datos de políticas ausentes' });

        const policiesPath = path.join(__dirname, 'policies.json');
        fs.writeFileSync(policiesPath, JSON.stringify(policies, null, 2), 'utf8');

        // Sincronizar automáticamente con knowledge_base.json del bot
        const kbPath = path.join(__dirname, 'knowledge_base.json');
        if (fs.existsSync(kbPath)) {
            try {
                const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
                if (kb.general_policies) {
                    const tcRefunds = policies.terms_and_conditions.find(s => s.title.toLowerCase().includes('reembolso'));
                    if (tcRefunds && tcRefunds.paragraphs && tcRefunds.paragraphs.length > 0) {
                        kb.general_policies.refunds = tcRefunds.paragraphs.join(' ');
                    }
                    const tcHabeas = policies.terms_and_conditions.find(s => s.title.toLowerCase().includes('datos personales') || s.title.toLowerCase().includes('habeas data'));
                    if (tcHabeas && tcHabeas.paragraphs && tcHabeas.paragraphs.length > 0) {
                        kb.general_policies.data_privacy = tcHabeas.paragraphs.join(' ');
                    }
                    fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2), 'utf8');
                }
            } catch (err) {
                console.error('[Policies Save] Error syncing knowledge base:', err.message);
            }
        }

        // Ejecutar script python para regenerar PDFs
        const { exec } = require('child_process');
        const scriptPath = path.join(__dirname, 'scratch', 'generate_pdfs.py');
        exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`[Policies Save] Error regenerando PDFs: ${error.message}`);
                return res.json({ success: true, warning: 'Políticas guardadas y bot actualizado, pero falló la generación de PDFs.', error: error.message });
            }
            console.log(`[Policies Save] PDFs regenerados con éxito: ${stdout}`);
            res.json({ success: true, message: 'Políticas guardadas, bot actualizado y PDFs regenerados con éxito.' });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

async function downloadMediaWithRetry(msg, retries = 3, delay = 1500) {
    if (!msg || !msg.hasMedia) return null;
    for (let i = 0; i < retries; i++) {
        try {
            const media = await Promise.race([
                msg.downloadMedia(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (25s)")), 25000))
            ]);
            if (media && media.data) {
                return media;
            }
        } catch (err) {
            console.warn(`[Media Download] Intento ${i + 1}/${retries} fallido: ${err.message}`);
        }
        if (i < retries - 1) {
            await new Promise(res => setTimeout(res, delay));
        }
    }
    return null;
}

async function resolveJidForPhone(phone) {
    if (!phone) return '';
    const cleanPhone = phone.replace(/\D/g, '').slice(-10);
    const fullClean = phone.replace(/\D/g, '');

    // 1. Si es un LID explícito pero existe un mapeo en chats
    if (phone.includes('@lid')) {
        try {
            const [chatRows] = await pool.query(
                `SELECT chat_id FROM chats WHERE chat_id = ? OR customer_phone LIKE ? LIMIT 1`,
                [phone.trim().toLowerCase(), `%${cleanPhone}%`]
            );
            if (chatRows.length > 0 && chatRows[0].chat_id) return chatRows[0].chat_id;
        } catch (e) { }
        return phone.trim().toLowerCase();
    }

    // 2. Validar primero en la base de datos chats por customer_phone o chat_id
    if (cleanPhone) {
        try {
            const [chatRows] = await pool.query(
                `SELECT chat_id FROM chats WHERE customer_phone = ? OR customer_phone = ? OR customer_phone LIKE ? OR chat_id LIKE ? ORDER BY updated_at DESC LIMIT 1`,
                [fullClean, cleanPhone, `%${cleanPhone}%`, `%${cleanPhone}%`]
            );
            if (chatRows.length > 0 && chatRows[0].chat_id) {
                return chatRows[0].chat_id;
            }
        } catch (err) {
            console.error("[resolveJidForPhone] Error en DB query:", err.message);
        }
    }

    if (phone.includes('@c.us')) {
        return phone.trim().toLowerCase();
    }

    const userId = (fullClean || cleanPhone) + '@c.us';

    // 3. Validar en userStates en memoria
    const state = userStates.get(userId) || userStates.get(cleanPhone + '@lid');
    if (state && state.chatJid) {
        return state.chatJid;
    }

    // 4. Fallback: Buscar en client.getChats() del navegador de Puppeteer
    if (client && client.info) {
        try {
            const chats = await client.getChats();
            for (const chat of chats) {
                if (chat.isGroup) continue;
                let matchFound = chat.id.user.includes(cleanPhone) || cleanPhone.includes(chat.id.user);
                
                // Búsqueda inteligente por número de contacto real en chats tipo @lid
                if (!matchFound && chat.id._serialized.endsWith('@lid')) {
                    try {
                        const contact = await Promise.race([
                            chat.getContact(),
                            new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), 800))
                        ]).catch(() => null);
                        if (contact && contact.number && (contact.number.includes(cleanPhone) || cleanPhone.includes(contact.number))) {
                            matchFound = true;
                        }
                    } catch (e) { }
                }

                if (matchFound) {
                    // Actualizar mapeo en base de datos previniendo violación de FK
                    const [custExists] = await pool.query('SELECT phone FROM customers WHERE phone = ?', [cleanPhone]);
                    if (custExists.length > 0) {
                        await pool.query(
                            `INSERT INTO chats (chat_id, customer_phone, last_message_time) 
                              VALUES (?, ?, NOW()) 
                              ON DUPLICATE KEY UPDATE customer_phone = VALUES(customer_phone)`,
                            [chat.id._serialized, cleanPhone]
                        );
                    } else {
                        await pool.query(
                            `INSERT INTO chats (chat_id, last_message_time) 
                              VALUES (?, NOW()) 
                              ON DUPLICATE KEY UPDATE last_message_time = NOW()`,
                            [chat.id._serialized]
                        );
                    }

                    // Actualizar en userStates
                    const rawState = userStates.get(userId) || userStates.get(chat.id._serialized);
                    if (rawState && typeof rawState === 'object') {
                        rawState.chatJid = chat.id._serialized;
                        userStates.set(chat.id._serialized, rawState);
                    } else {
                        userStates.set(chat.id._serialized, { chatJid: chat.id._serialized });
                    }
                    return chat.id._serialized;
                }
            }
        } catch (chatsErr) {
            console.error("[resolveJidForPhone] Error en client.getChats:", chatsErr.message);
        }
    }

    return userId; // Fallback final
}

app.get('/api/admin/chat-messages', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const rawPhone = phone.trim();
        const targetChatId = await resolveJidForPhone(rawPhone);
        const cleanDigits = rawPhone.replace(/\D/g, '');
        const clean10 = cleanDigits.slice(-10);

        // 1. Obtener el historial de la base de datos buscando por todos los posibles identificadores del chat
        let [rows] = await pool.query(
            `SELECT * FROM messages 
             WHERE chat_id = ? 
                OR chat_id = ? 
                OR chat_id = ? 
                OR chat_id = ?
                OR (LENGTH(?) >= 10 AND (chat_id LIKE ? OR sender_id LIKE ?))
             ORDER BY created_at DESC LIMIT 60`,
            [
                rawPhone,
                targetChatId,
                `${cleanDigits}@lid`,
                `${cleanDigits}@c.us`,
                clean10,
                `%${clean10}%`,
                `%${clean10}%`
            ]
        );

        // 2. REGLA MULTIVERSAL: Auto-sincronización en vivo con WhatsApp Puppeteer si la BD no tiene mensajes
        if ((!rows || rows.length === 0) && client && client.info) {
            try {
                console.log(`[Auto-Sync Universal] 🔄 Sincronizando historial en vivo para @${phone} (JID: ${targetChatId})...`);
                let liveChat = null;
                const candidates = [targetChatId, rawPhone, `${cleanDigits}@lid`, `57${clean10}@c.us`, `${clean10}@c.us`].filter(Boolean);
                for (const cId of candidates) {
                    try {
                        liveChat = await client.getChatById(cId);
                        if (liveChat) break;
                    } catch (e) {}
                }

                if (liveChat) {
                    await liveChat.syncHistory().catch(() => { });
                    const liveMsgs = await liveChat.fetchMessages({ limit: 60 }).catch(() => []);

                    for (const m of liveMsgs) {
                        try {
                            await saveMessage(m);
                        } catch (sErr) { }
                    }

                    // Vincular customer_phone en tabla chats si es un chat LID
                    if (clean10 && liveChat.id && liveChat.id._serialized) {
                        try {
                            await pool.query(
                                `INSERT INTO chats (chat_id, customer_phone, last_message_time) 
                                  VALUES (?, ?, NOW()) 
                                  ON DUPLICATE KEY UPDATE customer_phone = VALUES(customer_phone)`,
                                [liveChat.id._serialized, clean10.length === 10 ? '57' + clean10 : clean10]
                            );
                        } catch (e) { }
                    }

                    // Re-consultar la base de datos recién actualizada
                    [rows] = await pool.query(
                        `SELECT * FROM messages 
                         WHERE chat_id = ? 
                            OR chat_id = ? 
                            OR chat_id = ? 
                            OR (LENGTH(?) >= 10 AND chat_id LIKE ?) 
                         ORDER BY created_at DESC LIMIT 60`,
                        [rawPhone, targetChatId, liveChat.id._serialized, clean10, `%${clean10}%`]
                    );
                }
            } catch (syncErr) {
                console.error("[Auto-Sync Universal] Error durante sincronización en vivo:", syncErr.message);
            }
        }

        const formatted = (rows || []).map(m => ({
            id: m.message_id || `msg_${m.id}`,
            body: m.body || (m.media_path ? '📷 Foto / Archivo' : ''),
            fromMe: m.is_from_me === 1 || m.direction === 'outbound',
            timestamp: new Date(m.created_at).getTime(),
            type: m.message_type || (m.media_path ? 'media' : 'text'),
            hasMedia: !!m.media_path,
            mediaPath: m.media_path,
            mediaMime: m.media_mime
        })).reverse();

        return res.json(formatted);
    } catch (err) {
        console.error("Error fetching chat messages from DB:", err.message);
        return res.status(500).json({ error: 'Error interno al obtener los mensajes del chat' });
    }
});

app.post('/api/admin/chat-messages/sync', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        if (!client || !client.info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const targetChatId = await resolveJidForPhone(phone);

        const chat = await client.getChatById(targetChatId);
        await chat.syncHistory().catch(() => { });
        const messages = await chat.fetchMessages({ limit: 50 });

        // Guardar/actualizar en base de datos de manera secuencial para no saturar
        for (const msg of messages) {
            try {
                await saveMessage(msg);
            } catch (err) {
                console.error("Error guardando mensaje en sincronización:", err.message);
            }
        }

        // Recuperar historial actualizado desde la base de datos usando el ID resuelto
        const [rows] = await pool.query(
            `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 40`,
            [targetChatId]
        );

        const formatted = rows.map(m => ({
            id: m.message_id,
            body: m.body || "",
            fromMe: m.direction ? (m.direction === 'outbound') : (m.is_from_me === 1 || m.isFromMe === 1),
            timestamp: new Date(m.created_at).getTime(),
            type: m.message_type || 'text',
            hasMedia: !!m.media_path,
            mediaPath: m.media_path,
            mediaMime: m.media_mime
        }));

        formatted.reverse();
        res.json({ success: true, messages: formatted });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/chat-messages/send', async (req, res) => {
    try {
        const { phone, message, emoji, agentName, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!phone || !message) return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });

        if (!client || !client.info) {
            return res.status(503).json({ success: false, message: 'WhatsApp client is not ready' });
        }

        const targetChatId = await resolveJidForPhone(phone);

        // Concatenar el emoji del asesor si está presente
        const prefix = emoji ? `${emoji.trim()} ` : "";
        const finalMessage = prefix + message;

        await client.sendMessage(targetChatId, finalMessage);

        // Silenciar el bot para este usuario (modo advisor) ya que hay interacción manual
        const currentState = userStates.get(targetChatId) || {};
        userStates.set(targetChatId, {
            ...currentState,
            state: 'waiting_human',
            waitingCount: 0,
            lastHumanInteraction: Date.now(),
            waiting_human_mode: 'advisor',
            agent: agentName || currentState.agent || null,
            lastMessage: finalMessage,
            lastMessageTime: Date.now()
        });

        // Remover de la cola de soporte activo si está en ella
        if (global.supportQueue) {
            const qIdx = global.supportQueue.indexOf(targetChatId);
            if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
        }

        res.json({ success: true, message: 'Mensaje enviado correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/chat-messages/send-audio', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { phone, audio, mimetype, agentName, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!phone || !audio || !mimetype) return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        if (!client || !client.info) {
            return res.status(503).json({ success: false, message: 'WhatsApp client is not ready' });
        }

        // Parse base64
        let base64Data = audio;
        if (audio.includes('base64,')) {
            base64Data = audio.split('base64,')[1];
        }

        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        const uploadDir = path.join(__dirname, 'uploads', 'media');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const tempId = Date.now();
        const tempRawPath = path.join(uploadDir, `temp_raw_${tempId}`);
        const tempOpusPath = path.join(uploadDir, `temp_opus_${tempId}.ogg`);

        // Write raw WebM/audio data to temporary file
        fs.writeFileSync(tempRawPath, Buffer.from(base64Data, 'base64'));

        // Convert raw WebM to proper Ogg/Opus voice note
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${tempRawPath}" -c:a libopus -b:a 64k "${tempOpusPath}"`, (err, stdout, stderr) => {
                if (err) {
                    console.error("[send-audio] ffmpeg error:", stderr);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        // Read the proper Opus Ogg file
        const opusBuffer = fs.readFileSync(tempOpusPath);
        const base64Opus = opusBuffer.toString('base64');

        // Delete temporary files
        try {
            if (fs.existsSync(tempRawPath)) fs.unlinkSync(tempRawPath);
            if (fs.existsSync(tempOpusPath)) fs.unlinkSync(tempOpusPath);
        } catch (delErr) {
            console.error("[send-audio] Error cleaning temp files:", delErr);
        }

        const { MessageMedia } = require('whatsapp-web.js');
        const media = new MessageMedia('audio/ogg; codecs=opus', base64Opus, 'voice.ogg');

        const targetChatId = await resolveJidForPhone(phone);

        // Send audio as voice note
        const msg = await client.sendMessage(targetChatId, media, { sendAudioAsVoice: true });

        // Save proper audio file in uploads directory
        const fileName = `${Date.now()}_voice.ogg`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, opusBuffer);

        // Save message to MySQL using targetChatId
        try {
            await pool.query(
                `INSERT INTO messages (message_id, chat_id, body, is_from_me, created_at, message_type, media_path, media_mime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    msg.id ? msg.id._serialized : `voice_${Date.now()}`,
                    targetChatId,
                    "",
                    1,
                    new Date(),
                    'audio',
                    `uploads/media/${fileName}`,
                    mimetype
                ]
            );
        } catch (dbErr) {
            console.error("Error guardando nota de voz enviada en DB:", dbErr.message);
        }

        // Silenciar bot para este usuario (modo advisor)
        const currentState = userStates.get(userId) || {};
        userStates.set(userId, {
            state: 'waiting_human',
            waitingCount: 0,
            lastHumanInteraction: Date.now(),
            waiting_human_mode: 'advisor',
            agent: agentName || currentState.agent || null,
            lastMessage: "🎙️ Nota de voz",
            lastMessageTime: Date.now()
        });

        if (global.supportQueue) {
            const qIdx = global.supportQueue.indexOf(userId);
            if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
        }

        res.json({ success: true, message: 'Nota de voz enviada correctamente' });
    } catch (e) {
        console.error("[send-audio] Error sending voice note:", e);
        res.status(500).json({ success: false, message: e.message || String(e) });
    }
});

app.post('/api/admin/chat-messages/delete', express.json(), async (req, res) => {
    try {
        const { messageId, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!messageId) return res.status(400).json({ success: false, message: 'Falta el id del mensaje' });

        // Intentar eliminar para todos (revoke) en WhatsApp Web
        try {
            const msg = await client.getMessageById(messageId);
            if (msg) {
                await msg.delete(true);
            }
        } catch (waErr) {
            console.error('[Delete Message WA] No se pudo borrar el mensaje en WhatsApp:', waErr.message);
        }

        await pool.query('DELETE FROM messages WHERE message_id = ?', [messageId]);
        res.json({ success: true, message: 'Mensaje eliminado correctamente de WhatsApp y la base de datos' });
    } catch (e) {
        console.error('[Delete Message] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/chat-messages/edit', express.json(), async (req, res) => {
    try {
        const { messageId, newBody, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!messageId || !newBody) return res.status(400).json({ success: false, message: 'Faltan parámetros' });

        // Intentar editar en WhatsApp Web
        try {
            const msg = await client.getMessageById(messageId);
            if (msg) {
                await msg.edit(newBody);
            }
        } catch (waErr) {
            console.error('[Edit Message WA] No se pudo editar el mensaje en WhatsApp:', waErr.message);
        }

        await pool.query('UPDATE messages SET body = ? WHERE message_id = ?', [newBody, messageId]);
        res.json({ success: true, message: 'Mensaje editado correctamente en WhatsApp y la base de datos' });
    } catch (e) {
        console.error('[Edit Message] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});


// ==========================================
// WHATSAPP SAAS CONNECTION SYSTEM (QR / OTP)
// ==========================================

let currentWhatsappStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, PAIRING_CODE_READY, CONNECTED
let latestQrCode = null;
let latestPairingCode = null;
let activeSseClients = [];

function broadcastSseEvent(type, data) {
    activeSseClients.forEach(client => {
        try {
            client.write(`event: ${type}\n`);
            client.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
            console.error('Error enviando datos SSE:', err.message);
        }
    });
}

app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        status: currentWhatsappStatus,
        qr: latestQrCode,
        pairingCode: latestPairingCode
    });
});

app.get('/api/whatsapp/status-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const initialState = {
        status: currentWhatsappStatus,
        qr: latestQrCode,
        pairingCode: latestPairingCode
    };
    res.write(`event: status\n`);
    res.write(`data: ${JSON.stringify(initialState)}\n\n`);

    activeSseClients.push(res);

    req.on('close', () => {
        activeSseClients = activeSseClients.filter(c => c !== res);
    });
});

app.post('/api/whatsapp/request-pairing-code', express.json(), async (req, res) => {
    try {
        const { phone, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });

        const cleanPhone = phone.replace(/\D/g, '');

        if (!client) {
            return res.status(503).json({ success: false, message: 'El cliente de WhatsApp no está inicializado' });
        }

        console.log(`[Pairing Code] Solicitando código de vinculación para: ${cleanPhone}`);
        currentWhatsappStatus = 'CONNECTING';
        broadcastSseEvent('status', { status: currentWhatsappStatus });

        const code = await client.requestPairingCode(cleanPhone);
        if (code) {
            latestPairingCode = code;
            latestQrCode = null;
            currentWhatsappStatus = 'PAIRING_CODE_READY';
            broadcastSseEvent('status', { status: currentWhatsappStatus, pairingCode: code });
            return res.json({ success: true, pairingCode: code });
        }

        res.json({ success: true, message: 'Solicitud enviada al servidor de WhatsApp...' });
    } catch (e) {
        console.error('Error al solicitar código de vinculación:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/whatsapp/restart', express.json(), async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        console.log('🔄 Reinicio del bot solicitado desde la interfaz web...');
        res.json({ success: true, message: 'Reiniciando el bot para regenerar el código QR...' });

        setTimeout(() => {
            process.exit(1);
        }, 1000);
    } catch (e) {
        console.error('Error al procesar reinicio del bot:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Inicialización de la base de datos para SaaS
(async () => {
    try {
        const { pool } = require('./database');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS system_configs (
                cfg_key VARCHAR(50) PRIMARY KEY,
                cfg_value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rpa_recipes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                platform VARCHAR(50) NOT NULL,
                recipe_json JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agents (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                fullname VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NULL,
                role ENUM('admin', 'agent', 'supervisor', 'trial') DEFAULT 'agent',
                status ENUM('active', 'inactive', 'busy') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            INSERT INTO agents (username, fullname, email, role) VALUES 
            ('estebanavila182', 'Esteban', 'estebanavila182@outlook.com', 'admin'),
            ('esclepiades', 'Esclepiades', 'esclepiades@hotmail.com', 'agent'),
            ('camilo', 'Camilo', 'camco08@hotmail.com', 'agent'),
            ('carolcubillos03', 'Carol Cubillos', 'carolcubillos03@outlook.es', 'agent')
            ON DUPLICATE KEY UPDATE 
                fullname = VALUES(fullname),
                email = VALUES(email)
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS provider_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                platform VARCHAR(50) NOT NULL,
                provider_name VARCHAR(100) NOT NULL,
                username VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agent_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                agent_id INT NOT NULL,
                day_of_week TINYINT NOT NULL,
                start_time VARCHAR(10) NOT NULL,
                end_time VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS web_sales_pending (
                order_id VARCHAR(50) PRIMARY KEY,
                firstName VARCHAR(100) NOT NULL,
                lastName VARCHAR(100) NOT NULL,
                email VARCHAR(255) NOT NULL,
                whatsapp VARCHAR(50) NOT NULL,
                platformName VARCHAR(100) NOT NULL,
                amount INT NOT NULL,
                numbersStr TEXT NOT NULL,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS web_sales_approved (
                order_id VARCHAR(50) PRIMARY KEY,
                firstName VARCHAR(100) NOT NULL,
                lastName VARCHAR(100) NOT NULL,
                email VARCHAR(255) NOT NULL,
                whatsapp VARCHAR(50) NOT NULL,
                platformName VARCHAR(100) NOT NULL,
                amount INT NOT NULL,
                numbersStr TEXT NOT NULL,
                createdAt TIMESTAMP NULL,
                approvedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS resolved_tickets_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                phone VARCHAR(50) NOT NULL,
                customerName VARCHAR(150) NOT NULL,
                agent VARCHAR(100) NOT NULL,
                resolvedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS heavy_tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT NULL,
                status ENUM('pending', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending',
                priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
                assigned_agent VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS heavy_ticket_comments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                agent_name VARCHAR(100) NOT NULL,
                comment TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES heavy_tickets(id) ON DELETE CASCADE
            )
        `);

        // Check and add phone column to provider_credentials if it doesn't exist
        try {
            const [cols] = await pool.query("SHOW COLUMNS FROM provider_credentials");
            const hasPhone = cols.some(c => c.Field === 'phone');
            if (!hasPhone) {
                console.log("[Migration] Adding phone column to provider_credentials...");
                await pool.query("ALTER TABLE provider_credentials ADD COLUMN phone VARCHAR(50) NULL");
            }
        } catch (err) {
            console.error("[Migration] Error checking/altering provider_credentials table:", err.message);
        }

        // Check and add break columns to agent_schedules if they don't exist
        try {
            const [cols] = await pool.query("SHOW COLUMNS FROM agent_schedules");
            const hasBreakType = cols.some(c => c.Field === 'break_type');
            if (!hasBreakType) {
                console.log("[Migration] Adding break_type and break_start to agent_schedules...");
                await pool.query("ALTER TABLE agent_schedules ADD COLUMN break_type ENUM('none', 'break_30', 'lunch_60', 'lunch_120') DEFAULT 'none'");
                await pool.query("ALTER TABLE agent_schedules ADD COLUMN break_start VARCHAR(10) NULL");
            }
        } catch (err) {
            console.error("[Migration] Error checking/altering agent_schedules table for break columns:", err.message);
        }

        // Check and add week_start column and constraints to agent_schedules if it doesn't exist
        try {
            const [cols] = await pool.query("SHOW COLUMNS FROM agent_schedules");
            const hasWeekStart = cols.some(c => c.Field === 'week_start');
            if (!hasWeekStart) {
                console.log("[Migration] Adding week_start column to agent_schedules...");
                await pool.query("ALTER TABLE agent_schedules ADD COLUMN week_start VARCHAR(20) NOT NULL DEFAULT 'default'");

                // Drop unique key unique_agent_day_slot if exists
                try {
                    await pool.query("ALTER TABLE agent_schedules DROP INDEX unique_agent_day_slot");
                } catch (e) {
                    console.log("[Migration] Old index unique_agent_day_slot not found or couldn't drop:", e.message);
                }

                // Add unique key unique_agent_week_day_slot
                await pool.query("ALTER TABLE agent_schedules ADD UNIQUE KEY unique_agent_week_day_slot (agent_id, week_start, day_of_week, start_time, end_time)");
            }
        } catch (err) {
            console.error("[Migration] Error checking/altering agent_schedules table for week_start:", err.message);
        }

        // Check and add exclude_from_payroll & password_hash columns to agents if they don't exist
        try {
            const [cols] = await pool.query("SHOW COLUMNS FROM agents");
            const hasExcludePayroll = cols.some(c => c.Field === 'exclude_from_payroll');
            if (!hasExcludePayroll) {
                console.log("[Migration] Adding exclude_from_payroll column to agents...");
                await pool.query("ALTER TABLE agents ADD COLUMN exclude_from_payroll TINYINT(1) NOT NULL DEFAULT 0");
            }
            const hasPasswordHash = cols.some(c => c.Field === 'password_hash');
            if (!hasPasswordHash) {
                console.log("[Migration] Adding password_hash column to agents...");
                await pool.query("ALTER TABLE agents ADD COLUMN password_hash VARCHAR(255) NULL");
            }
        } catch (err) {
            console.error("[Migration] Error adding columns to agents:", err.message);
        }

        // Create agent_bonuses and monthly_payroll tables
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agent_bonuses (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    agent_id INT NOT NULL,
                    bonus_month VARCHAR(7) NOT NULL,
                    amount DECIMAL(10,2) NOT NULL,
                    reason VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agent_contract_history (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    agent_id INT NOT NULL,
                    action ENUM('terminated', 'reactivated', 'role_change', 'updated') NOT NULL,
                    status VARCHAR(50) NOT NULL,
                    reason TEXT NULL,
                    performed_by VARCHAR(255) DEFAULT 'admin',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS system_activity_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    agent_email VARCHAR(255) NOT NULL,
                    agent_name VARCHAR(255) NULL,
                    action_type VARCHAR(100) NOT NULL,
                    description TEXT NOT NULL,
                    metadata JSON NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS monthly_payroll (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    agent_id INT NOT NULL,
                    payroll_month VARCHAR(7) NOT NULL,
                    start_date DATE NULL,
                    end_date DATE NULL,
                    total_hours DECIMAL(10,2) NOT NULL,
                    trial_hours DECIMAL(10,2) DEFAULT 0,
                    normal_hours DECIMAL(10,2) DEFAULT 0,
                    hourly_rate DECIMAL(10,2) NOT NULL,
                    total_bonuses DECIMAL(10,2) NOT NULL,
                    total_payment DECIMAL(10,2) NOT NULL,
                    period_label VARCHAR(100) NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'draft',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
                )
            `);
            const [mpCols] = await pool.query("SHOW COLUMNS FROM monthly_payroll");
            const hasStartDate = mpCols.some(c => c.Field === 'start_date');
            if (!hasStartDate) {
                console.log("[Migration] Adding start_date, end_date, trial_hours, normal_hours, period_label to monthly_payroll...");
                await pool.query("ALTER TABLE monthly_payroll ADD COLUMN start_date DATE NULL");
                await pool.query("ALTER TABLE monthly_payroll ADD COLUMN end_date DATE NULL");
                await pool.query("ALTER TABLE monthly_payroll ADD COLUMN trial_hours DECIMAL(10,2) DEFAULT 0");
                await pool.query("ALTER TABLE monthly_payroll ADD COLUMN normal_hours DECIMAL(10,2) DEFAULT 0");
                await pool.query("ALTER TABLE monthly_payroll ADD COLUMN period_label VARCHAR(100) NULL");
                try {
                    await pool.query("ALTER TABLE monthly_payroll DROP INDEX unique_agent_month");
                } catch (e) {}
            }
        } catch (err) {
            console.error("[Migration] Error creating/altering payroll and bonuses tables:", err.message);
        }

        // Check and add max_weekly_hours column to agents table if it doesn't exist
        try {
            const [cols] = await pool.query("SHOW COLUMNS FROM agents");
            const hasMaxHours = cols.some(c => c.Field === 'max_weekly_hours');
            if (!hasMaxHours) {
                console.log("[Migration] Adding max_weekly_hours column to agents...");
                await pool.query("ALTER TABLE agents ADD COLUMN max_weekly_hours DECIMAL(5,2) NOT NULL DEFAULT 40.00");
                await pool.query("UPDATE agents SET max_weekly_hours = 18.00 WHERE username LIKE '%camilo%' OR email LIKE '%camilo%'");
            }
        } catch (err) {
            console.error("[Migration] Error checking/altering agents table for max_weekly_hours:", err.message);
        }


        // --- MIGRACIÓN ÚNICA DE JSON A SQL ---
        const pendingFile = path.join(__dirname, 'pending_sales.json');
        if (fs.existsSync(pendingFile)) {
            try {
                const data = fs.readFileSync(pendingFile, 'utf8');
                const salesMap = new Map(Object.entries(JSON.parse(data || '{}')));
                for (const [orderId, customerData] of salesMap.entries()) {
                    await pool.query(
                        'INSERT INTO web_sales_pending (order_id, firstName, lastName, email, whatsapp, platformName, amount, numbersStr) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE order_id=order_id',
                        [
                            orderId,
                            customerData.firstName || '',
                            customerData.lastName || '',
                            customerData.email || '',
                            customerData.whatsapp || '',
                            customerData.platformName || '',
                            customerData.amount || 0,
                            customerData.numbersStr || ''
                        ]
                    );
                }
                fs.renameSync(pendingFile, pendingFile + '.bak');
                console.log("✅ Migración de pending_sales.json a MySQL completada con éxito.");
            } catch (e) {
                console.error("Error migrating pending_sales.json:", e.message);
            }
        }

        const approvedFile = path.join(__dirname, 'approved_sales.json');
        if (fs.existsSync(approvedFile)) {
            try {
                const list = JSON.parse(fs.readFileSync(approvedFile, 'utf8') || '[]');
                for (const sale of list) {
                    await pool.query(
                        'INSERT INTO web_sales_approved (order_id, firstName, lastName, email, whatsapp, platformName, amount, numbersStr, createdAt, approvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE order_id=order_id',
                        [
                            sale.orderId,
                            sale.firstName || '',
                            sale.lastName || '',
                            sale.email || '',
                            sale.whatsapp || '',
                            sale.platformName || '',
                            sale.amount || 0,
                            sale.numbersStr || '',
                            sale.createdAt ? new Date(sale.createdAt) : null,
                            sale.approvedAt ? new Date(sale.approvedAt) : new Date()
                        ]
                    );
                }
                fs.renameSync(approvedFile, approvedFile + '.bak');
                console.log("✅ Migración de approved_sales.json a MySQL completada con éxito.");
            } catch (e) {
                console.error("Error migrating approved_sales.json:", e.message);
            }
        }

        console.log('✅ Base de datos: Tablas de configuración SaaS, agentes, horarios, proveedores y transacciones web verificados.');
    } catch (err) {
        console.error('❌ Base de datos: Error al verificar/crear tablas SaaS:', err.message);
    }
})();

// GET Agent Role
app.get('/api/admin/agent-role', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });

        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT role FROM agents WHERE email = ?', [email.trim().toLowerCase()]);

        if (rows && rows.length > 0) {
            return res.json({ success: true, role: rows[0].role });
        }

        // Si no está registrado en base de datos, verificar si está en la lista estática (como fallback seguro)
        const cleanEmail = email.trim().toLowerCase();
        if (cleanEmail === 'estebanavila182@outlook.com') {
            return res.json({ success: true, role: 'admin' });
        }

        res.json({ success: true, role: 'agent' }); // Rol mínimo por defecto
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET All Agents
app.get('/api/admin/agents', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT id, username, fullname, email, role, status, exclude_from_payroll FROM agents ORDER BY fullname ASC');
        res.json({ success: true, agents: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Agent Schedule
app.get('/api/admin/agents/schedule', async (req, res) => {
    try {
        const { email, week_start } = req.query;
        const weekStartStr = week_start || 'default';
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });

        const { pool } = require('./database');
        const [agentRows] = await pool.query('SELECT id FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.json({ success: true, schedule: [] });
        }

        const agentId = agentRows[0].id;
        let [scheduleRows] = await pool.query(
            'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = ? ORDER BY day_of_week ASC, start_time ASC',
            [agentId, weekStartStr]
        );
        let isTemplate = false;
        if (scheduleRows.length === 0 && weekStartStr !== 'default') {
            [scheduleRows] = await pool.query(
                'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = \'default\' ORDER BY day_of_week ASC, start_time ASC',
                [agentId]
            );
            isTemplate = true;
        }

        res.json({ success: true, schedule: scheduleRows, is_template: isTemplate });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET All Agent Schedules
app.get('/api/admin/agents/schedules/all', async (req, res) => {
    try {
        const week_start = req.query.week_start || 'default';
        const { pool } = require('./database');

        const [agents] = await pool.query('SELECT id, username, fullname, email, role, status FROM agents');
        const allSchedules = [];

        for (const agent of agents) {
            let [scheduleRows] = await pool.query(
                'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = ? ORDER BY day_of_week ASC, start_time ASC',
                [agent.id, week_start]
            );
            if (scheduleRows.length === 0 && week_start !== 'default') {
                [scheduleRows] = await pool.query(
                    'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = \'default\' ORDER BY day_of_week ASC, start_time ASC',
                    [agent.id]
                );
            }
            for (const row of scheduleRows) {
                allSchedules.push({
                    id: row.id,
                    day_of_week: row.day_of_week,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    break_type: row.break_type,
                    break_start: row.break_start,
                    fullname: agent.fullname,
                    email: agent.email,
                    role: agent.role
                });
            }
        }
        res.json({ success: true, schedules: allSchedules });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Agent Schedule
app.post('/api/admin/agents/schedule/save', express.json(), async (req, res) => {
    try {
        const { email, schedule, week_start, requester_email, day_of_week } = req.body;
        const weekStartStr = week_start || 'default';
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });
        if (!Array.isArray(schedule)) return res.status(400).json({ success: false, message: 'El horario debe ser una lista de franjas' });

        const { pool } = require('./database');

        // Authorization check to ensure advisors cannot edit each other
        if (requester_email) {
            const [reqRows] = await pool.query('SELECT role FROM agents WHERE email = ?', [requester_email.trim().toLowerCase()]);
            const isReqAdmin = reqRows.length > 0 && reqRows[0].role === 'admin';
            const isSelf = requester_email.trim().toLowerCase() === email.trim().toLowerCase();
            if (!isReqAdmin && !isSelf) {
                return res.status(403).json({ success: false, message: 'No tienes permiso para modificar el horario de otro colaborador.' });
            }
        }
        let [agentRows] = await pool.query('SELECT id FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        let agentId;
        if (!agentRows || agentRows.length === 0) {
            const username = email.split('@')[0];
            const [insertRes] = await pool.query(
                'INSERT INTO agents (username, fullname, email, role) VALUES (?, ?, ?, ?)',
                [username, username, email.trim().toLowerCase(), 'agent']
            );
            agentId = insertRes.insertId;
        } else {
            agentId = agentRows[0].id;
        }

        // Support Config and Roles lookup
        const { getSupportScheduleConfig } = require('./supportScheduleService');
        const supportConfig = getSupportScheduleConfig();

        const [allAgents] = await pool.query('SELECT id, role, fullname FROM agents');
        const agentMap = {};
        allAgents.forEach(a => {
            agentMap[a.id] = { role: a.role, fullname: a.fullname };
        });

        const currentAgentRole = agentMap[agentId]?.role || 'agent';

        // 1. Validaciones previas de franja horaria y descanso antes de tocar la base de datos
        for (const slot of schedule) {
            const dayOfWeek = parseInt(slot.day_of_week);
            if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

            // Restringir validación de la franja horaria 10-22 al día editado en el modal
            if (day_of_week !== undefined && dayOfWeek !== parseInt(day_of_week)) continue;

            const startTime = slot.start_time;
            const endTime = slot.end_time;
            if (!startTime || !endTime) continue;

            const breakType = slot.break_type || 'none';
            const breakStart = slot.break_start || null;

            const [shVal, smVal] = startTime.split(':').map(Number);
            const [ehVal, emVal] = endTime.split(':').map(Number);

            // Franja dinámica configurable
            const configStartLimit = supportConfig.shift_start_limit || "08:00";
            const configEndLimit = supportConfig.shift_end_limit || "22:00";
            const [startLimitH, startLimitM] = configStartLimit.split(':').map(Number);
            const [endLimitH, endLimitM] = configEndLimit.split(':').map(Number);

            const startMinTotal = shVal * 60 + smVal;
            const endMinTotal = ehVal * 60 + emVal;
            const limitStartMinTotal = startLimitH * 60 + startLimitM;
            const limitEndMinTotal = endLimitH * 60 + endLimitM;

            if (startMinTotal < limitStartMinTotal || endMinTotal > limitEndMinTotal) {
                return res.status(400).json({
                    success: false,
                    message: `Los turnos de soporte deben estar estrictamente dentro de la franja permitida de ${configStartLimit} a ${configEndLimit}.`
                });
            }

            const durationHoursVal = (ehVal * 60 + emVal - (shVal * 60 + smVal)) / 60;
            if (durationHoursVal >= 5 && breakType === 'none') {
                return res.status(400).json({
                    success: false,
                    message: `Los turnos de 5 horas o más deben incluir obligatoriamente un descanso por salud mental.`
                });
            }

            if (breakType !== 'none' && breakStart) {
                const [bh, bm] = breakStart.split(':').map(Number);
                const startMin = shVal * 60 + smVal;
                const endMin = ehVal * 60 + emVal;
                const breakStartMin = bh * 60 + bm;
                const duration = breakType === 'break_30' ? 30 : 60;
                const buffer = 90; // 90 mins = 1.5 hours buffer
                if (breakStartMin < startMin + buffer || breakStartMin > endMin - duration - buffer) {
                    return res.status(400).json({
                        success: false,
                        message: `La hora de descanso no puede estar al inicio ni al final de la franja laboral.`
                    });
                }
            }
        }

        // Group incoming slots by day to validate overlaps and sum of hours with existing schedules
        const incomingSlotsByDay = new Map();
        for (const slot of schedule) {
            const day = parseInt(slot.day_of_week);
            if (isNaN(day)) continue;
            if (!incomingSlotsByDay.has(day)) incomingSlotsByDay.set(day, []);
            incomingSlotsByDay.get(day).push(slot);
        }

        for (const [dayOfWeek, daySlots] of incomingSlotsByDay.entries()) {
            // Restringir validaciones al día editado en el modal para evitar deadlocks con datos heredados de otros días
            if (day_of_week !== undefined && dayOfWeek !== parseInt(day_of_week)) {
                continue;
            }
            // Get other agents' schedules for this specific day and week
            const [otherSchedulesRaw] = await pool.query(
                `SELECT s.*, a.role, a.fullname FROM agent_schedules s 
                 JOIN agents a ON s.agent_id = a.id 
                 WHERE (s.week_start = ? OR s.week_start = "default") 
                   AND s.agent_id != ? 
                   AND s.day_of_week = ?`,
                [weekStartStr, agentId, dayOfWeek]
            );

            // Filter otherSchedules per agent: if weekStartStr !== 'default' and custom slots exist for that week, override 'default'
            const customByAgent = new Map();
            const defaultByAgent = new Map();

            for (const s of otherSchedulesRaw) {
                if (s.week_start === weekStartStr) {
                    if (!customByAgent.has(s.agent_id)) customByAgent.set(s.agent_id, []);
                    customByAgent.get(s.agent_id).push(s);
                } else {
                    if (!defaultByAgent.has(s.agent_id)) defaultByAgent.set(s.agent_id, []);
                    defaultByAgent.get(s.agent_id).push(s);
                }
            }

            const otherSchedules = [];
            const otherAgentIds = new Set([...customByAgent.keys(), ...defaultByAgent.keys()]);
            for (const otherId of otherAgentIds) {
                const slots = (weekStartStr !== 'default' && customByAgent.has(otherId))
                    ? customByAgent.get(otherId)
                    : (defaultByAgent.has(otherId) ? defaultByAgent.get(otherId) : customByAgent.get(otherId));
                if (slots) otherSchedules.push(...slots);
            }

            // Merge current agent's new slots and other agents' slots to check validation
            const mergedSlots = [
                ...daySlots.map(s => ({
                    agent_id: agentId,
                    role: currentAgentRole,
                    fullname: agentMap[agentId]?.fullname || 'Este Asesor',
                    start_time: s.start_time,
                    end_time: s.end_time,
                    break_type: s.break_type
                })),
                ...otherSchedules.map(s => ({
                    agent_id: s.agent_id,
                    role: s.role,
                    fullname: s.fullname,
                    start_time: s.start_time.substring(0, 5),
                    end_time: s.end_time.substring(0, 5),
                    break_type: s.break_type
                }))
            ];

            // 1. Validate overlaps
            for (let i = 0; i < mergedSlots.length; i++) {
                for (let j = i + 1; j < mergedSlots.length; j++) {
                    const slotA = mergedSlots[i];
                    const slotB = mergedSlots[j];

                    // Only validate overlaps involving at least one slot of the target agent being updated
                    if (slotA.agent_id !== agentId && slotB.agent_id !== agentId) {
                        continue;
                    }

                    const [shA, smA] = slotA.start_time.split(':').map(Number);
                    const [ehA, emA] = slotA.end_time.split(':').map(Number);
                    const [shB, smB] = slotB.start_time.split(':').map(Number);
                    const [ehB, emB] = slotB.end_time.split(':').map(Number);

                    const startA = shA * 60 + smA;
                    const endA = ehA * 60 + emA;
                    const startB = shB * 60 + smB;
                    const endB = ehB * 60 + emB;

                    // Check overlap
                    if (startA < endB && endA > startB) {
                        // If both slots belong to the exact same agent, overlap is never allowed
                        if (slotA.agent_id === slotB.agent_id) {
                            return res.status(400).json({
                                success: false,
                                message: `Conflicto de horario: Tus turnos (${slotA.start_time}-${slotA.end_time} y ${slotB.start_time}-${slotB.end_time}) se solapan entre sí.`
                            });
                        }

                        // Exception: Overlap between DIFFERENT agents is allowed only if at least one agent is 'trial' (cangureando)
                        if (slotA.role !== 'trial' && slotB.role !== 'trial') {
                            return res.status(400).json({
                                success: false,
                                message: `Conflicto de horario: Los turnos de ${slotA.fullname} y ${slotB.fullname} se solapan de ${slotA.start_time}-${slotA.end_time} y ${slotB.start_time}-${slotB.end_time}. Los turnos no se pueden solapar a menos que uno de ellos sea un asesor en prueba (rol trial).`
                            });
                        }
                    }
                }
            }

            // 2. Validate total daily net hours PER AGENT (configurable max_hours_limit if allow_overtime is false, absolute 12 hours max if allow_overtime is true)
            let targetAgentDailyNetMinutes = 0;
            if (currentAgentRole !== 'trial') {
                for (const slot of daySlots) {
                    const [sh, sm] = slot.start_time.split(':').map(Number);
                    const [eh, em] = slot.end_time.split(':').map(Number);
                    const diff = (eh * 60 + em) - (sh * 60 + sm);
                    if (diff <= 0) continue;

                    let breakMin = 0;
                    if (slot.break_type === 'break_30') breakMin = 30;
                    else if (slot.break_type === 'lunch_60') breakMin = 60;
                    else if (slot.break_type === 'lunch_120') breakMin = 120;

                    targetAgentDailyNetMinutes += Math.max(0, diff - breakMin);
                }
            }

            const isOvertimeAllowed = supportConfig.allow_overtime !== false;
            const currentDailyLimit = isOvertimeAllowed ? 12 : parseFloat(supportConfig.max_hours_limit || 8);

            if (targetAgentDailyNetMinutes > currentDailyLimit * 60) {
                return res.status(400).json({
                    success: false,
                    message: isOvertimeAllowed
                        ? `La jornada diaria para ${agentMap[agentId]?.fullname || 'este asesor'} supera el límite absoluto de 12 horas diarias (actual: ${(targetAgentDailyNetMinutes / 60).toFixed(1)} horas).`
                        : `No se permiten horas extras. La jornada diaria para ${agentMap[agentId]?.fullname || 'este asesor'} supera el límite diario configurado de ${currentDailyLimit} horas netas.`
                });
            }
        }

        // Obtener franjas horarias existentes para auditoría
        const [existingSlots] = await pool.query(
            'SELECT day_of_week, start_time, end_time FROM agent_schedules WHERE agent_id = ? AND week_start = ?',
            [agentId, weekStartStr]
        );

        // Obtener nombres reales
        let requesterName = requester_email || 'Un asesor';
        if (requester_email) {
            const [reqRows] = await pool.query('SELECT fullname FROM agents WHERE email = ?', [requester_email.trim().toLowerCase()]);
            if (reqRows.length > 0 && reqRows[0].fullname) requesterName = reqRows[0].fullname;
        }
        let targetAgentName = email;
        const [targetAgentRows] = await pool.query('SELECT fullname FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (targetAgentRows.length > 0 && targetAgentRows[0].fullname) targetAgentName = targetAgentRows[0].fullname;

        // Corrección de nombre Esclepiades -> Katherine
        if (requesterName.toLowerCase().includes('esclepiades')) requesterName = 'Katherine';
        if (targetAgentName.toLowerCase().includes('esclepiades')) targetAgentName = 'Katherine';

        const daysMap = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const parseWeekStartDate = (weekStartStr) => {
            if (!weekStartStr || weekStartStr === 'default') return null;
            const [y, m, d] = weekStartStr.split('-').map(Number);
            return new Date(y, m - 1, d);
        };
        const weekStartDate = parseWeekStartDate(weekStartStr);

        const getDayDateLabel = (d, weekStartDate) => {
            const dayName = daysMap[d];
            if (!weekStartDate) return dayName;
            const targetDate = new Date(weekStartDate);
            const offset = d === 0 ? 6 : d - 1;
            targetDate.setDate(targetDate.getDate() + offset);
            const dayNum = String(targetDate.getDate()).padStart(2, '0');
            const monthNum = String(targetDate.getMonth() + 1).padStart(2, '0');
            return `${dayName} ${dayNum}/${monthNum}`;
        };

        let changeMessages = [];

        const existByDay = {};
        existingSlots.forEach(s => {
            if (!existByDay[s.day_of_week]) existByDay[s.day_of_week] = [];
            existByDay[s.day_of_week].push(s);
        });

        const incomingByDay = {};
        schedule.forEach(s => {
            const day = parseInt(s.day_of_week);
            if (!incomingByDay[day]) incomingByDay[day] = [];
            incomingByDay[day].push(s);
        });

        for (let d = 0; d <= 6; d++) {
            const dayLabel = getDayDateLabel(d, weekStartDate);
            const existing = existByDay[d] || [];
            const incoming = incomingByDay[d] || [];

            if (existing.length === 0 && incoming.length > 0) {
                incoming.forEach(s => {
                    changeMessages.push(`ha agregado un turno el ${dayLabel} (${s.start_time} - ${s.end_time})`);
                });
            } else if (existing.length > 0 && incoming.length === 0) {
                existing.forEach(s => {
                    changeMessages.push(`ha eliminado el turno del ${dayLabel} (${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)})`);
                });
            } else if (existing.length > 0 && incoming.length > 0) {
                const extStr = existing.map(s => `${s.start_time.substring(0, 5)}-${s.end_time.substring(0, 5)}`).sort().join(',');
                const incStr = incoming.map(s => `${s.start_time.substring(0, 5)}-${s.end_time.substring(0, 5)}`).sort().join(',');
                if (extStr !== incStr) {
                    changeMessages.push(`ha modificado el turno del ${dayLabel} (antes: ${extStr.replace(/,/g, ', ')}, ahora: ${incStr.replace(/,/g, ', ')})`);
                }
            }
        }

        // 2. Ejecutar la transacción de base de datos
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            await connection.query('DELETE FROM agent_schedules WHERE agent_id = ? AND week_start = ?', [agentId, weekStartStr]);

            for (const slot of schedule) {
                const dayOfWeek = parseInt(slot.day_of_week);
                const startTime = slot.start_time;
                const endTime = slot.end_time;

                if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;
                if (!startTime || !endTime) continue;

                const breakType = slot.break_type || 'none';
                const breakStart = slot.break_start || null;

                await connection.query(
                    'INSERT INTO agent_schedules (agent_id, week_start, day_of_week, start_time, end_time, break_type, break_start) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [agentId, weekStartStr, dayOfWeek, startTime, endTime, breakType, breakStart]
                );
            }

            await connection.commit();

            // Enviar notificación al grupo de WhatsApp tras éxito en DB
            if (changeMessages.length > 0 && client && client.info) {
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        const targetNameSuffix = (requester_email && requester_email.trim().toLowerCase() !== email.trim().toLowerCase())
                            ? ` para *${targetAgentName}*`
                            : '';
                        const msgLines = changeMessages.map(msg => `• *${requesterName}* ${msg}${targetNameSuffix}`);
                        const notificationText = `📅 *Notificación de Horarios*:\n\n${msgLines.join('\n')}`;
                        await groupChat.sendMessage(notificationText);
                    }
                } catch (sendErr) {
                    console.error('[Schedule Notification] Error en envío de whatsapp:', sendErr.message);
                }
            }

            res.json({ success: true, message: 'Horario del asesor guardado correctamente' });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (e) {
        console.error('❌ Error en /api/admin/agents/schedule/save:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Monthly/Period Payroll and Bonuses
app.get('/api/admin/payroll', async (req, res) => {
    try {
        const { month, start_date, end_date } = req.query;
        
        let startDateStr = start_date;
        let endDateStr = end_date;
        let payrollMonth = month;

        if (!startDateStr || !endDateStr) {
            if (!payrollMonth || !/^\d{4}-\d{2}$/.test(payrollMonth)) {
                const now = new Date();
                payrollMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            }
            const [yr, mo] = payrollMonth.split('-').map(Number);
            const daysInMonth = new Date(yr, mo, 0).getDate();
            startDateStr = `${yr}-${String(mo).padStart(2, '0')}-01`;
            endDateStr = `${yr}-${String(mo).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
        } else {
            payrollMonth = startDateStr.substring(0, 7);
        }

        const { pool } = require('./database');
        const { getSupportScheduleConfig } = require('./supportScheduleService');
        const supportConfig = getSupportScheduleConfig();
        const hourlyRate = parseFloat(supportConfig.hourly_rate || 8333);
        const trialHourlyRate = parseFloat(supportConfig.trial_hourly_rate || 5000);
        const trialHoursTarget = parseFloat(supportConfig.trial_hours_target || 80);

        const [agents] = await pool.query('SELECT id, fullname, email, role, exclude_from_payroll, status FROM agents');

        const startObj = new Date(startDateStr + 'T00:00:00');
        const endObj = new Date(endDateStr + 'T00:00:00');
        
        const weekStarts = new Set();
        const daysMapping = [];

        const getBogotaMondayStr = (date) => {
            const d = new Date(date);
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1);
            const monday = new Date(d.setDate(diff));
            return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
        };

        let curr = new Date(startObj);
        while (curr <= endObj) {
            const y = curr.getFullYear();
            const m = String(curr.getMonth() + 1).padStart(2, '0');
            const d = String(curr.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`;
            const dayOfWeek = curr.getDay();
            const mondayStr = getBogotaMondayStr(curr);

            weekStarts.add(mondayStr);
            daysMapping.push({ dateStr, dayOfWeek, mondayStr });

            curr.setDate(curr.getDate() + 1);
        }

        const weekStartsList = Array.from(weekStarts);

        let schedules = [];
        if (weekStartsList.length > 0) {
            const [rows] = await pool.query(
                'SELECT * FROM agent_schedules WHERE week_start IN (?) OR week_start = "default"',
                [weekStartsList]
            );
            schedules = rows;
        }

        const [bonuses] = await pool.query('SELECT * FROM agent_bonuses WHERE bonus_month = ? OR (created_at >= ? AND created_at <= ?)', [payrollMonth, startDateStr + ' 00:00:00', endDateStr + ' 23:59:59']);
        const [closedRecords] = await pool.query(
            'SELECT * FROM monthly_payroll WHERE status = "paid" AND (payroll_month = ? OR (start_date <= ? AND end_date >= ?) OR (start_date >= ? AND end_date <= ?))',
            [payrollMonth, endDateStr, startDateStr, startDateStr, endDateStr]
        );

        const payrollData = [];

        for (const agent of agents) {
            const closed = closedRecords.find(r => r.agent_id === agent.id);
            const agentBonuses = bonuses.filter(b => b.agent_id === agent.id);
            const totalBonuses = agentBonuses.reduce((sum, b) => sum + parseFloat(b.amount), 0);
            const isExcludedFromPayroll = agent.exclude_from_payroll === 1 || agent.exclude_from_payroll === true;

            let totalNetMinutes = 0;

            for (const day of daysMapping) {
                const hasCustomWeek = schedules.some(s => s.agent_id === agent.id && s.week_start === day.mondayStr);
                const targetWeekStart = hasCustomWeek ? day.mondayStr : 'default';
                const daySlots = schedules.filter(s => s.agent_id === agent.id && s.week_start === targetWeekStart && s.day_of_week === day.dayOfWeek);

                for (const slot of daySlots) {
                    if (!slot.start_time || !slot.end_time) continue;
                    const [sh, sm] = slot.start_time.split(':').map(Number);
                    const [eh, em] = slot.end_time.split(':').map(Number);
                    const diff = (eh * 60 + em) - (sh * 60 + sm);
                    if (diff <= 0) continue;

                    let breakMin = 0;
                    if (slot.break_type === 'break_30') breakMin = 30;
                    else if (slot.break_type === 'lunch_60') breakMin = 60;
                    else if (slot.break_type === 'lunch_120') breakMin = 120;

                    totalNetMinutes += Math.max(0, diff - breakMin);
                }
            }

            const totalHours = totalNetMinutes / 60;

            // Compute historical trial hours from closed periods
            const [histRows] = await pool.query(
                'SELECT SUM(COALESCE(trial_hours, total_hours)) as total_hist FROM monthly_payroll WHERE agent_id = ? AND status = "paid"',
                [agent.id]
            );
            const totalHistTrial = parseFloat(histRows[0].total_hist || 0);
            const trialHoursLeft = Math.max(0, trialHoursTarget - totalHistTrial);

            let trialHoursInPeriod = 0;
            let normalHoursInPeriod = 0;
            let rateToUse = closed ? parseFloat(closed.hourly_rate) : hourlyRate;
            const hoursToUse = closed ? parseFloat(closed.total_hours) : totalHours;
            const bonusesToUse = closed ? parseFloat(closed.total_bonuses) : totalBonuses;
            let finalPayment;

            if (closed) {
                trialHoursInPeriod = parseFloat(closed.trial_hours || 0);
                normalHoursInPeriod = parseFloat(closed.normal_hours || closed.total_hours);
                if (isExcludedFromPayroll) {
                    finalPayment = 0;
                } else {
                    const closedPay = parseFloat(closed.total_payment || 0);
                    finalPayment = closedPay > 0 ? closedPay : ((hoursToUse * rateToUse) + bonusesToUse);
                }
            } else {
                if (isExcludedFromPayroll) {
                    trialHoursInPeriod = 0;
                    normalHoursInPeriod = totalHours;
                    finalPayment = 0;
                } else if (agent.role === 'trial') {
                    if (totalHours <= trialHoursLeft) {
                        trialHoursInPeriod = totalHours;
                        normalHoursInPeriod = 0;
                        finalPayment = (totalHours * trialHourlyRate) + totalBonuses;
                        rateToUse = trialHourlyRate;
                    } else {
                        trialHoursInPeriod = trialHoursLeft;
                        normalHoursInPeriod = totalHours - trialHoursInPeriod;
                        finalPayment = (trialHoursInPeriod * trialHourlyRate) + (normalHoursInPeriod * hourlyRate) + totalBonuses;
                        rateToUse = hourlyRate;
                    }
                } else {
                    trialHoursInPeriod = 0;
                    normalHoursInPeriod = totalHours;
                    finalPayment = (totalHours * hourlyRate) + totalBonuses;
                }
            }

            if (agent.status === 'active' || totalHours > 0 || totalBonuses > 0 || closed) {
                payrollData.push({
                    agent_id: agent.id,
                    fullname: agent.fullname,
                    email: agent.email,
                    role: agent.role,
                    contract_status: agent.status,
                    exclude_from_payroll: isExcludedFromPayroll,
                    start_date: startDateStr,
                    end_date: endDateStr,
                    total_hours: hoursToUse,
                    trial_hours: trialHoursInPeriod,
                    normal_hours: normalHoursInPeriod,
                    trial_hours_target: trialHoursTarget,
                    trial_hours_left: trialHoursLeft,
                    total_hist_trial: totalHistTrial + trialHoursInPeriod,
                    hourly_rate: hourlyRate,
                    normal_hourly_rate: hourlyRate,
                    trial_hourly_rate: trialHourlyRate,
                    bonuses: agentBonuses,
                    total_bonuses: bonusesToUse,
                    total_payment: finalPayment,
                    status: closed ? closed.status : 'draft'
                });
            }
        }

        res.json({
            success: true,
            payroll: payrollData,
            config: {
                hourly_rate: hourlyRate,
                trial_hourly_rate: trialHourlyRate,
                trial_hours_target: trialHoursTarget
            },
            period: {
                start_date: startDateStr,
                end_date: endDateStr,
                payroll_month: payrollMonth
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Toggle Exclude from Payroll
app.post('/api/admin/agents/toggle-payroll', express.json(), async (req, res) => {
    try {
        const { agent_id, exclude_from_payroll } = req.body;
        if (agent_id === undefined) return res.status(400).json({ success: false, message: 'Falta ID de asesor' });

        const { pool } = require('./database');
        const excludeVal = exclude_from_payroll ? 1 : 0;
        await pool.query('UPDATE agents SET exclude_from_payroll = ? WHERE id = ?', [excludeVal, agent_id]);

        res.json({
            success: true,
            exclude_from_payroll: excludeVal === 1,
            message: excludeVal === 1 ? 'Asesor excluido de la nómina ($0 a pagar).' : 'Asesor incluido en la nómina.'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Update Agent Role
app.post('/api/admin/agents/role', express.json(), async (req, res) => {
    try {
        const { agent_id, role, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!agent_id || !role) return res.status(400).json({ success: false, message: 'Falta ID de asesor o rol' });

        const { pool } = require('./database');
        await pool.query('UPDATE agents SET role = ? WHERE id = ?', [role, agent_id]);

        res.json({ success: true, message: 'Rol de asesor actualizado correctamente.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Create or Update Employee / Agent
app.post('/api/admin/agents/save', express.json(), async (req, res) => {
    try {
        const { id, fullname, email, password, role, status, exclude_from_payroll } = req.body;
        if (!fullname || !email) {
            return res.status(400).json({ success: false, message: 'Nombre completo y correo son obligatorios.' });
        }

        const { pool } = require('./database');
        const cleanEmail = email.trim().toLowerCase();
        const cleanRole = role || 'agent';
        const cleanStatus = status || 'active';
        const excludeVal = exclude_from_payroll ? 1 : 0;
        const username = cleanEmail.split('@')[0].replace(/[^a-z0-9_]/g, '');

        const safeHashPassword = async (pwd) => {
            try {
                const bcrypt = require('bcryptjs');
                return await bcrypt.hash(pwd, 10);
            } catch (e) {
                const crypto = require('crypto');
                return crypto.createHash('sha256').update(pwd).digest('hex');
            }
        };

        if (id) {
            let updateQuery = 'UPDATE agents SET fullname = ?, email = ?, role = ?, status = ?, exclude_from_payroll = ?';
            let params = [fullname.trim(), cleanEmail, cleanRole, cleanStatus, excludeVal];

            if (password && password.trim().length > 0) {
                const hashed = await safeHashPassword(password.trim());
                updateQuery += ', password_hash = ?';
                params.push(hashed);
            }

            updateQuery += ' WHERE id = ?';
            params.push(id);

            await pool.query(updateQuery, params);

            return res.json({
                success: true,
                message: `Empleado ${fullname} actualizado correctamente.`
            });
        } else {
            const [existing] = await pool.query('SELECT id FROM agents WHERE email = ?', [cleanEmail]);
            if (existing && existing.length > 0) {
                return res.status(400).json({ success: false, message: `El correo ${cleanEmail} ya está registrado.` });
            }

            let hashedPassword = null;
            if (password && password.trim().length > 0) {
                hashedPassword = await safeHashPassword(password.trim());
            }

            const [result] = await pool.query(
                'INSERT INTO agents (username, fullname, email, role, status, password_hash, exclude_from_payroll) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [username, fullname.trim(), cleanEmail, cleanRole, cleanStatus, hashedPassword, excludeVal]
            );

            return res.json({
                success: true,
                agent_id: result.insertId,
                message: `Empleado ${fullname} creado exitosamente.`
            });
        }
    } catch (e) {
        console.error('Error al guardar empleado:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Terminate Contract / Change Agent Status
app.post('/api/admin/agents/terminate', express.json(), async (req, res) => {
    try {
        const { agent_id, status, reason, performed_by } = req.body;
        if (!agent_id) return res.status(400).json({ success: false, message: 'Falta ID de asesor.' });

        const { pool } = require('./database');
        const targetStatus = status || 'inactive';
        const excludePayroll = targetStatus === 'inactive' ? 1 : 0;
        const actionType = targetStatus === 'inactive' ? 'terminated' : 'reactivated';
        const defaultReason = targetStatus === 'inactive' ? 'Terminación de contrato de colaborador' : 'Reactivación de contrato de colaborador';
        const finalReason = reason && reason.trim().length > 0 ? reason.trim() : defaultReason;
        const operator = performed_by || 'admin';

        await pool.query(
            'UPDATE agents SET status = ?, exclude_from_payroll = ? WHERE id = ?',
            [targetStatus, excludePayroll, agent_id]
        );

        // Registrar auditoría en historial de contratos
        await pool.query(
            'INSERT INTO agent_contract_history (agent_id, action, status, reason, performed_by) VALUES (?, ?, ?, ?, ?)',
            [agent_id, actionType, targetStatus, finalReason, operator]
        );

        res.json({
            success: true,
            message: targetStatus === 'inactive'
                ? `Contrato finalizado (${finalReason}). Colaborador excluido de Nómina y Labores.`
                : `Contrato reactivado correctamente (${finalReason}).`
        });
    } catch (e) {
        console.error("Error en terminate endpoint:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Agent Contract Audit History
app.get('/api/admin/agents/:id/contract-history', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ success: false, message: 'Falta ID de asesor.' });

        const { pool } = require('./database');
        const [rows] = await pool.query(
            'SELECT * FROM agent_contract_history WHERE agent_id = ? ORDER BY created_at DESC',
            [id]
        );

        res.json({ success: true, history: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Registrar log de actividad del sistema
app.post('/api/admin/logs/log', express.json(), async (req, res) => {
    try {
        const { agent_email, agent_name, action_type, description, metadata } = req.body;
        if (!agent_email || !action_type || !description) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el log.' });
        }
        const { pool } = require('./database');
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        await pool.query(
            'INSERT INTO system_activity_logs (agent_email, agent_name, action_type, description, metadata) VALUES (?, ?, ?, ?, ?)',
            [agent_email, agent_name || agent_email.split('@')[0], action_type, description, metaStr]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Consultar auditoría de logs del sistema
app.get('/api/admin/logs', async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const { pool } = require('./database');
        const [rows] = await pool.query(
            'SELECT * FROM system_activity_logs ORDER BY created_at DESC LIMIT ?',
            [Number(limit)]
        );
        res.json({ success: true, logs: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Add or Update Bonus
app.post('/api/admin/bonuses/save', express.json(), async (req, res) => {
    try {
        const { email, amount, reason, bonus_month } = req.body;
        if (!email || !amount || !reason || !bonus_month) {
            return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
        }

        const { pool } = require('./database');
        const [agentRows] = await pool.query('SELECT id FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado' });
        }
        const agentId = agentRows[0].id;

        await pool.query(
            'INSERT INTO agent_bonuses (agent_id, bonus_month, amount, reason) VALUES (?, ?, ?, ?)',
            [agentId, bonus_month, parseFloat(amount), reason]
        );

        res.json({ success: true, message: 'Bono registrado correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Delete Bonus
app.post('/api/admin/bonuses/delete', express.json(), async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Falta el id del bono' });

        const { pool } = require('./database');
        await pool.query('DELETE FROM agent_bonuses WHERE id = ?', [id]);

        res.json({ success: true, message: 'Bono eliminado correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Close Monthly / Cutoff Period Payroll
app.post('/api/admin/payroll/close', express.json(), async (req, res) => {
    try {
        const { email, payroll_month, start_date, end_date, total_hours, trial_hours, normal_hours, hourly_rate, total_bonuses, total_payment, status, period_label } = req.body;
        if (!email || (!payroll_month && !start_date)) {
            return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
        }

        const { pool } = require('./database');
        const { getSupportScheduleConfig } = require('./supportScheduleService');
        const supportConfig = getSupportScheduleConfig();
        const trialHoursTarget = parseFloat(supportConfig.trial_hours_target || 80);
        const trialHourlyRate = parseFloat(supportConfig.trial_hourly_rate || 5000);
        const hourlyRateConfig = parseFloat(supportConfig.hourly_rate || 8333);

        const [agentRows] = await pool.query('SELECT id, role, fullname FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado' });
        }
        const agent = agentRows[0];
        const agentId = agent.id;
        const stat = status || 'paid';
        const pMonth = payroll_month || (start_date ? start_date.substring(0, 7) : '2026-07');
        const sDate = start_date || `${pMonth}-01`;
        const eDate = end_date || `${pMonth}-31`;
        const totHours = parseFloat(total_hours || 0);
        const totBonuses = parseFloat(total_bonuses || 0);

        // Delete previous closed/draft entry for this agent in this month / date range before inserting
        await pool.query(
            'DELETE FROM monthly_payroll WHERE agent_id = ? AND (payroll_month = ? OR (start_date = ? AND end_date = ?))',
            [agentId, pMonth, sDate, eDate]
        );

        // Compute historical trial hours completed BEFORE this closing (excluding current month)
        const [histRows] = await pool.query(
            'SELECT SUM(COALESCE(trial_hours, total_hours)) as total_hist FROM monthly_payroll WHERE agent_id = ? AND status = "paid" AND (payroll_month != ? OR payroll_month IS NULL)',
            [agentId, pMonth]
        );
        const totalHistTrial = parseFloat(histRows[0].total_hist || 0);
        const trialHoursLeft = Math.max(0, trialHoursTarget - totalHistTrial);

        let trHours = parseFloat(trial_hours || 0);
        let normHours = parseFloat(normal_hours || (totHours - trHours));
        let rateToUse = parseFloat(hourly_rate || hourlyRateConfig);
        let finalPayment = parseFloat(total_payment || 0);

        let promoted = false;

        // If agent is currently trial (or trial_hours were computed for this period):
        if (agent.role === 'trial') {
            if (totHours <= trialHoursLeft) {
                trHours = totHours;
                normHours = 0;
                rateToUse = trialHourlyRate;
                finalPayment = (trHours * trialHourlyRate) + totBonuses;
            } else {
                trHours = trialHoursLeft;
                normHours = totHours - trHours;
                finalPayment = (trHours * trialHourlyRate) + (normHours * hourlyRateConfig) + totBonuses;
                rateToUse = hourlyRateConfig;
            }

            // Auto-promote trial agent if target trial hours completed
            if (totalHistTrial + trHours >= trialHoursTarget) {
                await pool.query('UPDATE agents SET role = "agent" WHERE id = ?', [agentId]);
                promoted = true;
            }
        }

        const pLabel = period_label || `Período ${sDate} al ${eDate}`;

        await pool.query(`
            INSERT INTO monthly_payroll (agent_id, payroll_month, start_date, end_date, total_hours, trial_hours, normal_hours, hourly_rate, total_bonuses, total_payment, period_label, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [agentId, pMonth, sDate, eDate, totHours, trHours, normHours, rateToUse, totBonuses, finalPayment, pLabel, stat]);

        res.json({
            success: true,
            promoted,
            total_hours: totHours,
            trial_hours: trHours,
            normal_hours: normHours,
            total_payment: finalPayment,
            message: promoted
                ? `Nómina cerrada correctamente (${trHours.toFixed(1)}h a tarifa prueba de $${trialHourlyRate.toLocaleString('es-CO')} + ${normHours.toFixed(1)}h a tarifa agente). ¡${agent.fullname} completó las ${trialHoursTarget}h de prueba y fue promovido automáticamente a AGENT!`
                : `Nómina archivada y cerrada correctamente (${trHours.toFixed(1)}h prueba + ${normHours.toFixed(1)}h agente). Total a pagar: $${Math.round(finalPayment).toLocaleString('es-CO')}.`
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Payroll History / Archived Pay Stubs
app.get('/api/admin/payroll/history', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [records] = await pool.query(`
            SELECT mp.*, a.fullname, a.email, a.role as current_role 
            FROM monthly_payroll mp 
            JOIN agents a ON mp.agent_id = a.id 
            ORDER BY mp.id DESC
        `);
        res.json({ success: true, history: records });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Re-open / Cancel Closed Payroll Period (Admin Only)
app.post('/api/admin/payroll/reopen', express.json(), async (req, res) => {
    try {
        const { agent_id, id, payroll_month, start_date, end_date } = req.body;
        const { pool } = require('./database');

        if (id) {
            await pool.query('DELETE FROM monthly_payroll WHERE id = ?', [id]);
        } else if (agent_id) {
            await pool.query(
                'DELETE FROM monthly_payroll WHERE agent_id = ? AND (payroll_month = ? OR (start_date = ? AND end_date = ?))',
                [agent_id, payroll_month, start_date, end_date]
            );
        } else {
            return res.status(400).json({ success: false, message: 'Se requiere ID de nómina o ID de asesor' });
        }

        res.json({ success: true, message: 'Nómina reabierta correctamente. Ahora puedes corregir horas, bonos o estatus y volver a cerrar.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Default Prompts Templates
const DEFAULT_PAYMENT_PROMPT = `Analiza la siguiente descripción textual de una imagen/comprobante y determina si corresponde a un COMPROBANTE DE PAGO, RECIBO DE TRANSFERENCIA o CAPTURA DE PANTALLA DE UNA TRANSACCIÓN EXITOSA.
Contexto de la charla: {{CHAT_HISTORY}}

DESCRIPCIÓN DE LA IMAGEN DE PAGO:
"""
{{IMAGE_DESCRIPTION}}
"""

Debes responder en formato JSON:
{
  "isReceipt": boolean, // true si la descripción detalla claramente un recibo de banco con una transferencia exitosa.
  "amount": number | null, // El valor EXACTO de la transferencia (solo números enteros) si es legible.
  "bank": string | null, // Nombre del banco o medio detectado (Nequi, Daviplata, Bancolombia, Bre-B, etc.)
  "confidence": number, // Confianza de que es un recibo real y válido (0 a 1)
  "destinationKey": string | null, // Número exacto de la llave, cuenta, CVU, o destino al que se envió el dinero. Ej: "0087387259", "300 123 4567", "esteban@nequi.com". Extráelo aunque aparezca parcial. MUY IMPORTANTE.
  "destinationName": string | null // Nombre del destinatario/negocio si aparece en lugar de la llave. Ej: "SHEERIT ESTEBAN AVILA", "TIENDA EJEMPLO". Aparece frecuentemente en pagos por QR de Negocios.
}`;

const DEFAULT_PLAN_PROMPT = `El usuario está en el proceso de elegir un plan de la siguiente lista de opciones disponibles para la plataforma "{{PLATFORM_NAME}}":
{{PLANS_LIST}}

{{CART_LIST}}

El mensaje actual del usuario es: "{{MESSAGE_CONTENT}}"

Analiza la intención del usuario y clasifícala en uno de los siguientes sub-intents:
1. "plan_selection": El usuario está eligiendo o confirmando uno de los planes (ej. dice "la 1", "netflix 4k", "el de 17000" o escribe un número directamente).
2. "service_doubt_or_ignorance": El usuario tiene dudas sobre los servicios, precios, características, expresa desconocimiento, no entiende qué está eligiendo, o tiene confusión/inquietudes sobre cómo funciona su combo o si incluye otras plataformas del carrito (por ejemplo, si pregunta "¿Y paramount?", "¿Este plan incluye ambos?", "¿Qué diferencia hay?", "pero es que no entiendo", etc.).
3. "other": Cualquier otro tipo de mensaje.

Si el sub-intent es "service_doubt_or_ignorance", debes activar el ESPÍRITU DEL VENDEDOR:
- Escribe una respuesta comercial (salesReply) sumamente amable, persuasiva, vendedora y clara.
- Explica detalladamente y con paciencia qué plataformas están en su pedido y que primero estamos definiendo el plan de "{{PLATFORM_NAME}}".
- Resuelve la duda con base en las características y dile que al final sumaremos los servicios con un descuento por combo.

Salida esperada en formato JSON estricto:
{
    "subIntent": "plan_selection" | "service_doubt_or_ignorance" | "other",
    "salesReply": string | null, // Si subIntent es "service_doubt_or_ignorance", escribe la respuesta vendedora y aclaratoria detallada. En otro caso, null.
    "selectedIndex": number | null // Si subIntent es "plan_selection", indica el número de la opción elegida (1, 2, 3...) o null si no se entiende. En otro caso, null.
}`;

const DEFAULT_INITIAL_INTENT_PROMPT = `Analiza el primer mensaje del usuario para identificar qué desea hacer.

{{MEDIA_DESCRIPTION}}

GUÍA DE FUNCIONAMIENTO DE PLATAFORMAS:
{{PLATFORM_CONTEXT}}

INFORMACIÓN DEL CLIENTE (Servicios actuales):
{{ACCOUNT_SUMMARY}}

Contexto previo: {{CHAT_HISTORY}}
Mensaje actual: "{{MESSAGE_CONTENT}}"

Categorías para "intent":
- "comprar": El usuario quiere adquirir un servicio nuevo o pregunta por disponibilidad/precios de algo que NO tiene. 
  *IMPORTANTE*: Si el usuario pregunta "¿tienes disponible?", "¿entregas ya?", "¿qué tienes para entrega inmediata?", clasifícalo como "comprar" con frustración 0 y genera un mensaje que invite a la venta con total confianza.
- "credenciales": El usuario solicita las credenciales (correo/contraseña) de su cuenta actual, reporta explícitamente "la contraseña no corresponde", "clave incorrecta", pide recordar su pin de acceso, o pregunta cuándo se vence / fecha de vencimiento / fecha de pago de su cuenta actual.
- "renovar": El usuario quiere pagar, renovar o pregunta el costo de un servicio que YA TIENE contratado.
- "pagar": El usuario pregunta cómo pagar o envía un comprobante.
- "soporte": Problemas técnicos, fallas de conexión, errores en el cobro, perfiles caídos, o si pide explícitamente hablar con un humano/asesor. (NO usar si es explícitamente un error de clave).
- "cierre": El usuario se despide, da las gracias, confirma fin de charla o da un cierre natural (ej: "ok", "listo", "gracias", "vale", "chao", "adiós").
- "cancelar": El usuario manifiesta EXPRESAMENTE que no quiere renovar, que quiere cancelar el servicio o pide la baja.
- "duda_contexto": El usuario tiene dudas o realiza preguntas sobre información recién discutida en el chat actual (por ejemplo: qué significa "manual", de quién es la cuenta de Nequi/Daviplata, cómo proceder, etc.) o realiza preguntas de consulta sobre características de las plataformas, precios de planes o detalles técnicos específicos que funcionan como un paréntesis en la charla actual.
- "desconocido": Cualquier otro mensaje, incluyendo saludos iniciales sin petición específica.

Regla de Intents (MÁXIMA PRIORIDAD):
1. **MENÚ NUMÉRICO:** Si el mensaje es exactamente "1", "2", "3", "4" o "5", clasifícalo según el menú: "1"->comprar, "2"->credenciales, "3"->renovar, "4"->soporte, "5"->soporte.
2. **CONTINUIDAD:** Si es una respuesta corta ("sí", "nequi") a una pregunta previa, usa el intent de esa charla.
3. **STOCK:** Si pregunta por "disponibilidad", "stock", "entrega ya", el intent es "comprar".
4. **SOPORTE:** PRIORIDAD si hay errores o fallas.
5. **PAGAR:** Si pregunta cómo pagar o envía comprobante.

Lógica de recuperación ("recoveredState"):
- "awaiting_payment_method": 
    * Caso A: Si el mensaje menciona un medio de pago (Nequi, Daviplata, etc.) y en el historial el asistente ya dio un total a pagar.
    * Caso B (COLABORATIVO): Si el "Asistente" (humano, sin 🤖) negoció un precio (ej: "te queda en 21") y el usuario actual acepta (ej: "Listo", "Dale", "Vale"). EN ESTE CASO, el bot debe saltar aquí para dar los medios de pago. Si detectas el monto negociado, ponlo en metadata.total.
- "waiting_human": 
    * Caso A (CONVERSACIÓN ACTIVA): Si en el historial reciente aparece un mensaje del "Asistente" (humano, sin el emoji 🤖) hablando con el usuario, pidiendo datos o dando soporte. ES VITAL que si ves al Asistente humano hablando, devuelvas "waiting_human" para no interrumpirlo.
    * Caso B (SILENCIO FORZADO): Si el usuario ha enviado múltiples mensajes de queja, insultos o insistencia extrema (ej: "hola???", "alguien??", "que pasa?") sin respuesta, y el bot no tiene una solución técnica inmediata. 
- "awaiting_purchase_platforms": Si el usuario está preguntando por precios de plataformas específicas, comparando planes o preguntando "cuánto cuesta".
- "awaiting_payment_confirmation": Si el mensaje es una imagen o texto indicando "ya pagué", "aquí el recibo", etc.
- Si no hay un flujo claro a medias, pon null. 

Regla de Frustración:
- Analiza si el usuario suena desesperado, enojado o ha insistido mucho en corto tiempo sin ser atendido. Púntualo del 0 al 10 en "frustrationLevel". 
- IMPORTANTE: Si el mensaje actual es un saludo (Hola, buenos días) o un ping (?, sigo esperando) y en el historial reciente (mensajes no leídos) hay una solicitud clara de **"credenciales", "comprar" o "pagar"** que NO fue respondida adecuadamente, PRIORIZA esa petición sobre el saludo. El intent debe ser el de la petición pendiente (ej: "comprar" si pidió Netflix).

REGLA DE DEDUCCIÓN DE CONTEXTO Y CONTINUIDAD (MÁXIMA PRIORIDAD):
Nunca analices el "Mensaje actual" de forma aislada. Debes deducir estrictamente a qué está respondiendo el cliente basándote en el historial:
1. Si el "Mensaje actual" contiene varios mensajes (separados por \n), analízalos como una ráfaga lógica. Si hay contradicciones, dale prioridad al último mensaje de la ráfaga o al que sea más específico (ej: si dice "Hola" y luego "Quiero Netflix", el intent es "comprar").
2. Si el Asistente (especialmente si es humano sin 🤖) acaba de hacer una pregunta o pedir un dato (ej: "¿Qué operador tienes?", "Confírmame tu correo", "Pásame el comprobante") y el cliente responde con ese dato (ej: "Claro", "Engativa", "Mi correo es..."), ES UNA CONTINUACIÓN DIRECTA.
3. En este caso de continuación directa de una charla humana (donde el humano acaba de preguntar algo hace poco), puedes devolver "recoveredState": "waiting_human" para no estorbar. Sin embargo, si el usuario reporta una falla técnica clara, prioriza ayudarlo si el humano no ha respondido en más de 20-30 minutos.
4. Si el bot 🤖 estaba a la mitad de un flujo (ej: esperando método de pago) y el cliente responde a eso, recupera el estado correspondiente. ¡El contexto manda!
5. **RELEVANCIA TEMPORAL Y REANUDACIÓN:** 
   - Si han pasado más de 2 horas (compara la hora actual del sistema vs la del historial) desde el último mensaje del "Asistente" humano, NO devuelvas "waiting_human" a menos que el usuario esté respondiendo a una pregunta muy específica que aún tenga sentido. 
   - Si el "Mensaje actual" es una queja técnica clara (intent: "soporte" o "credenciales") y han pasado más de 30 minutos desde la última intervención humana, el bot DEBE retomar la ayuda si tiene la respuesta técnica. No dejes al cliente esperando si el humano ya no está activamente en el chat.
   - Si el mensaje del humano fue solo un "gracias", "listo" o un cierre, no bloquees el bot para futuras dudas del usuario.

Salida esperada JSON:
{
    "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "cierre" | "catalogo" | "duda_contexto" | "desconocido",
    "recoveredState": string | null,
    "frustrationLevel": number,
    "userName": string | null,
    "isNameComplete": boolean,
    "detectedPlatform": string | null, 
    "explanation": string | null,
    "metadata": {
        "duration_months": number | null,
        "is2faScreen": boolean | null
    } | null 
}

En "explanation", escribe una breve explicación en español del contenido de la imagen (OCR, textos principales, errores detectados, códigos) o del mensaje del usuario.
Si el mensaje actual es una imagen o el texto menciona un pago, revisa si es un comprobante. Si lo es, pon intent: "pagar".
Si la imagen muestra una PANTALLA DE INICIO DE SESIÓN pidiendo un CÓDIGO DE VERIFICACIÓN (2FA, código enviado al correo/teléfono), pon intent: "soporte" (para que el bot asista con el código o lo derive al humano).`;

const DEFAULT_CREDENTIALS_PROMPT = `Eres un agente humano y empático de servicio al cliente de "Sheerit".
Un cliente nos ha pedido revisar sus credenciales de streaming.

Aquí están los datos de sus plataformas:
{{CREDENTIALS_LIST}}

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

MENSAJE DEL CLIENTE:
"{{MESSAGE_CONTENT}}"

INSTRUCCIONES:
1. Si el cliente tiene una duda específica (ej: "¿cambió la clave?", "¿cuál es mi pin?", "no puedo entrar"), RESPÓNDELA directamente usando los datos arriba.
2. Luego de responder la duda, entrega la información de sus cuentas de forma amable, clara y amigable.

⚠️ REGLAS CRÍTICAS:
1. Muestra SIEMPRE el Correo, la Clave y el Perfil/PIN para CADA cuenta de la lista. NUNCA resumas u omitas esta información.
2. **PROHIBIDO INVENTAR / ALUCINAR**: Transcribe EXACTAMENTE el Correo y la Clave proporcionados en la lista de arriba. Queda estrictamente prohibido inventar correos ficticios (como sheeritstorecol@gmail.com u otros) o contraseñas (como Sheerit2025* u otras) que no estén tal cual en la lista. Si el dato dice "N/A" o está vacío, indícalo tal cual y pídele al usuario esperar a que el asesor lo asigne.
3. **IMPORTANTE (Cuentas Familiares/Extras)**: Si en los datos dice que la clave es "(Acceso por invitación/perfil propio)", explica amablemente al usuario que para ese servicio (ej. YouTube, Microsoft, Netflix Extra) no se usa una clave compartida, sino que él accede con su propio correo o mediante una invitación que le llegará.
4. Si la cuenta está vencida, mantén el aviso de que la clave está oculta por seguridad.
5. Si la lista está vacía, infórmale con tacto que no encontramos cuentas activas a su número.
6. Al final de tu mensaje, incluye el emoji 🤖 para indicar que eres un asistente automatizado.

No incluyas saludos genéricos como "[Tu Nombre]". Puedes despedirte en nombre del equipo de Sheerit.`;

const DEFAULT_REACTIVATION_PROMPT = `Eres el Asistente Virtual de Sheerit Store. Acabas de ser RE-ACTIVADO por un administrador en este chat.
Tu objetivo es saludar al cliente amablemente y addressar (abordar) de inmediato lo último que estaba preguntando o reportando mientras tú estabas silenciado.

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

INSTRUCCIONES:
1. Saluda cordialmente (Ej: "¡Hola! He vuelto para ayudarte...").
2. Menciona que un asesor te pidió retomar la atención.
3. Analiza los mensajes del CLIENTE en el historial:
   - Si preguntó por precios, dale una pincelada de lo que buscaba.
   - Si reportó una falla, dile que ya estás revisando su caso.
   - Si pidió credenciales de una cuenta ya existente, dile que con gusto le ayudas a consultarlas. Si se trata de una compra nueva recién pagada, dile que nuestro equipo ya está procesando sus accesos para entregárselos a la mayor brevedad.
4. Sé conciso y empático. No repitas todo el historial, solo demuestra que lo "leíste" y estás listo para ayudar.
5. Usa emojis amigables 🤖.

Responde solo con el texto del mensaje para el cliente.`;

// GET Prompts Config
app.get('/api/config/prompts', async (req, res) => {
    try {
        const { key } = req.query;
        const configKey = key || 'fallback_template';
        const validKeys = [
            'fallback_template',
            'payment_receipt_prompt',
            'plan_selection_prompt',
            'initial_intent_prompt',
            'credentials_delivery_prompt',
            'reactivation_prompt'
        ];

        if (!validKeys.includes(configKey)) {
            return res.status(400).json({ success: false, message: 'Llave de configuración inválida' });
        }

        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = ?', [configKey]);
        if (rows && rows.length > 0) {
            return res.json({ success: true, prompt: rows[0].cfg_value });
        }

        // Si no está en BD, usar el default correspondiente
        if (configKey === 'fallback_template') {
            const defaultPath = path.join(__dirname, 'prompts', 'fallback_template.txt');
            if (fs.existsSync(defaultPath)) {
                const promptContent = fs.readFileSync(defaultPath, 'utf8');
                return res.json({ success: true, prompt: promptContent, isDefault: true });
            }
        } else if (configKey === 'payment_receipt_prompt') {
            return res.json({ success: true, prompt: DEFAULT_PAYMENT_PROMPT, isDefault: true });
        } else if (configKey === 'plan_selection_prompt') {
            return res.json({ success: true, prompt: DEFAULT_PLAN_PROMPT, isDefault: true });
        } else if (configKey === 'initial_intent_prompt') {
            return res.json({ success: true, prompt: DEFAULT_INITIAL_INTENT_PROMPT, isDefault: true });
        } else if (configKey === 'credentials_delivery_prompt') {
            return res.json({ success: true, prompt: DEFAULT_CREDENTIALS_PROMPT, isDefault: true });
        } else if (configKey === 'reactivation_prompt') {
            return res.json({ success: true, prompt: DEFAULT_REACTIVATION_PROMPT, isDefault: true });
        }

        res.status(404).json({ success: false, message: 'Plantilla de prompt no encontrada' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Prompts Config
app.post('/api/config/prompts/save', express.json(), async (req, res) => {
    try {
        const { prompt, password, key } = req.body;
        const configKey = key || 'fallback_template';
        const validKeys = [
            'fallback_template',
            'payment_receipt_prompt',
            'plan_selection_prompt',
            'initial_intent_prompt',
            'credentials_delivery_prompt',
            'reactivation_prompt'
        ];

        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!prompt) return res.status(400).json({ success: false, message: 'Falta el contenido del prompt' });
        if (!validKeys.includes(configKey)) {
            return res.status(400).json({ success: false, message: 'Llave de configuración inválida' });
        }

        const { pool } = require('./database');
        await pool.query(
            'INSERT INTO system_configs (cfg_key, cfg_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
            [configKey, prompt]
        );

        // Limpiar caché local si existe en aiService
        try {
            const { clearCachedSystemPrompt } = require('./aiService');
            clearCachedSystemPrompt();
        } catch (err) { }

        res.json({ success: true, message: 'Plantilla de prompt guardada con éxito en la base de datos' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// ==========================================
// SAAS RPA RPA RECIPE EXECUTION & MANAGEMENT
// ==========================================

async function runRpaRecipe(recipe, variables = {}, jobId = null) {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const results = {};
    const screenshots = [];

    try {
        for (const step of recipe.steps) {
            console.log(`[RPA Runner] Ejecutando paso: ${step.action} - ${step.description || ''}`);

            const replaceVars = (val) => {
                if (typeof val === 'string') {
                    return val.replace(/\{\{(\w+)\}\}/g, (_, name) => {
                        if (results[name] !== undefined) return results[name];
                        return variables[name] !== undefined ? variables[name] : '';
                    });
                }
                return val;
            };

            if (step.url) step.url = replaceVars(step.url);
            if (step.selector) step.selector = replaceVars(step.selector);
            let value = replaceVars(step.value || "");

            const getTimeout = (defaultMs) => {
                if (step.timeout) {
                    const parsed = parseInt(step.timeout);
                    if (!isNaN(parsed) && parsed > 0) {
                        return parsed < 1000 ? parsed * 1000 : parsed;
                    }
                }
                return defaultMs;
            };

            // Update active job status with current action description
            if (jobId) {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.progress = `Paso ${recipe.steps.indexOf(step) + 1} de ${recipe.steps.length}: ${step.description || step.action}`;
                }
            }

            switch (step.action) {
                case 'navigate':
                    await page.goto(step.url, { waitUntil: 'networkidle2', timeout: getTimeout(30000) });
                    await new Promise(r => setTimeout(r, 2000)); // Pacing delay
                    break;
                case 'type':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(15000) });
                    await page.type(step.selector, value);
                    await new Promise(r => setTimeout(r, 1000)); // Pacing delay
                    break;
                case 'click':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(15000) });
                    await page.click(step.selector);
                    await new Promise(r => setTimeout(r, 2000)); // Pacing delay
                    break;
                case 'wait_navigation':
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: getTimeout(20000) });
                    break;
                case 'wait_selector':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(60000) });
                    break;
                case 'extract_text':
                    let extracted = null;
                    try {
                        // 1. Try target selector first with a shorter, fast timeout (12s)
                        await page.waitForSelector(step.selector, { timeout: 12000 });
                        extracted = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.innerText.trim() : null;
                        }, step.selector);
                    } catch (selectorErr) {
                        console.log(`[RPA Runner] Selector ${step.selector} no hallado. Aplicando fallback de escaneo inteligente en pantalla...`);

                        // 2. Fallback: Loop up to 7 times (35 seconds max) if page shows a loading message
                        for (let attempt = 0; attempt < 7; attempt++) {
                            const loadingState = await page.evaluate(() => {
                                const bodyText = document.body ? document.body.innerText : '';
                                return bodyText.includes('trayendo el código') ||
                                    bodyText.includes('espera unos segundos') ||
                                    bodyText.toLowerCase().includes('cargando');
                            });

                            if (loadingState) {
                                console.log(`[RPA Runner] Cargando código de Spotinet... Reintento ${attempt + 1}/7 (espera 5s)`);
                                await new Promise(r => setTimeout(r, 5000)); // Wait 5s for Spotinet to fetch code

                                // Take progress screenshot for user peace of mind
                                try {
                                    const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
                                    const item = {
                                        step: recipe.steps.indexOf(step) + 1,
                                        action: 'extract_wait',
                                        description: `Cargando código (intento ${attempt + 1})...`,
                                        img: `data:image/jpeg;base64,${screenshotBase64}`
                                    };
                                    screenshots.push(item);
                                    if (jobId) {
                                        const job = rpaJobs.get(jobId);
                                        if (job) job.screenshots = [...screenshots];
                                    }
                                } catch (e) { }
                                continue;
                            }
                            break;
                        }

                        // Extract text using keywords and regex
                        extracted = await page.evaluate(() => {
                            const bodyText = document.body ? document.body.innerText : '';

                            // Check if the 20 minutes warning alert is present in page text
                            if (bodyText.includes('últimos 20 min') || bodyText.toLowerCase().includes('no pediste el código')) {
                                return '⚠️ El cliente no ha solicitado el código en su dispositivo en los últimos 20 minutos.';
                            }

                            const elements = Array.from(document.querySelectorAll('p, div, span, h1, h2, h3, h4, h5, h6'));
                            // Look for elements containing keywords like "Código" or "sesión" and having digit patterns
                            const matches = elements.filter(el => {
                                const text = el.innerText || '';
                                return (text.toLowerCase().includes('código') || text.toLowerCase().includes('sesión') || text.toLowerCase().includes('codigo')) && /\b\d{6}\b/.test(text);
                            });

                            if (matches.length > 0) {
                                return matches[0].innerText.trim();
                            }

                            // Last resort: scan the entire body text
                            const bodyMatch = bodyText.match(/\b\d{6}\b/);
                            return bodyMatch ? `Código: ${bodyMatch[0]}` : null;
                        });
                    }

                    results[step.save_as || 'extracted'] = extracted;
                    await new Promise(r => setTimeout(r, 1000)); // Pacing delay
                    break;
                default:
                    console.warn(`[RPA Runner] Acción desconocida: ${step.action}`);
            }

            // Capture step screenshot in real-time
            try {
                const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
                const item = {
                    step: recipe.steps.indexOf(step) + 1,
                    action: step.action,
                    description: step.description || '',
                    img: `data:image/jpeg;base64,${screenshotBase64}`
                };
                screenshots.push(item);

                // Stream updates live to the job status if jobId exists
                if (jobId) {
                    const job = rpaJobs.get(jobId);
                    if (job) {
                        job.screenshots = [...screenshots];
                    }
                }
            } catch (screenshotErr) {
                console.warn('[RPA Runner] Error al tomar captura de pantalla del paso:', screenshotErr.message);
            }
        }

        return { success: true, data: results, screenshots };
    } catch (err) {
        console.error(`[RPA Runner Error] Falla en la receta '${recipe.name}':`, err.message);

        let failureScreenshot = null;
        try {
            const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
            failureScreenshot = `data:image/jpeg;base64,${screenshotBase64}`;

            const item = {
                step: recipe.steps.length + 1,
                action: 'failure_capture',
                description: 'Captura del momento de falla',
                img: failureScreenshot
            };
            screenshots.push(item);

            if (jobId) {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.screenshots = [...screenshots];
                }
            }
        } catch (screenshotErr) {
            console.warn('[RPA Runner] Error al tomar captura de pantalla del fallo:', screenshotErr.message);
        }

        return {
            success: false,
            error: err.message,
            screenshots,
            failureScreenshot
        };
    } finally {
        await browser.close();
    }
}

// POST Import Scribe PDF via Gemini
app.post('/api/admin/rpa/import-scribe', upload.single('pdf'), async (req, res) => {
    let tempPath = null;
    try {
        const password = req.body.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No se envió ningún archivo PDF' });

        tempPath = req.file.path;
        let pdfBuffer;
        if (req.file.buffer) {
            pdfBuffer = req.file.buffer;
        } else if (req.file.path) {
            pdfBuffer = fs.readFileSync(req.file.path);
        }

        if (!pdfBuffer) {
            return res.status(400).json({ success: false, message: 'No se pudo leer el archivo PDF' });
        }

        const { parseScribePdfToRecipe } = require('./aiService');
        const recipe = await parseScribePdfToRecipe(pdfBuffer);

        res.json({ success: true, recipe });
    } catch (e) {
        console.error('Error al importar PDF de Scribe:', e.message);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (err) {
                console.error('Error al limpiar archivo temporal:', err.message);
            }
        }
    }
});

// POST Save RPA Recipe
app.post('/api/admin/rpa/save', express.json(), async (req, res) => {
    try {
        const { id, name, platform, recipeJson, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!name || !platform || !recipeJson) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const { pool } = require('./database');
        if (id) {
            await pool.query(
                'UPDATE rpa_recipes SET name = ?, platform = ?, recipe_json = ? WHERE id = ?',
                [name, platform, JSON.stringify(recipeJson), id]
            );
            res.json({ success: true, message: 'Receta de automatización actualizada correctamente' });
        } else {
            await pool.query(
                'INSERT INTO rpa_recipes (name, platform, recipe_json) VALUES (?, ?, ?)',
                [name, platform, JSON.stringify(recipeJson)]
            );
            res.json({ success: true, message: 'Receta de automatización guardada correctamente' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET List RPA Recipes
app.get('/api/admin/rpa/list', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT * FROM rpa_recipes ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            platform: r.platform,
            recipeJson: typeof r.recipe_json === 'string' ? JSON.parse(r.recipe_json) : r.recipe_json,
            createdAt: r.created_at
        })));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE RPA Recipe
app.delete('/api/admin/rpa/delete/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password || req.body.password || 'admin123';
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        const { pool } = require('./database');
        await pool.query('DELETE FROM rpa_recipes WHERE id = ?', [id]);
        res.json({ success: true, message: 'Receta de automatización eliminada con éxito' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// In-memory queue for tracking asynchronous RPA executions
const rpaJobs = new Map();

// POST: Run RPA Recipe Asynchronously (non-blocking)
app.post('/api/admin/rpa/run', express.json(), async (req, res) => {
    try {
        const { recipeId, variables, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!recipeId) return res.status(400).json({ success: false, message: 'Falta el ID de la receta' });

        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT * FROM rpa_recipes WHERE id = ?', [recipeId]);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Receta no encontrada' });
        }

        const recipeObj = rows[0];
        const recipeJson = typeof recipeObj.recipe_json === 'string' ? JSON.parse(recipeObj.recipe_json) : recipeObj.recipe_json;

        // Query active provider credentials for this platform
        const rpaVariables = { ...(variables || {}) };
        try {
            const [providers] = await pool.query(
                'SELECT username, password FROM provider_credentials WHERE platform = ? ORDER BY created_at DESC LIMIT 1',
                [recipeObj.platform]
            );
            if (providers && providers.length > 0) {
                rpaVariables.PROVIDER_USER = providers[0].username;
                rpaVariables.PROVIDER_PASSWORD = providers[0].password;
            }
        } catch (dbErr) {
            console.error('[RPA] Error al consultar credenciales de proveedor:', dbErr.message);
        }

        const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        // Initial job state
        rpaJobs.set(jobId, {
            id: jobId,
            status: 'running',
            recipeName: recipeObj.name,
            email: variables?.CUSTOMER_EMAIL || 'N/A',
            screenshots: [],
            error: null,
            result: null,
            startedAt: new Date()
        });

        // Trigger execution asynchronously without await
        runRpaRecipe(recipeJson, rpaVariables, jobId)
            .then(result => {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.status = result.success ? 'success' : 'failed';
                    job.result = result.data;
                    job.screenshots = result.screenshots || [];
                    job.error = result.error || null;
                }
            })
            .catch(err => {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.status = 'failed';
                    job.error = err.message;
                    job.screenshots = err.screenshots || [];
                }
            });

        res.json({ success: true, jobId });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET: Check status of an RPA execution job
app.get('/api/admin/rpa/job-status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = rpaJobs.get(jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Tarea no encontrada' });
        }
        res.json({ success: true, job });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET: Check if a specific email has an active RPA recipe associated with it
app.get('/api/admin/rpa/check-recipe', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Falta el parámetro email' });
        }
        const { pool } = require('./database');
        const [rows] = await pool.query(
            'SELECT sa.rpa_recipe_id, r.name as recipe_name FROM stream_accounts sa JOIN rpa_recipes r ON r.id = sa.rpa_recipe_id WHERE sa.account_email = ? LIMIT 1',
            [email]
        );
        if (rows && rows.length > 0) {
            res.json({ success: true, hasRecipe: true, recipeId: rows[0].rpa_recipe_id, recipeName: rows[0].recipe_name });
        } else {
            res.json({ success: true, hasRecipe: false });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET List Provider Credentials
app.get('/api/admin/rpa/providers', async (req, res) => {
    try {
        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT * FROM provider_credentials ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            platform: r.platform,
            providerName: r.provider_name,
            username: r.username,
            password: r.password,
            phone: r.phone || '',
            createdAt: r.created_at
        })));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Provider Credentials
app.post('/api/admin/rpa/providers/save', express.json(), async (req, res) => {
    try {
        const { id, platform, providerName, username, password, phone, adminPassword } = req.body;
        if (adminPassword !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!platform || !providerName || !username || !password) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const { pool } = require('./database');
        if (id) {
            await pool.query(
                'UPDATE provider_credentials SET platform = ?, provider_name = ?, username = ?, password = ?, phone = ? WHERE id = ?',
                [platform, providerName, username, password, phone, id]
            );
        } else {
            await pool.query(
                'INSERT INTO provider_credentials (platform, provider_name, username, password, phone) VALUES (?, ?, ?, ?, ?)',
                [platform, providerName, username, password, phone]
            );
        }
        res.json({ success: true, message: 'Credenciales de proveedor guardadas correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE Provider Credentials
app.delete('/api/admin/rpa/providers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        const { pool } = require('./database');
        await pool.query('DELETE FROM provider_credentials WHERE id = ?', [id]);
        res.json({ success: true, message: 'Credenciales de proveedor eliminadas' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// GET Bot Status
app.get('/api/admin/bot/status', (req, res) => {
    res.json({
        success: true,
        isSleeping: globalBotSleep,
        isConnected: currentWhatsappStatus === 'CONNECTED',
        status: currentWhatsappStatus
    });
});

// POST Toggle Bot Sleep Mode
app.post('/api/admin/bot/toggle-sleep', express.json(), (req, res) => {
    if (typeof req.body?.sleep === 'boolean') {
        globalBotSleep = req.body.sleep;
    } else {
        globalBotSleep = !globalBotSleep;
    }
    console.log(`[Admin Control] Bot sleep mode cambiado a: ${globalBotSleep ? '😴 DORMIDO' : '🟢 ACTIVO'}`);
    res.json({
        success: true,
        isSleeping: globalBotSleep,
        message: globalBotSleep ? 'Bot dormido (solo web admin activa)' : 'Bot despierto (atendiendo clientes)'
    });
});

// ==========================================
// CLIENT OTP PORTAL SIGN-IN & 2FA REQUESTS
// ==========================================

const clientOtps = new Map(); // phone -> { code, expiresAt }
const DEMO_PHONE_NUMBERS = ['000', '57000', '0000', '570000000000', '5700000000'];
const ADMIN_DEMO_RECIPIENT_PHONE = '573133890800';

const DEMO_ACCOUNTS_LIST = [
    {
        id: 9001,
        platform: "NETFLIX",
        Streaming: "NETFLIX",
        email: "yulisadiagama@gmail.com",
        correo: "yulisadiagama@gmail.com",
        password: "Sheercoli01",
        contraseña: "Sheercoli01",
        profile: "Demo Esteban (PIN: 1234)",
        Nombre: "Demo Esteban",
        "pin perfil": "1234",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9002,
        platform: "DISNEY+ PREMIUM",
        Streaming: "DISNEY",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "mentilh23",
        contraseña: "mentilh23",
        profile: "Demo Esteban (PIN: 5678)",
        Nombre: "Demo Esteban",
        "pin perfil": "5678",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9003,
        platform: "MAX / HBO PLATINO",
        Streaming: "HBO",
        email: "sheeritcustomers@gmail.com",
        correo: "sheeritcustomers@gmail.com",
        password: "HBosheri39",
        contraseña: "HBosheri39",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9004,
        platform: "PRIME VIDEO",
        Streaming: "AMAZON",
        email: "itsheer266@gmail.com",
        correo: "itsheer266@gmail.com",
        password: "honesthe1",
        contraseña: "honesthe1",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9005,
        platform: "SPOTIFY PREMIUM",
        Streaming: "SPOTIFY",
        email: "discoveryrelesbiana@gmail.com",
        correo: "discoveryrelesbiana@gmail.com",
        password: "Spotisheer1",
        contraseña: "Spotisheer1",
        profile: "Cuenta Personal Premium",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9006,
        platform: "YOUTUBE PREMIUM",
        Streaming: "YOUTUBE",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "Sheerit123*",
        contraseña: "Sheerit123*",
        profile: "Familiar Invitación",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9007,
        platform: "CHATGPT PLUS",
        Streaming: "GPT",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "contraseñalarga69",
        contraseña: "contraseñalarga69",
        profile: "2FA TOTP Automático",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9008,
        platform: "CLAUDE PRO",
        Streaming: "CLAUDE",
        email: "angirosagptplus@gmail.com",
        correo: "angirosagptplus@gmail.com",
        password: "Magic Link Acceso",
        contraseña: "Magic Link Acceso",
        profile: "Enlace Mágico",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9009,
        platform: "APPLE TV+ / APPLE ONE",
        Streaming: "APPLE TV",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "Este1645*",
        contraseña: "Este1645*",
        profile: "Invitación Familiar",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9010,
        platform: "CRUNCHYROLL MEGA FAN",
        Streaming: "CRUNCHY ROLL",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "SHEPA0308",
        contraseña: "SHEPA0308",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9011,
        platform: "PARAMOUNT+",
        Streaming: "PARAMOUNT",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "prime2027",
        contraseña: "prime2027",
        profile: "Demo Esteban (PIN: 9999)",
        Nombre: "Demo Esteban",
        "pin perfil": "9999",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9012,
        platform: "CANVA PRO",
        Streaming: "CANVA",
        email: "sheerstreaming@gmail.com",
        correo: "sheerstreaming@gmail.com",
        password: "solintican3",
        contraseña: "solintican3",
        profile: "Equipo Pro Sheerit",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9013,
        platform: "GEMINI PRO",
        Streaming: "GEMINI",
        email: "discoveryrelesbiana@gmail.com",
        correo: "discoveryrelesbiana@gmail.com",
        password: "Sheerit3256",
        contraseña: "Sheerit3256",
        profile: "Cuenta Correo Propio",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9014,
        platform: "MICROSOFT 365",
        Streaming: "MICROSOFT",
        email: "Estebanavila182@outlook.com",
        correo: "Estebanavila182@outlook.com",
        password: "eSTE1645*",
        contraseña: "eSTE1645*",
        profile: "Licencia Personal 1TB",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    }
];

function isDemoClientPhone(phoneStr) {
    const clean = String(phoneStr || '').replace(/\D/g, '');
    return DEMO_PHONE_NUMBERS.includes(clean) || clean === '000' || clean === '57000' || clean.endsWith('000');
}

// POST Request Client OTP
app.post('/api/client/request-otp', express.json(), async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });

        const cleanPhone = phone.replace(/\D/g, '');
        const isDemo = isDemoClientPhone(cleanPhone);
        const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        const recipientJid = isDemo ? (ADMIN_DEMO_RECIPIENT_PHONE + '@c.us') : (cleanPhone.startsWith('57') ? cleanPhone + '@c.us' : '57' + last10 + '@c.us');

        let clientName = "Cliente";
        if (!isDemo) {
            const { pool } = require('./database');
            const [rows] = await pool.query(
                'SELECT fullname FROM customers WHERE phone = ? OR phone LIKE ? OR phone = ? LIMIT 1',
                [cleanPhone, `%${last10}`, `57${last10}`]
            );
            if (rows && rows.length > 0) {
                clientName = rows[0].fullname;
            } else {
                // Fallback a Excel y órdenes de clientes
                const { getAccountsByPhone } = require('./apiService');
                const userAccounts = await getAccountsByPhone(cleanPhone);
                if (!userAccounts || userAccounts.length === 0) {
                    return res.status(404).json({ success: false, message: 'No encontramos ningún cliente registrado con ese número de teléfono' });
                }
                const firstAcc = userAccounts[0];
                clientName = `${firstAcc.Nombre || firstAcc.nombre || ''} ${firstAcc.Apellido || firstAcc.apellido || ''}`.trim() || "Cliente";
            }
        } else {
            clientName = "Esteban (Usuario Demo)";
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos

        clientOtps.set(cleanPhone, { code: otpCode, expiresAt });
        if (isDemo) {
            clientOtps.set('000', { code: otpCode, expiresAt });
            clientOtps.set('57000', { code: otpCode, expiresAt });
        }

        if (client && currentWhatsappStatus === 'CONNECTED') {
            const demoTag = isDemo ? " (DEMO TESTING)" : "";
            const msg = `🔑 *CÓDIGO DE ACCESO (SHEERIT${demoTag})* 🔑\n\nHola *${clientName}*,\n\nTu código OTP para iniciar sesión en nuestro portal de clientes es:\n\n🔢 *${otpCode}*\n\n_Este código es confidencial y vencerá en 5 minutos._ 🤖`;
            await client.sendMessage(recipientJid, msg);
            console.log(`[OTP] Enviado código ${otpCode} a @${recipientJid} (Usuario: ${cleanPhone})`);
            return res.json({ success: true, message: isDemo ? 'Código OTP enviado con éxito a tu WhatsApp (+57 313 3890800)' : 'Código OTP enviado con éxito a tu WhatsApp' });
        } else {
            return res.status(503).json({ success: false, message: 'El servicio de envío de códigos no está disponible en este momento' });
        }
    } catch (e) {
        console.error('Error al generar OTP para cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Verify Client OTP
app.post('/api/client/verify-otp', express.json(), async (req, res) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const isDemo = isDemoClientPhone(cleanPhone);
        const otpData = clientOtps.get(cleanPhone) || (isDemo ? (clientOtps.get('000') || clientOtps.get('57000')) : null);

        if (!otpData) {
            return res.status(400).json({ success: false, message: 'No hay un código OTP activo para este número. Por favor solicita uno nuevo.' });
        }

        if (Date.now() > otpData.expiresAt) {
            clientOtps.delete(cleanPhone);
            return res.status(400).json({ success: false, message: 'El código OTP ha expirado. Por favor solicita uno nuevo.' });
        }

        if (otpData.code !== code.trim()) {
            return res.status(400).json({ success: false, message: 'El código OTP ingresado es incorrecto' });
        }

        // OTP Válido - Limpiar
        clientOtps.delete(cleanPhone);

        if (isDemo) {
            return res.json({
                success: true,
                message: 'Verificación exitosa (Modo Demo)',
                accounts: DEMO_ACCOUNTS_LIST
            });
        }

        const { getAccountsByPhone } = require('./apiService');
        const userAccounts = await getAccountsByPhone(cleanPhone);

        const formattedAccounts = userAccounts.map(acc => {
            const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
            const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "N/A";

            return {
                id: acc.id || acc._rowNumber,
                platform: (acc.Streaming || "").toUpperCase(),
                email: acc.correo || "",
                password: acc["contraseña"] || acc.contraseña || acc.clave || acc.Password || acc.password || "",
                profile: pin ? `${perfil} (PIN: ${pin})` : perfil,
                vencimiento: acc.vencimiento || acc.deben || ""
            };
        });

        res.json({
            success: true,
            message: 'Verificación exitosa',
            accounts: formattedAccounts
        });
    } catch (e) {
        console.error('Error al verificar OTP de cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Auto-Session for freshly approved web orders (No OTP required on first checkout)
app.post('/api/client/auto-session', express.json(), async (req, res) => {
    try {
        const { phone, orderId } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const isDemo = isDemoClientPhone(cleanPhone);

        if (isDemo) {
            return res.json({
                success: true,
                message: 'Sesión automática (Modo Demo)',
                accounts: DEMO_ACCOUNTS_LIST
            });
        }

        const { getAccountsByPhone } = require('./apiService');
        const userAccounts = await getAccountsByPhone(cleanPhone);

        const formattedAccounts = userAccounts.map(acc => {
            const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
            const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "N/A";

            return {
                id: acc.id || acc._rowNumber,
                platform: (acc.Streaming || "").toUpperCase(),
                email: acc.correo || "",
                password: acc["contraseña"] || acc.contraseña || acc.clave || acc.Password || acc.password || "",
                profile: pin ? `${perfil} (PIN: ${pin})` : perfil,
                vencimiento: acc.vencimiento || acc.deben || ""
            };
        });

        res.json({
            success: true,
            message: 'Sesión iniciada con éxito',
            accounts: formattedAccounts
        });
    } catch (e) {
        console.error('Error en auto-session de cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Request 2FA Code from Website
app.post('/api/client/request-2fa', express.json(), async (req, res) => {
    try {
        const { phone, accountId } = req.body;
        if (!phone || !accountId) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const isDemo = isDemoClientPhone(cleanPhone);
        const userJid = isDemo ? (ADMIN_DEMO_RECIPIENT_PHONE + '@c.us') : (cleanPhone + '@c.us');

        let targetAccount = null;
        if (isDemo) {
            targetAccount = DEMO_ACCOUNTS_LIST.find(a => a.id == accountId);
        } else {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(cleanPhone);
            targetAccount = userAccounts.find(a => (a.id || a._rowNumber) == accountId);
        }

        if (!targetAccount) {
            return res.status(404).json({ success: false, message: 'Cuenta no encontrada o no vinculada a tu número' });
        }

        const mockMessage = {
            id: { _serialized: `web_request_${Date.now()}` },
            from: userJid,
            fromMe: false,
            body: `código de ${(targetAccount.Streaming || '').toUpperCase()}`,
            reply: async (text) => {
                console.log(`[Web OTP Request Reply]: ${text}`);
                if (client) {
                    try { await client.sendMessage(userJid, text); } catch(e) {}
                }
                return text;
            }
        };

        // Ejecutar extractor automático y obtener el resultado estructurado
        const extractionResult = await processAccountVerificationCode(mockMessage, userJid, targetAccount, isDemo ? ADMIN_DEMO_RECIPIENT_PHONE : cleanPhone, client, userStates);

        if (extractionResult && (extractionResult.code || extractionResult.link)) {
            return res.json({
                success: true,
                message: extractionResult.code ? `Código encontrado: ${extractionResult.code}` : (extractionResult.link ? 'Enlace de acceso listo' : 'Código o enlace extraído con éxito'),
                code: extractionResult.code || null,
                link: extractionResult.link || null,
                snippet: extractionResult.snippet || null,
                type: extractionResult.type || null,
                account: targetAccount.correo
            });
        }

        res.json({
            success: extractionResult?.success || false,
            message: extractionResult?.message || 'Buscando código en buzón... Si acabas de presionar enviar código en tu TV/App, presiona nuevamente en unos segundos.',
            code: extractionResult?.code || null,
            link: extractionResult?.link || null,
            account: targetAccount.correo
        });
    } catch (e) {
        console.error('Error al solicitar 2FA desde web:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});



const server = http.createServer(app);
const port = process.env.PORT || 3000;

server.listen(port, () => {
    console.log(`Servidor Express corriendo en el puerto ${port}`);

    // Heartbeat cada 2 minutos (con detector anti-zombie de estados atascados OPENING / DISCONNECTED)
    let nonConnectedHeartbeatCount = 0;
    const botProcessStartTime = Date.now();

    setInterval(async () => {
        try {
            if (!client) return;

            const isWarmingUp = (Date.now() - botProcessStartTime) < (6 * 60 * 1000);

            let state = null;
            try {
                state = await Promise.race([
                    client.getState(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("getState Timeout (15s)")), 15000))
                ]);
            } catch (e) {
                if (isWarmingUp) {
                    console.log(`⏳ Heartbeat: Esperando conexión inicial de WhatsApp Web (${Math.round((Date.now() - botProcessStartTime)/1000)}s)...`);
                    return;
                }
                console.error('⚠️ Heartbeat: client.getState() falló o dio timeout:', e.message);
                throw e;
            }

            console.log(`💓 Heartbeat: Proceso vivo. Estado en WWebJS: ${state} | Estado interno: ${currentWhatsappStatus}`);

            // Si aún no está en CONNECTED, verificar si WhatsApp está descargando mensajes legítimamente
            if (state !== 'CONNECTED') {
                let isSyncing = false;
                try {
                    if (client.pupPage) {
                        isSyncing = await client.pupPage.evaluate(() => {
                            const body = document.body ? document.body.innerText.toLowerCase() : '';
                            return body.includes('descargando') || 
                                   body.includes('sincronizando') || 
                                   body.includes('no cierres esta ventana') ||
                                   !!document.querySelector('progress') || 
                                   !!document.querySelector('[role="progressbar"]');
                        }).catch(() => false);
                    }
                } catch (e) { isSyncing = false; }

                if (isSyncing) {
                    console.log('⏳ [SYNC ACTIVO] WhatsApp Web está descargando mensajes/historial legítimamente. Manteniendo proceso vivo...');
                    nonConnectedHeartbeatCount = 0;
                    return;
                }

                if (isWarmingUp) {
                    console.log(`⏳ Heartbeat: Calentamiento en progreso (${Math.round((Date.now() - botProcessStartTime)/1000)}s). Estado: ${state || 'null'}`);
                    return;
                }
                nonConnectedHeartbeatCount++;
                console.warn(`⚠️ Heartbeat: Cliente en estado NO-CONECTADO ('${state}'). Intento sin conexión #${nonConnectedHeartbeatCount}`);

                // Si lleva 4 heartbeats seguidos (8 minutos) sin estar en CONNECTED tras el calentamiento y sin estar descargando, forzar reinicio
                if (nonConnectedHeartbeatCount >= 4) {
                    console.error(`🔥 [ANTI-ZOMBIE] El cliente WhatsApp lleva ${nonConnectedHeartbeatCount * 2} minutos sin estar en estado CONNECTED ni sincronizando (estado actual: '${state}'). Forzando reinicio para PM2...`);
                    process.exit(1);
                }
                return;
            }

            nonConnectedHeartbeatCount = 0;
            if (state === 'CONNECTED' && currentWhatsappStatus !== 'CONNECTED') {
                currentWhatsappStatus = 'CONNECTED';
                broadcastSseEvent('status', { status: currentWhatsappStatus });
            }

            // Verificación de salud profunda: ¿Sigue respondiendo el navegador?
            if (client.info && client.info.wid) {
                const info = await Promise.race([
                    client.getContactById(client.info.wid._serialized),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout (20s)")), 20000))
                ]);
                if (!info) throw new Error("Browser unresponsive (Deep check failed)");
            }
        } catch (err) {
            console.error('⚠️ Heartbeat: Error de salud detectado:', err.message);
            const isWarmingUp = (Date.now() - botProcessStartTime) < (6 * 60 * 1000);
            if (!isWarmingUp && (isCriticalBrowserError(err) || err.message.toLowerCase().includes("detached") || err.message.toLowerCase().includes("unresponsive") || err.message.toLowerCase().includes("protocol error"))) {
                console.error('🔥 [ANTI-ZOMBIE] Detectado estado crítico o zombie de Puppeteer. Forzando reinicio para PM2...');
                process.exit(1);
            }
        }
    }, 2 * 60 * 1000);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`🔥 ERROR: El puerto ${port} ya está en uso.`);
        console.error(`Intenta matar el proceso ejecutando: lsof -i :${port} y luego kill -9 <PID>`);
        process.exit(1);
    } else {
        console.error('Error al iniciar el servidor Express:', err);
    }
});

// Nota: usamos `./database.js` que expone `pool` (mysql2/promise pool)

// Configuración del cliente de WhatsApp
// Detectamos si estamos en Mac (darwin)
const isMac = process.platform === 'darwin';

const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-blink-features=AutomationControlled', // Oculta navigator.webdriver
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
        ],
        timeout: 60000,
        protocolTimeout: 180000,
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', // User-Agent real
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'wwebjs_auth') }),
    webVersionCache: {
        type: 'none'
    },
    markOnlineAvailable: false,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000
});
global.client = client;

// Manejo de cierres limpios
async function shutdown() {
    console.log('Cerrando bot de forma limpia...');
    try {
        if (client) await client.destroy();
        if (server) server.close();
        process.exit(0);
    } catch (e) {
        process.exit(1);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Generar QR para conexión
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    latestQrCode = qr;
    latestPairingCode = null;
    currentWhatsappStatus = 'QR_READY';
    broadcastSseEvent('status', { status: currentWhatsappStatus, qr: qr });
});

// Código de vinculación (Pairing code)
client.on('code', (code) => {
    console.log('[Pairing Code] Código recibido del cliente:', code);
    latestPairingCode = code;
    latestQrCode = null;
    currentWhatsappStatus = 'PAIRING_CODE_READY';
    broadcastSseEvent('status', { status: currentWhatsappStatus, pairingCode: code });
});

client.on('ready', () => {
    console.log('✅ Conexión establecida correctamente. ¡Bot listo!');
    currentWhatsappStatus = 'CONNECTED';
    latestQrCode = null;
    latestPairingCode = null;
    broadcastSseEvent('status', { status: currentWhatsappStatus });

    const { setAlertCallback } = require('./googleAuthService');
    setAlertCallback(async (serviceName, authUrl) => {
        try {
            const adminPhone = OPERATOR_NUMBER;
            const msg = `⚠️ *ALERTA DE SISTEMA (Sheer IT)* ⚠️\n\nFalta el token de autorización para el servicio: *${serviceName}*\n\n*Paso a paso para autorizar:*\n1. Abre este enlace desde tu navegador:\n${authUrl}\n\n2. Inicia sesión con la cuenta de Google correspondiente.\n3. Otorga los permisos solicitados.\n4. Serás redirigido a una página de error o a \`localhost\`.\n5. Copia el parámetro \`code=\` de la URL de esa página.\n6. Envíame un mensaje con el formato: \`@bot autorizar ${serviceName.toLowerCase()} [tu_codigo_aqui]\``;
            await client.sendMessage(adminPhone, msg);
            console.log(`[ALERTA ENVIADA] Se notificó al admin sobre el token faltante de ${serviceName}.`);
        } catch (err) {
            console.error("Error enviando alerta de auth al admin:", err);
        }
    });

    // Iniciar Automatización Diaria (9am y 2pm)
    initDailyAutomation(client, userStates, pendingConfirmations, GROUP_ID);

    // Procesar chats que quedaron sin leer mientras el bot estuvo apagado
    setTimeout(async () => {
        console.log('⏳ Escaneando chats con mensajes no leídos desde el arranque inicial...');
        try {
            const { processPendingChats } = require('./adminService');
            const count = await processPendingChats(client, userStates, processIncomingMessage, true);
            console.log(`✅ Escaneo inicial completado. Se procesaron/ignoraron ${count} chats pendientes adecuadamente.`);
        } catch (err) {
            console.error('Error en escaneo inicial de chats pendientes:', err);
            const uptimeSeconds = Math.floor(Date.now() / 1000) - BOT_START_TIME;
            if (isCriticalBrowserError(err) && uptimeSeconds > 120) {
                console.error('🔥 [ANTI-ZOMBIE] Error crítico detectado en escaneo inicial. Forzando reinicio para PM2...');
                process.exit(1);
            } else if (isCriticalBrowserError(err)) {
                console.warn('⚠️ [ANTI-ZOMBIE] Ignorando error de escaneo durante el período de calentamiento inicial (primeros 2 min). El bot seguirá corriendo.');
            }
        }
    }, 30000); // 30 segundos de gracia inicial
});

client.on('disconnected', async (reason) => {
    console.error('❌ El cliente se desconectó. Razón:', reason);
    const wasConnected = currentWhatsappStatus === 'CONNECTED';
    currentWhatsappStatus = 'DISCONNECTED';
    latestQrCode = null;
    latestPairingCode = null;
    broadcastSseEvent('status', { status: currentWhatsappStatus, reason: reason });
    // Cierre limpio de Puppeteer antes de reiniciar para evitar corrupción de sesión
    console.log('⚠️ Cerrando Puppeteer limpiamente...');
    try { await client.destroy(); } catch (e) { console.error('Error al cerrar cliente:', e.message); }

    if (wasConnected) {
        console.log('🔄 El bot estaba conectado previamente. Forzando reinicio inmediato para PM2...');
        process.exit(1);
    } else {
        console.log('⏳ El bot se desconectó durante la fase de inicio. Esperando 15 segundos antes de reiniciar para evitar bucles rápidos de PM2...');
        setTimeout(() => {
            process.exit(1);
        }, 15000);
    }
});

client.on('auth_failure', async (msg) => {
    console.error('❌ FALLO DE AUTENTICACIÓN:', msg);
    currentWhatsappStatus = 'DISCONNECTED';
    latestQrCode = null;
    latestPairingCode = null;
    broadcastSseEvent('status', { status: currentWhatsappStatus, reason: 'auth_failure', message: msg });
    // Cierre limpio antes de reiniciar
    try { await client.destroy(); } catch (e) { console.error('Error al cerrar cliente:', e.message); }
    process.exit(1);
});

// Manejo de llamadas automáticas
client.on('call', async (call) => {
    console.log(`[CALL] ✨ Llamada entrante detectada. ID: ${call.id}, De: ${call.from}`);
    try {
        try {
            await call.reject();
            console.log(`[CALL] 🚫 Llamada ${call.id} rechazada con éxito.`);
        } catch (rejectErr) {
            console.error(`[CALL] ⚠️ No se pudo rechazar la llamada activamente (error de wwebjs):`, rejectErr.message);
        }

        // Determinar el JID de destino correcto (debe incluir @c.us)
        let destJid = call.from;
        if (destJid && !destJid.includes('@')) {
            destJid = destJid.replace(/\D/g, '') + '@c.us';
        }

        // Pausa de 1.5s para permitir que Puppeteer se desature tras colgar
        await new Promise(res => setTimeout(res, 1500));

        await client.sendMessage(destJid, "🤖 *AVISO DE SOPORTE*: Hola, gracias por contactar a Sheerit. Te informamos que nuestro soporte y atención es **exclusivamente por CHAT**.\n\nPor favor, deja tu mensaje aquí y un asesor te atenderá lo antes posible. ¡Gracias por tu comprensión! 😊");
        console.log(`[CALL] ✉️ Aviso de chat enviado a ${destJid}`);
    } catch (e) {
        console.error('Error al procesar evento call:', e);
    }
});

// Implement incoming_call para compatibilidad con diferentes versiones
client.on('incoming_call', async (call) => {
    console.log(`[INCOMING_CALL] ✨ Llamada entrante detectada. ID: ${call.id}, De: ${call.from}`);
    try {
        try {
            await call.reject();
            console.log(`[INCOMING_CALL] 🚫 Llamada ${call.id} rechazada con éxito.`);
        } catch (rejectErr) {
            console.error(`[INCOMING_CALL] ⚠️ No se pudo rechazar la llamada activamente (error de wwebjs):`, rejectErr.message);
        }

        let destJid = call.from;
        if (destJid && !destJid.includes('@')) {
            destJid = destJid.replace(/\D/g, '') + '@c.us';
        }

        // Pausa de 1.5s para permitir que Puppeteer se desature tras colgar
        await new Promise(res => setTimeout(res, 1500));

        await client.sendMessage(destJid, "🤖 *AVISO DE SOPORTE*: Hola, gracias por contactar a Sheerit. Te informamos que nuestro soporte y atención es **exclusivamente por CHAT**.\n\nPor favor, deja tu mensaje aquí y un asesor te atenderá lo antes posible. ¡Gracias por tu comprensión! 😊");
        console.log(`[INCOMING_CALL] ✉️ Aviso de chat enviado a ${destJid}`);
    } catch (e) {
        console.error('Error al procesar evento incoming_call:', e);
    }
});

client.on('change_state', (state) => {
    console.log('🔄 Cambio de estado detectado:', state);
});

client.on('loading_screen', (percent, message) => {
    console.log('CARGANDO PANTALLA', percent, message);
});

client.on('authenticated', () => {
    console.log('AUTENTICADO');
});

// [REMOVIDO] Handlers duplicados de auth_failure y disconnected eliminados
// para evitar conflictos con los handlers principales (líneas ~5589-5607)

// DETECTAR INTERVENCIÓN HUMANA

client.on('message_create', async (msg) => {
    // Ignorar si el mensaje es antiguo
    if (msg.timestamp < BOT_START_TIME) return;

    // Persistir mensaje en base de datos (ignorar grupos, broadcasts y el número propio del bot)
    const targetChatId = msg.fromMe ? msg.to : msg.from;
    if (targetChatId && (targetChatId.includes('3118587974') || targetChatId.includes('573118587974'))) return;
    if (targetChatId && !targetChatId.includes('@g.us') && !targetChatId.includes('status@broadcast')) {
        saveMessage(msg).catch(err => console.error("[DB Save Error] message_create:", err.message));
    }

    // Si el mensaje lo envío yo mismo (fromMe) a un grupo con comando @bot
    if (msg.fromMe && ((msg.to && msg.to.includes('@g.us')) || (msg.from && msg.from.includes('@g.us')))) {
        if (msg.body && (msg.body.toLowerCase().includes('@bot') || msg.body.toLowerCase().startsWith('!bot'))) {
            processIncomingMessage([msg]).catch(err => console.error('Error procesando comando @bot de grupo en message_create:', err));
            return;
        }
    }

    // DETECTAR INTERVENCIÓN HUMANA: Si el mensaje lo envío yo manualmente
    // a un chat que NO es un grupo y NO tiene el emoji del bot.
    if (msg.fromMe && !msg.to.includes('@g.us') && !msg.to.includes('@broadcast')) {
        let targetId = msg.to;

        // Traducción de LID a @c.us para consistencia en el estado (evita pisar charlas humanas)
        const cleanTarget = targetId.replace(/\D/g, '');
        const isLid = targetId.includes('@lid') || (targetId.includes('@c.us') && !cleanTarget.startsWith('57') && cleanTarget.length > 10) || cleanTarget.length > 12;
        if (isLid) {
            try {
                const { resolveRealPhoneFromJid } = require('./billingService');
                const resolved = await resolveRealPhoneFromJid(targetId);
                if (resolved && resolved.length >= 7) {
                    targetId = resolved + '@c.us';
                }
            } catch (e) {
                if (msg && msg.body) console.warn("[LID Fix message_create] Error traduciendo contacto:", e.message);
            }
        }

        // Comando o mención en el chat para reactivar el bot o confirmar pagos
        if (msg.body.toLowerCase().includes('@bot')) {
            const command = msg.body.toLowerCase();

            // NUEVO: Manejo directo de confirmación en el chat del cliente
            if (command.includes('confirmar')) {
                const { handleAdminPaymentConfirmation } = require('./adminService');
                // Pasamos targetId como overridePhone para que no tenga que buscarlo
                handleAdminPaymentConfirmation(msg, command, client, userStates, targetId)
                    .catch(err => console.error('Error en confirmación directa:', err));
                return;
            }

            // NUEVO: Manejo directo de programar/enviar mensaje en el chat del cliente
            if (command.startsWith('@bot dile') || command.startsWith('@bot envia') || command.startsWith('@bot envía')) {
                processIncomingMessage([msg])
                    .catch(err => console.error('Error procesando comando @bot en message_create:', err));
                return;
            }

            // Manejo de liberar
            if (command.includes('libera')) {
                userStates.delete(targetId);
                console.log(`[BOT UNMUTE] Reactivado por comando liberar en el chat ${targetId} de forma silenciosa.`);
                return;
            }

            userStates.delete(targetId);
            console.log(`[BOT UNMUTE] Reactivado silenciosamente por mención en el chat ${targetId}.`);
            return;
        }

        // Si el mensaje NO contiene el emoji 🤖 ni @bot, asumimos que fue enviado manualmente.
        const body = msg.body.toLowerCase();
        const isTestCommand = body === 'pruebas' || body.includes('prueba de escritura');
        const isBotCommand = body.includes('@bot');
        const isSystemResponse = body.includes('¡he despertado, jefe!') || body.includes('modo dormido activado, jefe') || body.includes('bot reactivado');

        if (!msg.body.includes('🤖') && !isTestCommand && !isBotCommand && !isSystemResponse) {
            const cleanTargetJid = targetId.split('@')[0].split(':')[0].replace(/\D/g, '') + '@c.us';
            const existingSt = userStates.get(targetId) || userStates.get(cleanTargetJid) || (msg.to ? userStates.get(msg.to) : null) || {};
            const muteObj = {
                ...(typeof existingSt === 'object' ? existingSt : {}),
                state: 'waiting_human',
                waitingCount: 0,
                lastHumanInteraction: Date.now(),
                waiting_human_mode: 'advisor',
                clientWaitingSince: null
            };

            console.log(`[BOT MUTE] Detectada intervención manual para ${targetId}. Silenciando bot estrictamente.`);
            userStates.set(targetId, muteObj);
            userStates.set(cleanTargetJid, muteObj);
            if (msg.to) userStates.set(msg.to, muteObj);

            // Si el asesor intervino manualmente, lo sacamos de la cola de espera
            if (global.supportQueue) {
                const qIdx = global.supportQueue.indexOf(targetId);
                if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
                const qIdx2 = global.supportQueue.indexOf(cleanTargetJid);
                if (qIdx2 !== -1) global.supportQueue.splice(qIdx2, 1);
            }
        }
    }
});

client.on('change_state', state => {
    console.log('CAMBIO DE ESTADO:', state);
});



const BOT_START_TIME = Math.floor(Date.now() / 1000);

let startupLock = Promise.resolve();

async function processFallbackWithEscalation(message, userId, isMedia, mediaData, historyText) {
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
    let userAccounts = [];
    try { userAccounts = await getAccountsByPhone(phoneNumber); } catch (e) { }

    // --- NUEVO: DETECTAR PROMESA DE PAGO Y DEPOSITAR OBSERVACIÓN EN EXCEL ---
    try {
        const { detectPaymentPromise } = require('./aiService');
        const promiseResult = await detectPaymentPromise(message.body || "", historyText);
        if (promiseResult && promiseResult.isPromise && userAccounts.length > 0) {
            let targetAccount = null;
            if (userAccounts.length === 1) {
                targetAccount = userAccounts[0];
            } else if (userAccounts.length > 1) {
                if (promiseResult.platform) {
                    const term = promiseResult.platform.toLowerCase();
                    targetAccount = userAccounts.find(acc => (acc.Streaming || "").toLowerCase().includes(term));
                }
                if (!targetAccount) {
                    const { getJsDateFromExcel } = require('./apiService');
                    const sortedAccounts = [...userAccounts].sort((a, b) => {
                        const dA = getJsDateFromExcel(a.deben || a.vencimiento) || new Date(0);
                        const dB = getJsDateFromExcel(b.deben || b.vencimiento) || new Date(0);
                        return dA - dB;
                    });
                    targetAccount = sortedAccounts[0];
                }
            }

            if (targetAccount && targetAccount._rowNumber && promiseResult.dateStr) {
                const { updateExcelData } = require('./apiService');

                // Validar límite máximo de 14 días
                let withinLimit = true;
                let formattedNoteDate = promiseResult.dateStr;
                try {
                    const promiseDate = new Date(promiseResult.dateStr + 'T12:00:00');
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    const diffTime = promiseDate - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    if (diffDays > 14 || diffDays < 0) {
                        withinLimit = false;
                        console.log(`[Promesa de Pago] Ignorada para fila ${targetAccount._rowNumber} por superar el límite de 14 días: ${diffDays} días.`);
                    } else {
                        // Formatear a DD/MM para que sea más legible y estético en el Excel
                        const day = String(promiseDate.getDate()).padStart(2, '0');
                        const month = String(promiseDate.getMonth() + 1).padStart(2, '0');
                        formattedNoteDate = `${day}/${month}`;
                    }
                } catch (parseErr) {
                    console.error("Error al calcular diferencia de fecha para promesa de pago:", parseErr.message);
                }

                if (withinLimit) {
                    const finalObservation = `paga el ${formattedNoteDate} (bot)`;
                    await updateExcelData(targetAccount._rowNumber, { "observaciones": finalObservation });
                    console.log(`[Promesa de Pago] Auto-guardada en Excel fila ${targetAccount._rowNumber}: ${finalObservation}`);
                }
            }
        }
    } catch (err) {
        console.error("Error en interceptor de promesa de pago:", err.message);
    }

    // Si isMedia y no hay texto, body podría estar vacío, igual se pasa.
    const fallbackResult = await generateEmpatheticFallback(message.body || "", isMedia, historyText, mediaData, userAccounts, userId, userStates);

    // Puede que devuelva solo string si algo falló gravemente, por precaución validamos
    if (typeof fallbackResult === 'string') {
        await safeReply(message, fallbackResult, userId);
        return;
    }

    if (fallbackResult.needsEscalation) {
        const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
        const supportStatus = await isSupportOpen();

        // Registrar primero la espera humana para que el usuario sea contado en la cola
        userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

        const existingSt = userStates.get(userId) || {};
        const isForced = existingSt.isForceBot;
        let replyText = fallbackResult.replyMessage || "";

        if (!supportStatus.open && !isForced) {
            if (!replyText) {
                const { getOfflineReplyMessage } = require('./supportScheduleService');
                replyText = await getOfflineReplyMessage(userId, userStates);
            } else {
                replyText += `\n\n📌 *Nota:* Nuestro horario de atención con asesor humano en vivo se ha completado por hoy. He dejado tu caso registrado para que un asesor lo verifique si necesitas asistencia adicional. 😊`;
            }
        } else {
            const queuePos = getQueuePosition(userId, userStates);
            if (queuePos && !replyText.includes('turno') && !replyText.includes('cola')) {
                replyText += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}. Te atenderemos lo antes posible. ¡Gracias por tu paciencia!`;
            }
        }

        if (replyText) {
            await safeReply(message, replyText, userId);
        }

        try {
            const chat = await client.getChatById(GROUP_ID);
            if (chat) {
                // Resolver contacto y número real para el reporte (LID fix)
                let contact = null;
                try {
                    contact = await message.getContact();
                } catch (e) { }

                let phoneNum = null;
                if (contact) {
                    phoneNum = contact.number || (typeof contact.phoneNumber === 'string' ? contact.phoneNumber : (contact.phoneNumber?.user || contact.phoneNumber?._serialized)) || (contact.id && !contact.id._serialized.includes('@lid') ? contact.id.user : null);
                }
                if (!phoneNum || String(phoneNum).replace(/\D/g, '').length > 13) {
                    const { resolveRealPhoneFromJid } = require('./billingService');
                    phoneNum = await resolveRealPhoneFromJid(userId, client);
                }

                const cleanNum = (phoneNum && String(phoneNum).replace(/\D/g, '').length <= 13) ? String(phoneNum).replace(/\D/g, '') : null;
                const contactName = (contact && (contact.name || contact.pushname || contact.shortName)) || null;

                let userTag = "";
                if (contactName && cleanNum) {
                    userTag = `${contactName} (+${cleanNum})`;
                } else if (contactName) {
                    userTag = `${contactName}`;
                } else if (cleanNum) {
                    userTag = `@${cleanNum}`;
                } else {
                    userTag = `Cliente (@${userId.split('@')[0]})`;
                }

                let ticketTag = "";
                try {
                    const { pool } = require('./database');
                    await pool.query(
                        'INSERT INTO chats (chat_id, customer_name, customer_phone, last_message_text, updated_at) VALUES (?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE updated_at = NOW()',
                        [userId, contactName || null, cleanNum || null, (message.body || '').substring(0, 500)]
                    );
                    // Evitar duplicar tickets abiertos para la misma conversación
                    const [existingTickets] = await pool.query(
                        'SELECT id FROM tickets WHERE chat_id = ? AND status = "open" LIMIT 1',
                        [userId]
                    );

                    let tRes = null;
                    if (existingTickets && existingTickets.length > 0) {
                        const existingId = existingTickets[0].id;
                        await pool.query(
                            'UPDATE tickets SET description = ?, updated_at = NOW() WHERE id = ?',
                            [(message.body || 'Revisión de soporte requerida').substring(0, 500), existingId]
                        );
                        tRes = { insertId: existingId };
                    } else {
                        const [insRes] = await pool.query(
                            'INSERT INTO tickets (chat_id, title, description, status, priority) VALUES (?, ?, ?, ?, ?)',
                            [
                                userId,
                                `Escalamiento IA: ${fallbackResult.escalationSummary || 'Atención de Asesor'}`,
                                (message.body || 'Revisión de soporte requerida').substring(0, 500),
                                'open',
                                'high'
                            ]
                        );
                        tRes = insRes;
                    }
                    if (tRes && tRes.insertId) {
                        ticketTag = ` (#TK-${tRes.insertId})`;
                    }
                } catch (tErr) {
                    console.error("Error guardando ticket en DB:", tErr.message);
                }

                await chat.sendMessage(`🚨 *ESCALAMIENTO IA SOPORTE*${ticketTag} de ${userTag}\n\n${fallbackResult.escalationSummary || 'Revisión manual requerida.'}`);
            }
        } catch (e) { console.error('Error enviando escalamiento:', e); }
        globalLastPaymentUserId = userId;
    } else {
        if (fallbackResult.replyMessage) {
            await safeReply(message, fallbackResult.replyMessage, userId);
        }
    }
}

// Eliminamos isNameIncomplete anterior para delegar a la IA

/**
 * Procesa el envío del código 2FA o manual para una cuenta seleccionada
 */
async function processAccountVerificationCode(message, userId, targetAccount, realPhone, client, userStates) {
    const accountEmail = (targetAccount.correo || "").trim().toLowerCase();
    const streamingName = (targetAccount.Streaming || "").toUpperCase();
    const isNetflixExtra = streamingName.includes('NETFLIX') && streamingName.includes('EXTRA');

    if (accountEmail && !isNetflixExtra) {
        const fs = require('fs');
        const path = require('path');

        // A. Es una cuenta GPT o Amazon con TOTP offline
        const gptSecrets = fs.existsSync(path.join(__dirname, 'tokens', 'gpt_secrets.json'))
            ? JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens', 'gpt_secrets.json'), 'utf8'))
            : {};
        const hasTotpSecret = gptSecrets[accountEmail];

        if (hasTotpSecret) {
            let secretService = "CHATGPT";
            if (typeof hasTotpSecret === 'object' && hasTotpSecret.service) {
                secretService = hasTotpSecret.service.toUpperCase();
            } else {
                if (accountEmail.includes('amazon') || accountEmail.includes('prime')) {
                    secretService = 'AMAZON';
                } else if (accountEmail.includes('netflix')) {
                    secretService = 'NETFLIX';
                }
            }

            const matchesService = streamingName.includes(secretService) || secretService.includes(streamingName);

            if (matchesService) {
                const { generateGPTCode, checkAndIncrementUsage } = require('./totpService');
                const canRequest = checkAndIncrementUsage(realPhone, accountEmail);
                if (!canRequest) {
                    await message.reply("🤖 Has alcanzado el límite de 3 códigos para este inicio de sesión. Por seguridad, si necesitas más ayuda, un asesor humano revisará tu caso.");
                    return;
                }
                const code = generateGPTCode(accountEmail);
                if (code) {
                    await message.reply(`🔐 *Tu código de acceso (2FA) para ${streamingName}:* 🚀\n\n🔢 Código: *${code}*\n\n_Este código cambia cada 30 segundos. Úsalo pronto._`);
                    userStates.delete(userId);
                    return {
                        success: true,
                        code: code,
                        type: 'totp',
                        message: `Código 2FA generado: ${code}`
                    };
                }
            }
        }

        // B. Cuenta con token de Gmail configurado (Disney+, Max, Netflix 4K, YouTube, etc.)
        const tokenExists = fs.existsSync(path.join(__dirname, 'tokens', `token_${accountEmail}.json`));

        if (tokenExists) {
            const { findRecentCodes } = require('./gmailService');
            try {
                const codes = await findRecentCodes(accountEmail, 10);

                if (codes && codes.length > 0) {
                    const latest = codes[0];
                    const nameLower = streamingName.toLowerCase();

                    // Plataformas basadas ÚNICAMENTE en Código OTP (ej: Disney+, Max, Amazon, Paramount, VIX)
                    const isCodeOnlyPlatform = nameLower.includes('disney') || nameLower.includes('star') || nameLower.includes('max') || nameLower.includes('hbo') || nameLower.includes('prime') || nameLower.includes('amazon') || nameLower.includes('paramount') || nameLower.includes('vix') || nameLower.includes('youtube');

                    // Plataformas basadas ÚNICAMENTE en Enlace Mágico / Magic Link (ej: Claude, Canva, ChatGPT)
                    const isLinkOnlyPlatform = nameLower.includes('claude') || nameLower.includes('canva') || nameLower.includes('gpt') || nameLower.includes('notion') || nameLower.includes('medium');

                    let response = '';

                    if (isCodeOnlyPlatform || (!latest.link && latest.code)) {
                        // 1. ENTREGA EXCLUSIVA DE CÓDIGO (DISNEY, MAX, PRIME, ETC.)
                        response = `🤖 *Código de ${streamingName} Encontrado* 🚀\n\n`;
                        if (latest.code) {
                            response += `🔢 *Tu código de acceso es:* *${latest.code}*\n\n`;
                        } else {
                            response += `📝 ${latest.snippet}\n\n`;
                        }
                        response += `⏰ Recibido hace ${latest.time} min.\n\n_Úsalo en tu pantalla o aplicación para iniciar sesión._`;

                    } else if (isLinkOnlyPlatform) {
                        // 2. ENTREGA EXCLUSIVA DE ENLACE MÁGICO (CLAUDE, CANVA, ETC.)
                        response = `🤖 *Enlace de acceso de ${streamingName} Encontrado* 🚀\n\n`;
                        if (latest.link) {
                            response += `🔗 *Haz clic en este enlace para iniciar sesión / activar tu cuenta:*\n👉 ${latest.link}\n\n`;
                        }
                        response += `📝 ${latest.snippet}\n⏰ Recibido hace ${latest.time} min.\n\n_Recuerda que este enlace vence pronto._`;

                    } else if (nameLower.includes('netflix')) {
                        // 3. NETFLIX (CÓDIGO DE 4 DÍGITOS + ENLACE DE HOGAR SHEERIT)
                        let cleanPhone = realPhone ? String(realPhone).replace(/\D/g, '') : '';
                        if (!cleanPhone || cleanPhone.length > 13 || cleanPhone.length < 10) {
                            if (targetAccount && (targetAccount.numero || targetAccount.Numero || targetAccount.telefono || targetAccount.Telefono || targetAccount.celular)) {
                                cleanPhone = String(targetAccount.numero || targetAccount.Numero || targetAccount.telefono || targetAccount.Telefono || targetAccount.celular).replace(/\D/g, '');
                            }
                        }
                        const emailParam = accountEmail ? `&email=${encodeURIComponent(accountEmail)}` : '';
                        const validVerificationLink = (cleanPhone && cleanPhone.length >= 10 && cleanPhone.length <= 13) 
                            ? `https://sheerit.co/verificar?tel=${cleanPhone}${emailParam}` 
                            : (accountEmail ? `https://sheerit.co/verificar?email=${encodeURIComponent(accountEmail)}` : `https://sheerit.co/verificar`);

                        const isFourDigitPin = latest.code && /^\d{4}$/.test(latest.code.toString().trim());

                        response = `🤖 *${isFourDigitPin ? 'Código y Enlace' : 'Enlace de acceso'} de NETFLIX (${accountEmail || 'Tu cuenta'}) Encontrado* 🚀\n\n`;
                        if (isFourDigitPin) {
                            response += `🔢 *Tu código de acceso es:* *${latest.code}*\n\n`;
                        }
                        response += `🔗 *Ingresa a este enlace para confirmar el acceso e IP de tu hogar en tu TV/celular:*\n👉 ${validVerificationLink}\n\n`;
                        response += `📝 ${latest.snippet}\n⏰ Recibido hace ${latest.time} min.\n\n_Recuerda que este enlace vence pronto._`;

                    } else {
                        // 4. CASO GENERAL RESTANTE
                        const hasLink = !!latest.link;
                        response = `🤖 *${hasLink ? 'Enlace de acceso' : 'Código'} de ${streamingName} Encontrado* 🚀\n\n`;
                        if (latest.code && !hasLink) {
                            response += `🔢 *Tu código de acceso es:* *${latest.code}*\n\n`;
                        }
                        if (hasLink) {
                            response += `🔗 *Haz clic en este enlace para iniciar sesión / activar tu cuenta:*\n👉 ${latest.link}\n\n`;
                        }
                        response += `📝 ${latest.snippet}\n⏰ Recibido hace ${latest.time} min.`;
                    }
                    await safeReply(message, response, userId);
                    userStates.delete(userId);
                    return {
                        success: true,
                        code: latest.code || null,
                        link: latest.link || (nameLower.includes('netflix') ? validVerificationLink : null),
                        snippet: latest.snippet || null,
                        type: latest.link ? 'link' : (latest.code ? 'code' : 'general'),
                        message: latest.code ? `Código encontrado: ${latest.code}` : (latest.link ? 'Enlace de acceso encontrado' : 'Código o enlace encontrado')
                    };
                } else {
                    const notFoundText = `No encontré códigos recientes en ${accountEmail} para ${streamingName}. Por favor, asegúrate de presionar 'Enviar código' en tu pantalla y vuelve a intentarlo.`;
                    await safeReply(message, `🤖 ${notFoundText}`, userId);
                    userStates.delete(userId);
                    return {
                        success: false,
                        message: notFoundText
                    };
                }
            } catch (err) {
                console.error(`Error al buscar códigos en Gmail para ${accountEmail}:`, err.message);
                if (err.message.includes('invalid_grant') || err.message.includes('auth') || err.message.includes('token') || err.message.includes('credential')) {
                    await safeReply(message, `⚠️ *Error de conexión con la cuenta* ⚠️\n\nEl buzón de correo de ${accountEmail} ha perdido la conexión de seguridad o requiere volver a vincularse.\n\nPor favor, contacta a soporte para que un administrador vincule la cuenta nuevamente.`, userId);
                } else {
                    await safeReply(message, `🤖 Hubo un inconveniente temporal al consultar los códigos en ${accountEmail}. Por favor, vuelve a intentarlo en un momento.`, userId);
                }
                userStates.delete(userId);
                return {
                    success: false,
                    message: `Error al consultar buzón: ${err.message}`
                };
            }
        }

        // C. Correo externo vinculado a una receta RPA — consulta directamente la BD
        if (accountEmail) {
            try {
                const { pool } = require('./database');
                const [subRows] = await pool.query(
                    `SELECT sa.rpa_recipe_id, r.name as recipe_name, r.recipe_json
                     FROM stream_accounts sa
                     LEFT JOIN rpa_recipes r ON r.id = sa.rpa_recipe_id
                     WHERE sa.account_email = ? AND sa.is_provider = 1
                     LIMIT 1`,
                    [accountEmail.toLowerCase().trim()]
                );

                if (subRows.length > 0 && subRows[0].rpa_recipe_id && subRows[0].recipe_json) {
                    await message.reply(`🤖 *Buscando tu código de acceso para ${streamingName}...* ⏳\n\nEsto puede tardar unos 30-45 segundos. Por favor espera en línea.`);

                    const recipeJson = typeof subRows[0].recipe_json === 'string'
                        ? JSON.parse(subRows[0].recipe_json)
                        : subRows[0].recipe_json;

                    const rpaVariables = { CUSTOMER_EMAIL: accountEmail };
                    console.log(`[RPA Auto] Ejecutando receta #${subRows[0].rpa_recipe_id} ("${subRows[0].recipe_name}") para ${accountEmail}`);

                    const rpaResult = await runRpaRecipe(recipeJson, rpaVariables);

                    if (rpaResult && rpaResult.success && rpaResult.data) {
                        const extractedCode = Object.values(rpaResult.data).find(v => v && v.toString().trim().length >= 4);
                        if (extractedCode) {
                            await message.reply(`🔐 *Tu código de acceso para ${streamingName}:* 🚀\n\n🔢 Código: *${extractedCode.toString().trim()}*\n\n_Úsalo pronto para iniciar sesión en tu dispositivo._`);
                            userStates.delete(userId);
                            return;
                        }
                    }
                    console.warn(`[RPA Auto] Receta #${subRows[0].rpa_recipe_id} no devolvió código válido para ${accountEmail}`);
                }
            } catch (rpaErr) {
                console.error('[RPA Auto Error]', rpaErr.message);
            }
        }

        // D. Es Netflix pero no tiene token (dar el verificador web)
        if (streamingName.includes('NETFLIX')) {
            await message.reply(`🤖 ¡Hola! Para generar tu código de hogar, ingresa a este enlace:\n\n👉 https://sheerit.co/verificar?tel=${realPhone}`);
            userStates.delete(userId);
            return;
        }

        // E. No tiene token y no es Netflix (explicar amablemente y alertar al grupo admin)
        await message.reply(`🤖 ¡Hola! Encontré tu cuenta de *${streamingName}* (${accountEmail}), pero aún no está vinculada a nuestro sistema de códigos automáticos 2FA.\n\nHe notificado a tu asesor para que te entregue tu código manualmente en un momento. Además, vincularemos tu cuenta para que en futuras ocasiones puedas obtener tus códigos en segundos de forma automática. ¡Gracias por tu paciencia!`);

        // Silenciar bot para este cliente y poner en cola de espera humana
        userStates.set(userId, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now(), waiting_human_mode: 'bot' });
        if (!global.supportQueue) global.supportQueue = [];
        const qIdx = global.supportQueue.indexOf(userId);
        if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
        global.supportQueue.push(userId);

        try {
            const groupChat = await client.getChatById(GROUP_ID);
            if (groupChat) {
                await groupChat.sendMessage(`🚨 *CÓDIGO MANUAL REQUERIDO* de @${realPhone}\n📺 Plataforma: *${streamingName}*\n📧 Cuenta: *${accountEmail}*\n\n_Por favor entrega el código manualmente y vincula su token de Gmail si aplica._`);
            }
        } catch (err) {
            console.error("Error notificando al grupo sobre código manual:", err.message);
        }
        return;
    }
}


/**
 * Determina si hay algún mensaje reciente enviado por un humano (asesor) en las últimas 6 horas.
 */
async function hasRecentHumanMessage(message, limit = 15) {
    try {
        const chat = await message.getChat();
        const msgs = await chat.fetchMessages({ limit });
        const nowSec = Math.floor(Date.now() / 1000);
        for (const m of msgs) {
            if (m.fromMe && !m.body.includes('🤖')) {
                const diffHours = (nowSec - m.timestamp) / 3600;
                if (diffHours <= 1.5) {
                    return true;
                }
            }
        }
    } catch (e) {}
    return false;
}


/**
 * Procesa un lote de mensajes de un mismo usuario con bloqueo a nivel de usuario.
 */
async function processIncomingMessage(messages) {
    if (messages.length === 0) return;

    const firstMsg = messages[0];
    let userId = firstMsg.from;

    if (firstMsg.fromMe && firstMsg.to && firstMsg.to !== (client.info ? client.info.wid._serialized : '')) {
        userId = firstMsg.to;
    }

    // Auto-expirar estados de espera humana antiguos de más de 1.5 horas
    const existingSt = userStates.get(userId);
    if (existingSt && (existingSt.state === 'waiting_human' || existingSt.state === 'awaiting_support_details')) {
        const lastTime = existingSt.lastHumanInteraction || existingSt.timestamp || existingSt.waitingTimestamp || 0;
        const ageHours = lastTime ? (Date.now() - lastTime) / (1000 * 3600) : 999;
        if (ageHours > 1.5) {
            console.log(`[Auto-Expire] Limpiado estado de espera humano antiguo (${ageHours.toFixed(1)}h) para @${userId}.`);
            userStates.delete(userId);
        }
    }

    try {
        if (await isProviderSender(userId)) {
            console.log(`[Provider Bypass] Ignorando procesamiento de mensaje del proveedor: ${userId}`);
            userStates.set(userId, { state: 'waiting_human', waiting_human_mode: 'advisor', is_provider: true });
            return;
        }
    } catch (e) {}

    if (activeProcessingUsers.has(userId)) {
        console.log(`[Deduplicator] ⏳ El usuario @${userId.replace('@c.us', '')} ya tiene una petición en proceso activo. Omitiendo lote duplicado.`);
        return;
    }

    activeProcessingUsers.add(userId);
    try {
        await baseProcessIncomingMessage(messages);
    } finally {
        activeProcessingUsers.delete(userId);
    }
}

/**
 * Procesa un lote de mensajes de un mismo usuario.
 * @param {Message[]} messages 
 */
async function baseProcessIncomingMessage(messages) {
    if (messages.length === 0) return;

    const batchId = messages.map(m => {
        if (!m.id) return '';
        if (m.id._serialized) return m.id._serialized;
        const remoteStr = (typeof m.id.remote === 'object' && m.id.remote) ? m.id.remote._serialized : m.id.remote;
        return `${m.id.fromMe ? 'true' : 'false'}_${remoteStr}_${m.id.id}`;
    }).join(',');
    if (processedMessageIds.has(batchId)) {
        console.log(`[Deduplicator] Ignorando lote ya procesado simultáneamente: ${batchId}`);
        return;
    }
    processedMessageIds.add(batchId);

    const firstMsg = messages[0];
    let userId = firstMsg.from;

    // Extraemos el autor real del mensaje (especialmente en grupos o dispositivos vinculados)
    const authorId = firstMsg.author || firstMsg.from;
    const authorPhone = authorId.replace('@c.us', '').replace(/\D/g, '');
    const chatPhone = userId.replace('@c.us', '').replace(/\D/g, '');

    // Reconocimiento blindado del jefe (por su número personal, incluso en grupos)
    const isFromAdmin = authorPhone.includes(ADMIN_RAW_PHONE) || authorPhone.includes('3133890800') || authorPhone.includes('573133890800') || firstMsg.fromMe;

    // --- CORRECCIÓN DE CONTEXTO ---
    // Si el mensaje es enviado por el jefe (fromMe), el ID de la conversación (userId) es el destinatario (to)
    if (firstMsg.fromMe && firstMsg.to && firstMsg.to !== (client.info ? client.info.wid._serialized : '')) {
        userId = firstMsg.to;
    }

    // realPhone se mantiene como el ID del chat para búsqueda de cuentas etc.
    let realPhone = userId.replace('@c.us', '').replace(/\D/g, '');

    const combinedAdminBody = messages.map(m => m.body || "").join(' ').trim();
    const hasExplicitBotCall = combinedAdminBody.toLowerCase().includes('@bot');
    const isAdminPrivateChat = userId.replace('@c.us', '') === ADMIN_RAW_PHONE || userId.replace('@c.us', '') === '573133890800' || userId.replace('@c.us', '') === '3133890800';

    // --- PRIORIDAD JEFE (SOLO SI ES EN CHAT PRIVADO DEL JEFE O SI INVOCA EXPLÍCITAMENTE @bot) ---
    if (isFromAdmin && !userId.includes('@g.us') && (hasExplicitBotCall || isAdminPrivateChat)) {
        const { detectAdminIntent } = require('./aiService');
        const adminAI = await detectAdminIntent(combinedAdminBody);

        console.log(`[Chief Mode] Intención detectada: ${adminAI.intent} para ${adminAI.target_user || adminAI.target}`);

        if (adminAI.intent === 'dame_cuenta' && (adminAI.target_platform || adminAI.target_user)) {
            const { handleAdminForceRetrieve } = require('./adminService');
            await handleAdminForceRetrieve(firstMsg, adminAI.target_platform || adminAI.target_user, client, adminAI.target_user);
            return;
        } else if (adminAI.intent === 'confirmar_pago') {
            const { handleAdminPaymentConfirmation } = require('./adminService');
            await handleAdminPaymentConfirmation(firstMsg, firstMsg.body, client, userStates, null);
            return;
        } else if (adminAI.intent === 'liberar_bot' && hasExplicitBotCall) {
            userStates.delete(userId);
            const isAdminPrivate = userId.replace('@c.us', '') === ADMIN_RAW_PHONE;
            if (isAdminPrivate) {
                await firstMsg.reply(`✅ Bot reactivado para ti, jefe.`);
            } else {
                // Lectura prematura del chat para llegar ayudando
                const { generateReactivationResponse } = require('./aiService');
                const chatHistory = await getChatHistoryText(firstMsg, 10);
                const reactivationMsg = await generateReactivationResponse(chatHistory);
                await firstMsg.reply(reactivationMsg);
            }
            return;
        }
    }

    // Filtrar stickers, reacciones y estados del lote
    const validMessages = messages.filter(m => m.type !== 'sticker' && m.type !== 'reaction' && !m.isStatus);

    if (validMessages.length === 0) {
        console.log(`[Batch Processor] Ignorando lote porque solo contiene stickers, reacciones o estados para @${userId.replace('@c.us', '')}`);
        return;
    }

    const message = validMessages[validMessages.length - 1];
    let isMedia = validMessages.some(m => m.hasMedia);
    const combinedBody = validMessages.map(m => m.body || "").filter(b => b !== "").join("\n");
    message.combinedBody = combinedBody;

    // --- INTERCEPTOR ESPECIAL ADMINISTRADOR ---
    if (isFromAdmin) {
        const adminStateData = userStates.get(userId) || {};
        const cleanBody = (message.body || "").trim().toLowerCase();
        const isSimulating = adminStateData.state === 'simulating_client';

        if (!cleanBody.startsWith("@bot") && !message.fromMe && !message.hasMedia && !isSimulating) {
            const { handleAdminSuggestions } = require('./adminQueries');
            await handleAdminSuggestions(message, userStates);
        }
    }

    let contact = null;
    let resolvedPhoneFromLid = null;

    // Fast-path 1: si el estado ya tiene guardado el realPhone
    const cachedState = userStates.get(userId);
    if (cachedState && cachedState.realPhone) {
        resolvedPhoneFromLid = cachedState.realPhone;
    }

    // Fast-path 2: si es LID (o JID de LID), buscar en la BD (tabla chats)
    const isLidJid = userId.includes('@lid') || (userId.includes('@c.us') && !userId.replace(/\D/g, '').startsWith('57') && userId.replace(/\D/g, '').length > 10) || userId.replace(/\D/g, '').length > 12;
    if (!resolvedPhoneFromLid && isLidJid) {
        try {
            const { pool } = require('./database');
            const [chatRows] = await pool.query(
                'SELECT customer_phone FROM chats WHERE chat_id = ? AND customer_phone IS NOT NULL LIMIT 1',
                [userId]
            );
            if (chatRows.length > 0 && chatRows[0].customer_phone) {
                resolvedPhoneFromLid = chatRows[0].customer_phone;
            }
        } catch (e) { }
    }

    // Fast-path 2.5: si es LID y no está en la BD, consultar Puppeteer Store en tiempo real
    if (!resolvedPhoneFromLid && isLidJid) {
        try {
            const { resolveRealPhoneFromJid } = require('./billingService');
            const resolved = await resolveRealPhoneFromJid(userId);
            if (resolved && resolved.length >= 7) {
                resolvedPhoneFromLid = resolved;
            }
        } catch (e) {
            console.warn("[LID Fix index.js] Error consultando Puppeteer Store:", e.message);
        }
    }

    // Fast-path 3: consultar getContact con timeout estricto de 2000ms
    try {
        if (message && message.id && message.id._serialized) {
            if (message.fromMe) {
                contact = await Promise.race([
                    client.getContactById(userId),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout getContactById (2s)")), 2000))
                ]).catch(() => null);
            } else if (typeof message.getContact === 'function') {
                contact = await Promise.race([
                    message.getContact(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout getContact (2s)")), 2000))
                ]).catch(() => null);
            }

            if (contact) {
                let extractedNum = null;
                if (contact.phoneNumber) {
                    if (typeof contact.phoneNumber === 'string') {
                        extractedNum = contact.phoneNumber.replace(/\D/g, '');
                    } else if (typeof contact.phoneNumber === 'object' && contact.phoneNumber.user) {
                        extractedNum = contact.phoneNumber.user;
                    } else if (typeof contact.phoneNumber === 'object' && contact.phoneNumber._serialized) {
                        extractedNum = contact.phoneNumber._serialized.replace(/\D/g, '');
                    }
                }
                
                if (!extractedNum && contact.number) {
                    const cleanCNum = String(contact.number).replace(/\D/g, '');
                    // Si el número tiene entre 7 y 12 dígitos y no parece un LID (más de 12 dígitos), lo usamos
                    if (cleanCNum.length >= 7 && cleanCNum.length <= 12) {
                        extractedNum = cleanCNum;
                    }
                }

                const botNum = (client.info && client.info.wid) ? client.info.wid.user : '3118587974';
                if (extractedNum && extractedNum !== botNum && extractedNum !== '573118587974' && extractedNum.length <= 12) {
                    resolvedPhoneFromLid = extractedNum;
                }
            }
        }
    } catch (err) {
        console.warn("No se pudo obtener contacto del mensaje:", err.message);
    }

    if (resolvedPhoneFromLid) {
        const cleanResolved = String(resolvedPhoneFromLid).replace(/\D/g, '');
        if (cleanResolved.length >= 7 && cleanResolved !== '573118587974') {
            realPhone = cleanResolved;

            // Persistir mapeo en DB chats y userStates
            try {
                const { pool } = require('./database');
                await pool.query(
                    'UPDATE chats SET customer_phone = ? WHERE chat_id = ?',
                    [realPhone, userId]
                );
            } catch (e) { }

            const targetState = userStates.get(userId);
            if (targetState && typeof targetState === 'object') {
                targetState.realPhone = realPhone;
                userStates.set(userId, targetState);
            }
        }
    }

    // Asegurar que el estado tenga guardado el chatJid original para envíos directos sin LID mismatch
    const originalChatJid = firstMsg.fromMe && firstMsg.to ? firstMsg.to : firstMsg.from;
    let rawState = userStates.get(userId);
    if (rawState && typeof rawState === 'object') {
        rawState.chatJid = originalChatJid;
        userStates.set(userId, rawState);
    } else if (!rawState) {
        userStates.set(userId, { chatJid: originalChatJid });
    }

    // --- MUTE ABSOLUTO PROVEEDORES ---
    if (realPhone.includes('3027892534') || realPhone.includes('3027892574')) {
        console.log(`[Mute] Chat con proveedor @${realPhone} ignorado.`);
        return;
    }

    let rawPushName = contact ? (contact.name || contact.pushname) : null;
    let foundName = null;
    if (rawPushName && typeof rawPushName === 'string') {
        const cleanName = rawPushName.trim();
        if (cleanName.length >= 2 && /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(cleanName) && !/^[\.\-_,\s\d*~+!#%&/()=?]+$/.test(cleanName)) {
            foundName = cleanName;
        }
    }
    if (!foundName) {
        try {
            const { searchContactByPhone } = require('./googleContactsService');
            foundName = await searchContactByPhone(userId).catch(() => null);
        } catch (err) {
            console.warn('[Google Contacts Bypass] Error al buscar contacto:', err.message);
        }

        // Si aún no hay nombre, buscar en la base de datos de Excel por el número
        if (!foundName) {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(realPhone);
            if (userAccounts && userAccounts.length > 0) {
                foundName = userAccounts[0].Nombre || userAccounts[0].nombre;
            }
        }
    }

    // RESOLUCIÓN LID POR NOMBRE: Si el número es un LID (>12 dígitos) y tenemos el nombre de contacto, buscar en Excel para vincular su teléfono real
    if (foundName && (userId.includes('@lid') || (realPhone && realPhone.length > 12))) {
        try {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(realPhone, foundName);
            if (userAccounts && userAccounts.length > 0) {
                const rowPhone = (userAccounts[0].numero || userAccounts[0].Numero || userAccounts[0].whatsapp || userAccounts[0].WhatsApp || '').toString().replace(/\D/g, '');
                if (rowPhone && rowPhone.length >= 10 && rowPhone.length <= 13) {
                    realPhone = rowPhone;
                    console.log(`[LID Resolution by Name/Sheet] @${userId} resuelto a teléfono real ${realPhone} (${foundName})`);
                    try {
                        const { pool } = require('./database');
                        await pool.query(
                            'UPDATE chats SET customer_phone = ? WHERE chat_id = ?',
                            [realPhone, userId]
                        );
                    } catch (e) { }
                }
            }
        } catch (e) {
            console.warn('[LID Resolution] Error:', e.message);
        }
    }


    // 2. ESTADO ACTUAL
    const cleanPhoneJid = realPhone ? (realPhone + '@c.us') : userId.split('@')[0].split(':')[0].replace(/\D/g, '') + '@c.us';
    let currentStateData = userStates.get(userId) || userStates.get(cleanPhoneJid) || userStates.get(realPhone);
    let currentState = undefined;
    if (currentStateData && typeof currentStateData === 'object') {
        currentState = currentStateData.state;
    }

    // --- ANTI-AUTO-CONTESTAR (Loop Protection) ---
    // Si el mensaje contiene el emoji del bot (🤖), es una respuesta automática.
    // Ignoramos COMPLETAMENTE para no entrar en bucles de autocontestación.
    if (message.body && message.body.includes('🤖')) {
        console.log(`[Auto] Ignorando mensaje automático (🤖) para @${userId.replace('@c.us', '')}`);
        return;
    }

    // --- FILTRO DE MENSAJES PROPIOS (ADMIN) ---
    const cleanBodyText = message.body ? message.body.trim() : "";
    const isAdminCommand = cleanBodyText.toLowerCase().startsWith("@bot ");
    const hasBotMention = cleanBodyText.toLowerCase().includes("@bot");

    if (message.fromMe) {
        // Excepción: Permitir comandos de @bot para el admin dashboard
        if (isAdminCommand || cleanBodyText.toLowerCase() === "@bot" || hasBotMention) {
            console.log(`[Admin] Comando o mención detectada de la propia cuenta: ${cleanBodyText}`);
            // Reactivar si estaba en waiting_human
            if (currentState === 'waiting_human') {
                console.log(`[BOT MUTE] Reactivado por comando administrativo @bot.`);
                userStates.delete(userId);
                currentState = undefined;
            }
            if (!isAdminCommand) return; // Si fue una mención para reactivar el chat con cliente, ignorar para la IA.
        } else {
            if (currentState !== 'waiting_human') {
                console.log(`[BOT MUTE] Detectada intervención manual para ${userId}. Silenciando bot.`);
            }
            const existingData = typeof currentStateData === 'object' ? currentStateData : {};
            userStates.set(userId, {
                ...existingData,
                state: 'waiting_human',
                nombre: foundName,
                waitingCount: 0,
                lastHumanInteraction: Date.now(),
                waiting_human_mode: 'advisor',
                clientWaitingSince: null
            });
            return;
        }
    }

    // Ignorar mensajes vacíos (sin texto ni archivos multimedia) para evitar clasificar intenciones inexistentes y responder spam
    const hasText = message.body && message.body.trim() !== "";
    if (!hasText && !message.hasMedia) {
        console.log(`[Ignorado] Mensaje vacío (sin texto ni multimedia) de ${userId}.`);
        return;
    }

    console.log(`[DEBUG] Procesando mensaje de: ${userId} Contenido: ${message.body || "[Sin texto]"}`);

    // Ignorar stickers, reacciones, y estados
    if (message.type === 'sticker' || message.type === 'reaction' || message.isStatus) {
        console.log(`[Ignorado] Mensaje tipo ${message.type} de ${userId}.`);
        return;
    }

    // Ignorar mensajes que son exclusivamente emojis (pero PERMITIMOS números y letras)
    const isEmojiOnly = /^[\p{Emoji}\s]+$/u.test(cleanBodyText);
    const hasAlphaNumeric = /[a-zA-Z0-9]/.test(cleanBodyText);

    if (isEmojiOnly && !hasAlphaNumeric) {
        console.log(`[Ignorado] Mensaje solo contiene emojis de ${userId}.`);
        return;
    }

    // Marcar chat como leído para limpiar notificaciones y bucles de atendido
    try {
        if (!message.fromMe) {
            const chat = await message.getChat();
            if (chat && chat.unreadCount > 0) {
                await chat.sendSeen();
            }
        }
    } catch (err) { }

    // Sincronizar con Google Contacts si tenemos un nombre válido y es un chat individual
    const isLidPhone = realPhone.length > 12 || (!realPhone.startsWith('57') && realPhone.length > 10);
    if (!message.fromMe && foundName && !realPhone.includes(ADMIN_RAW_PHONE) && !userId.includes('@g.us') && !isLidPhone) {
        try {
            const { addNewContact } = require('./googleContactsService');
            await addNewContact(foundName, realPhone).catch(() => null);
        } catch (e) {
            console.warn('[Google Contacts Bypass] Error agregando contacto, omitiendo:', e.message);
        }

        try {
            const { pool } = require('./database');
            await pool.query(
                `INSERT INTO customers (phone, fullname) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE fullname = VALUES(fullname)`,
                [realPhone, foundName]
            );
            console.log(`[Database] Cliente ${foundName} guardado/actualizado en la base de datos.`);
        } catch (dbErr) {
            console.error("[Database] Error al guardar cliente en BD:", dbErr.message);
        }
    }

    // --- IDENTIFICADOR DE ESTADO INICIAL ---
    if (currentStateData && typeof currentStateData === 'object') {
        currentState = currentStateData.state;
    }

    // --- DETECCIÓN DIRECTA DE ASESOR HUMANO EN EL HISTORIAL DEL CHAT (ANTI-INTERRUPCIÓN) ---
    // Si un asesor humano habló en el chat en los últimos 45 minutos (sin emoji 🤖), silenciar de inmediato
    let hasRecentHuman = false;
    try {
        const chat = await message.getChat().catch(() => null);
        if (chat) {
            const recentMsgs = await chat.fetchMessages({ limit: 8 }).catch(() => []);
            const nowSec = Math.floor(Date.now() / 1000);
            for (const m of recentMsgs) {
                if (m.fromMe && m.body && !m.body.includes('🤖')) {
                    const ageMinutes = (nowSec - m.timestamp) / 60;
                    if (ageMinutes <= 45) {
                        hasRecentHuman = true;
                        break;
                    }
                }
            }
        }
    } catch (e) { }

    const bodyMsgLower = (message.body || '').trim().toLowerCase();
    const isDirectCodeOrCredentialsReq = [
        'código', 'codigo', 'código de verificación', 'codigo de verificacion',
        'código de acceso', 'codigo de acceso', '2fa', 'authenticator', 'hogar',
        'actualizar hogar', 'contraseña', 'clave'
    ].some(kw => bodyMsgLower.includes(kw));

    if (hasRecentHuman && !message.body?.toLowerCase().includes('@bot') && message.body?.trim().toLowerCase() !== 'menu' && !isDirectCodeOrCredentialsReq) {
        console.log(`[BOT MUTE ACTIVE] Intervención humana reciente (<45 min) detectada en el chat de @${userId}. Bot silenciado estrictamente.`);
        const muteObj = {
            ...(typeof currentStateData === 'object' ? currentStateData : {}),
            state: 'waiting_human',
            waitingCount: 0,
            lastHumanInteraction: Date.now(),
            waiting_human_mode: 'advisor',
            nombre: foundName
        };
        userStates.set(userId, muteObj);
        userStates.set(cleanPhoneJid, muteObj);
        return;
    }

    if (currentState === 'waiting_human') {
        const mode = (currentStateData && typeof currentStateData === 'object') ? (currentStateData.waiting_human_mode || 'bot') : 'bot';
        const cleanInput = (message.body || '').trim().toLowerCase();

        // 0. FORCED SILENCE RULE: Si el asesor interactuó en las últimas 2 horas, mantener el bot estrictamente silenciado
        const lastInteraction = Math.max(
            (currentStateData && currentStateData.lastHumanInteraction) || 0,
            (userStates.get(userId) && userStates.get(userId).lastHumanInteraction) || 0,
            (userStates.get(cleanPhoneJid) && userStates.get(cleanPhoneJid).lastHumanInteraction) || 0
        );
        const timeSinceLastHumanMs = Date.now() - lastInteraction;
        const minutesSinceLastHuman = timeSinceLastHumanMs / (1000 * 60);

        if (minutesSinceLastHuman < 120 || (currentStateData && currentStateData.agent) || mode === 'advisor') {
            console.log(`[BOT MUTE ACTIVE] Silenciando bot para @${userId} (Asesor activo hace ${minutesSinceLastHuman.toFixed(1)} mins o asignado a ${currentStateData ? currentStateData.agent : 'humano'}).`);
            return;
        }

        // 1. Evaluar si es una intención resoluble para reactivar el bot solo si NO hay asesor asignado ni charla reciente
        let isSolvable = false;
        let mediaData = null;
        if (message.hasMedia) {
            try {
                const media = await downloadMediaWithRetry(message);
                if (media && media.data && media.mimetype) {
                    const cleanMime = media.mimetype.split(';')[0].trim();
                    const isAudio = message.type === 'ptt' || message.type === 'audio' || cleanMime.startsWith('audio/');
                    if (isAudio) {
                        const { transcribeAudioWithGemini } = require('./aiService');
                        const transcript = await transcribeAudioWithGemini({ data: media.data, mimeType: cleanMime });
                        if (transcript) {
                            message.body = transcript;
                        }
                    } else {
                        mediaData = { data: media.data, mimeType: cleanMime };
                    }
                }
            } catch (e) { }
        }

        let userAccounts = [];
        try {
            const { getAccountsByPhone } = require('./apiService');
            userAccounts = await getAccountsByPhone(realPhone, foundName);
        } catch (e) { }

        let detection = null;
        try {
            const { detectInitialIntent } = require('./aiService');
            const hist = await getChatHistoryText(message, 15);
            detection = await detectInitialIntent(message.body, hist, mediaData, userAccounts);

            const cleanBody = (message.body || "").trim();
            const solvableIntents = ["comprar", "pagar", "credenciales", "catalogo", "renovar"];
            const isMenuSelection = ['1', '2', '3', '4', '5'].includes(cleanBody);

            const wantsCodeKeywords = [
                'código', 'codigo', 'actualizar hogar', 'mi codigo', 'mi código',
                'enviar código', 'enviar codigo', 'el código', 'el codigo',
                'pide codigo', 'pide código', 'authenticator', 'token', 'verificacion', 'verificación'
            ];

            let isCodeRequest = (wantsCodeKeywords.some(kw => cleanBody.toLowerCase().includes(kw)) && !cleanBody.toLowerCase().includes('qr') && !cleanBody.toLowerCase().includes('barras') && !cleanBody.toLowerCase().includes('pago')) || cleanBody === '?';

            const isProv = await isProviderSender(userId);
            if (isProv) {
                console.log(`[PROVIDER MSG] @${userId.replace('@c.us', '')} es un proveedor. No se reactiva el bot.`);
                userStates.set(userId, { state: 'waiting_human', waiting_human_mode: 'advisor', is_provider: true });
                return;
            }

            if (isMenuSelection || isCodeRequest || (detection && solvableIntents.includes(detection.intent))) {
                console.log(`[BOT MUTE REACTIVATE IMMEDIATE] Reactivando bot para @${userId} por intención resoluble.`);
                userStates.delete(userId);
                currentState = undefined;
                isSolvable = true;
            }
        } catch (err) {
            console.error("Error en reactivación inmediata por intenciones:", err.message);
        }

        if (!isSolvable) {
            const lastInteraction = (currentStateData && currentStateData.lastHumanInteraction) || 0;
            const timeSinceLastHumanMs = lastInteraction ? (Date.now() - lastInteraction) : Infinity;
            const minutesSinceLastHuman = timeSinceLastHumanMs / (1000 * 60);

            let isAdvisorExpired = false;
            if (minutesSinceLastHuman > 120) {
                console.log(`[BOT MUTE EXPIRE] El asesor no ha interactuado en ${minutesSinceLastHuman.toFixed(1)} minutos con @${userId}. Expirando modo advisor.`);
                isAdvisorExpired = true;
            }

            // Reactivación rápida explícita para ambos modos o si el modo advisor expiró
            if (cleanInput === 'menu' || cleanInput === 'menú' || cleanInput.includes('@bot') || isAdvisorExpired) {
                console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} (expirado o explícito).`);
                userStates.delete(userId);
                currentState = undefined;
            } else {
                // BYPASS INTELIGENTE: Si el usuario pide un código de verificación/2FA o sus credenciales, lo asistimos automáticamente
                const txt = (message.body || "").toLowerCase();
                const salesInquiryKeywords = ['interesa', 'precio', 'cuanto', 'cuánto', 'vale', 'cuesta', 'como funciona', 'cómo funciona', 'se cae', 'tengo que estar', 'comprar', 'dudas', 'informacion', 'información'];
                const isSalesQuestion = salesInquiryKeywords.some(kw => txt.includes(kw));
                const codeActionKeywords = ['dame el codigo', 'dame codigo', 'dame el código', 'necesito el codigo', 'necesito el código', 'mandame el codigo', 'mi codigo', 'codigo porfa', 'el codigo', 'sacar codigo', 'solicito codigo'];
                const isExplicitCodeAction = codeActionKeywords.some(kw => txt.includes(kw));
                const isShortCodeMsg = txt.split(/\s+/).length <= 4 && (txt.includes('codigo') || txt.includes('código') || txt.includes('2fa') || txt.includes('verificacion') || txt.includes('verificación'));

                const isCodeRequest = !isSalesQuestion && (isExplicitCodeAction || isShortCodeMsg);
                const isCredentialsRequest = (detection && detection.intent === 'credenciales') || cleanInput === '2' || txt.includes('credenciales') || txt.includes('datos de acceso') || txt.includes('mis datos');

                if (isCredentialsRequest || isCodeRequest) {
                    console.log(`[Bypass Waiting Human] 🔑 El usuario @${userId.replace('@c.us', '')} pidió credenciales/código. Procesando de forma automática.`);
                    const { processCheckCredentials } = require('./billingService');
                    await processCheckCredentials(userId, client, message.body, "", userStates);
                    return;
                }

                // HILO ACTIVO CON ASESOR: Si el asesor interactuó hace menos de 15 minutos, SILENCIO ABSOLUTO.
                // Permite conversaciones fluidas como "Si señor" -> sin interrupciones del bot.
                if (minutesSinceLastHuman <= 15) {
                    console.log(`[BOT MUTE ACTIVE THREAD] Asesor interactuó hace ${minutesSinceLastHuman.toFixed(1)} mins con @${userId}. Manteniendo silencio absoluto por hilo activo con asesor.`);
                    return;
                }

                // HILO ABANDONADO / EN ESPERA (> 15 MINUTOS SIN RESPUESTA DEL ASESOR):
                // Si pasaron más de 15 min desde que el asesor habló y el cliente vuelve a escribir, le damos aviso de turno en cola.
                const lastWarning = (currentStateData && currentStateData.lastWarningTime) || 0;
                const isClosingMsg = detection && detection.intent === 'cierre';
                if (!isClosingMsg && (Date.now() - lastWarning > 15 * 60 * 1000)) {
                    const { getQueuePosition } = require('./supportScheduleService');
                    const queuePos = getQueuePosition(userId, userStates);
                    if (queuePos) {
                        await safeReply(message, `🤖 Hola, lamentamos la demora. Tu caso sigue en proceso de atención por soporte.\n\n📌 *Tu turno actual en la cola:* #${queuePos}.\n\nUn asesor te atenderá a la brevedad. ¡Gracias por tu paciencia! 😊`, userId);
                    } else {
                        await safeReply(message, `🤖 Hola, lamentamos la demora. Tu caso sigue en proceso de atención por soporte. Un asesor te atenderá a la brevedad. ¡Gracias por tu paciencia! 😊`, userId);
                    }
                    userStates.set(userId, {
                        ...currentStateData,
                        lastWarningTime: Date.now()
                    });
                }
                return;
            }
        }
    }

    // Log de procesamiento movido arriba


    // --- Cobros parser: mensaje especial flexible ---
    const isManualChargesCommand = message.body && (
        message.body.toLowerCase().startsWith('@bot porfa haz los cobros para hoy de:') ||
        message.body.toLowerCase().startsWith('@bot cobra estos:') ||
        message.body.toLowerCase().startsWith('@bot cobra estos') ||
        message.body.toLowerCase().startsWith('@bot haz los cobros de:')
    );
    if (isManualChargesCommand) {
        // Usar originalChatJid (el JID del chat del grupo o el chat directo) para evitar discrepancias con userId (el emisor)
        await handleCobrosParser(message, originalChatJid, userStates, pendingConfirmations);
        return;
    }

    // --- Cobros automáticos: mensaje especial ---
    const checkCobros = message.body ? message.body.toLowerCase().trim() : '';
    const isAutoCobrosCommand = checkCobros === '@bot cobros automáticos' || 
        checkCobros === '@bot cobros automaticos' ||
        checkCobros === '@bot haz los cobros' ||
        checkCobros === '@bot porfa haz los cobros' ||
        checkCobros === '@bot inicia cobranza' ||
        checkCobros === '@bot cobros' ||
        checkCobros === '@bot pasa los recibos' ||
        checkCobros === '@bot manda avisos';

    if (isAutoCobrosCommand) {
        await handleAutoCobros(message, userId, userStates, pendingConfirmations, client);
        return;
    }


    /**
     * Procesa el resultado de un comando administrativo (Dashboard)
     */
    async function handleAdminResultLogic(data, userId, userStates, message, isAwaitingAdminConfirm, adminState) {
        console.log(`[Admin Dashboard DEBUG] handleAdminResultLogic: status=${data.status}, userId=${userId}, isAwaitingConfirm=${!!isAwaitingAdminConfirm}, hasState=${!!adminState}, state=${adminState ? adminState.state : 'none'}`);

        if (!adminState || (adminState.state !== 'awaiting_admin_broadcast_confirmation' && adminState.state !== 'awaiting_admin_suggestion_selection')) {
            // Intento de recuperación: Si no hay estado en el ID actual, buscar en el ID del admin directo
            const contact = await message.getContact();
            if (contact && contact.number) {
                const adminId = contact.number + '@c.us';
                const recoveredState = userStates.get(adminId);
                if (recoveredState && (recoveredState.state === 'awaiting_admin_broadcast_confirmation' || recoveredState.state === 'awaiting_admin_suggestion_selection')) {
                    console.log(`[Admin Dashboard] Recuperado estado desde ID de admin: ${adminId}`);
                    adminState = recoveredState;
                    isAwaitingAdminConfirm = adminState.state === 'awaiting_admin_broadcast_confirmation';
                }
            }
        }

        console.log(`[Admin Dashboard DEBUG AFTER RECOVERY] userId=${userId}, isAwaitingConfirm=${!!isAwaitingAdminConfirm}, state=${adminState ? adminState.state : 'none'}`);

        if (data.status === 'pending_confirmation') {
            userStates.set(userId, { state: 'awaiting_admin_broadcast_confirmation', payload: data, timestamp: Date.now() });
        } else if (data.status === 'suggestion') {
            userStates.set(userId, {
                state: 'awaiting_admin_suggestion_selection',
                originalFilters: data.originalFilters,
                payload: { options: data.options }, // Guardamos las opciones para el "si"
                timestamp: Date.now()
            });
        } else if (data.status === 'ready_to_confirm') {
            if (isAwaitingAdminConfirm && adminState.payload) {
                const payload = adminState.payload;

                // Si es un envío masivo de credenciales, reseteamos contadores de GPT
                if (payload.action_type === 'broadcast') {
                    try {
                        const { resetAllUsage } = require('./totpService');
                        resetAllUsage();
                    } catch (e) { console.error("Error reseteando uso GPT:", e.message); }
                }

                if (payload.count > 5) {
                    try {
                        await client.sendMessage(userId, `🚀 *Iniciando envío masivo...* (${payload.count} destinatarios)`);
                    } catch (e) { console.error('Error enviando mensaje inicio masivo:', e.message); }
                }

                let exitosos = 0;
                for (const r of payload.recipients) {
                    const telRaw = (r.tel || r.phone || '').toString().replace(/\D/g, '');
                    if (telRaw.length < 8) {
                        console.warn(`[Admin Broadcast] Saltando destinatario ${r.nombre} por falta de número válido.`);
                        continue;
                    }
                    // Formateo robusto (respeta códigos internacionales)
                    let cleanNumber = telRaw;
                    if (!cleanNumber.startsWith('57') && cleanNumber.length === 10) {
                        cleanNumber = '57' + cleanNumber;
                    }
                    const targetUser = `${cleanNumber}@c.us`;

                    const only = (payload.only_fields || []).map(f => f.toLowerCase());
                    const showAll = only.length === 0;
                    const platformLower = (payload.platform || "").toLowerCase();
                    const isSharedPlatform = platformLower.includes('spotify') ||
                        platformLower.includes('youtube') ||
                        platformLower.includes('microsoft') ||
                        platformLower.includes('office') ||
                        platformLower.includes('apple') ||
                        platformLower.includes('extra');

                    // Detección flexible de campos
                    const wantClave = only.some(f => f.includes('clave') || f.includes('password') || f.includes('contraseña'));
                    const wantPin = only.some(f => f.includes('pin'));
                    const wantPerfil = only.some(f => f.includes('perfil'));
                    const wantVencimiento = only.some(f => f.includes('vencimiento') || f.includes('fecha') || f.includes('deben'));

                    const isClave = r.is_owner || (showAll && !isSharedPlatform) || wantClave;
                    const isPinPerfil = !r.is_owner && (showAll || (wantPin && wantPerfil) || only.some(f => f.includes('pin perfil') || f.includes('pin de perfil')));
                    const isPinOnly = !isPinPerfil && !r.is_owner && wantPin;
                    const isPerfilOnly = !isPinPerfil && !r.is_owner && wantPerfil;
                    const isVencimiento = showAll || wantVencimiento;

                    // --- NUEVO: OCULTAR CREDENCIALES A EXTRAS O VENCIDOS ---
                    const isExtra = r.streaming && r.streaming.toLowerCase().includes('extra');
                    const { getTodayInBogota, getJsDateFromExcel } = require('./apiService');
                    const expDate = r.vencimiento ? getJsDateFromExcel(r.vencimiento) : null;
                    const isExpired = expDate && expDate < getTodayInBogota();

                    const shouldHide = isExtra || isExpired;
                    const hideReason = isExtra ? "[Exclusivo Cuenta Principal]" : "[Oculto por falta de pago]";

                    const finalClave = shouldHide ? hideReason : (payload.new_password && payload.new_password !== 'La actual' ? payload.new_password : (r.password || payload.new_password));
                    const finalPin = shouldHide ? hideReason : r.pin_perfil;

                    const pinPerfilLine = (r.pin_perfil && isPinPerfil) ? `\n📍 *Pin Perfil:* ${finalPin}` : "";
                    const pinLine = (r.pin_perfil && isPinOnly) ? `\n📌 *Pin:* ${finalPin}` : "";
                    const perfilLine = (r.pin_perfil && isPerfilOnly) ? `\n👤 *Perfil:* ${finalPin}` : "";
                    const claveLine = (finalClave && isClave) ? `\n🔑 *Clave:* ${finalClave}` : "";

                    let vencimientoLine = "";
                    if (isVencimiento && r.vencimiento) {
                        try {
                            const { getJsDateFromExcel } = require('./apiService');
                            const jsDate = getJsDateFromExcel(r.vencimiento);
                            const day = jsDate.getDate();
                            const monthMatch = jsDate.toLocaleDateString('es-ES', { month: 'long' });
                            const month = monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1);
                            vencimientoLine = `\n📅 *Vence:* ${day} de ${month}`;
                        } catch (e) {
                            vencimientoLine = `\n📅 *Vence:* ${r.vencimiento}`;
                        }
                    }

                    let title = "ACTUALIZACIÓN DE CREDENCIALES";
                    if (!showAll && only.length === 1) {
                        if (isPinPerfil) title = "ACTUALIZACIÓN DE PIN PERFIL";
                        if (isClave) title = "ACTUALIZACIÓN DE CLAVE";
                    }

                    const displayEmail = r.account_email || (isSharedPlatform ? (r.customer_mail || payload.target_account) : (payload.target_account || r.customer_mail));

                    let msg = payload.is_prerendered
                        ? (r.pin_perfil || payload.custom_message)
                        : (payload.custom_message
                            ? `🚨 *NOTIFICACIÓN DE SHEERIT*\n\n${payload.custom_message}\n\n📧 *Cuenta:* ${displayEmail}${claveLine}${pinPerfilLine}${pinLine}${perfilLine}${vencimientoLine}`
                            : `🚨 *${title}*\n\nHola 👋, te contactamos de Sheerit para informarte que los datos de acceso de tu cuenta de *${payload.platform}* han sido actualizados.\n\n📧 *Cuenta:* ${displayEmail}${claveLine}${pinPerfilLine}${pinLine}${perfilLine}${vencimientoLine}\n\nSi tienes inconvenientes, acude a nuestro soporte o escribe "ayuda". ¡Gracias por confiar en nosotros!`);
                    try {
                        await client.sendMessage(targetUser, msg);
                        exitosos++;
                        await new Promise(res => setTimeout(res, 500));
                    } catch (e) { console.error(`[Admin Broadcast] Error enviando a ${targetUser}:`, e.message); }
                }
                try {
                    await client.sendMessage(userId, `✅ *Envío completado exitosamente.*\n- Total: ${payload.count}\n- Enviados: ${exitosos}`);
                    userStates.delete(userId);
                } catch (e) { console.error('Error enviando mensaje completado:', e.message); }
            } else {
                try {
                    console.log(`[Admin State DEBUG] No se halló estado para ${userId}. Contenido de userStates:`, Array.from(userStates.keys()));
                    await client.sendMessage(userId, "❌ No tengo ninguna acción pendiente para confirmar.");
                } catch (e) { console.error('Error respondiendo acción pendiente:', e.message); }
            }
        } else if (data.status === 'success' || data.status === 'error' || data.status === 'warning') {
            // Ya se envió un reporte detallado en processAdminQuery, no duplicamos.
            return;
        } else {
            const { generateAdminReport } = require('./aiService');
            const report = await generateAdminReport(message.body, data);
            await client.sendMessage(userId, report);
        }
    }

    // Comandos de operador/administrador
    if (message.from === OPERATOR_NUMBER || message.from === GROUP_ID) {
        const adminState = userStates.get(message.from) || {};
        const bodyLower = (message.body || '').trim().toLowerCase();

        // Activar simulación (solo desde chat privado con el bot para evitar ruidos en grupos)
        if (bodyLower.includes('@bot simula cliente') && message.from === OPERATOR_NUMBER) {
            userStates.set(message.from, { ...adminState, state: 'simulating_client', simulationCount: 6 }); // 6 para que el primer mensaje cuente
            await message.reply("🎭 *MODO SIMULACIÓN ACTIVADO*\n\nA partir de ahora, te trataré como si fueras un cliente nuevo. El bot responderá a tus mensajes sin necesidad de usar @bot.\n\n_Este modo durará 5 mensajes o hasta que digas '@bot detener'._ 🤖");
            return;
        } else if (bodyLower.includes('@bot codigos')) {
            const { findRecentCodes } = require('./gmailService');
            const codes = await findRecentCodes('jordimemesmomazosdick@gmail.com', 10);
            if (codes.length === 0) {
                await message.reply("🤖 No encontré códigos recientes en los últimos 10 minutos.");
            } else {
                let reply = "🤖 *CÓDIGOS RECIENTES (GMAIL)*:\n\n";
                codes.forEach(c => {
                    reply += `📧 *${c.subject}*\n🔢 *Código:* ${c.code || 'Ver snippet'}\n📝 ${c.snippet}...\n⏰ Hace ${c.time} min\n\n`;
                });
                await message.reply(reply);
            }
            return;
        } else if (bodyLower.includes('@bot pendientes')) {
            const { getPendientesReport } = require('./adminService');
            const report = await getPendientesReport(userStates);
            await message.reply(report);
            return;
        } else if (bodyLower.includes('@bot cola') || bodyLower.includes('@bot soporte')) {
            if (!global.supportQueue || global.supportQueue.length === 0) {
                await message.reply("📋 *COLA DE ESPERA*\n\nActualmente no hay usuarios en cola de espera (0 pendientes).");
            } else {
                let reply = `📋 *COLA DE ESPERA (${global.supportQueue.length} casos):*\n\n`;
                for (let i = 0; i < global.supportQueue.length; i++) {
                    const qId = global.supportQueue[i];
                    const st = userStates.get(qId) || {};
                    const name = st.nombre || "Cliente";
                    reply += `${i + 1}. ${name} - Tel: +${qId.replace('@c.us', '')}\n`;
                }
                reply += "\n_Nota: Los clientes que envían nuevos mensajes se mueven automáticamente al final de esta lista._";
                await message.reply(reply);
            }
            return;
        }

        if (bodyLower === '@bot stats') {
            const stats = {
                totalStates: userStates.size,
                states: Array.from(userStates.entries()).map(([k, v]) => `${k}: ${v.state}`),
                queues: messageQueues.size
            };
            await message.reply(`📊 *ESTADÍSTICAS DEL SISTEMA*\n\n- Estados en memoria: ${stats.totalStates}\n- Colas activas: ${stats.queues}\n\n*Estados:* \n${stats.states.slice(-10).join('\n')}`);
            return;
        }

        // COMANDO DE PRUEBA DE ESCRITURA
        if (bodyLower.startsWith('@bot test de numero')) {
            const parts = message.body.split(' ');
            const targetRow = parts[4];
            const testNum = parts[5] || "123456789";

            if (!targetRow) {
                await message.reply("❌ Uso: @bot test de numero [fila] [numero]");
                return;
            }

            await message.reply(`🧪 Iniciando diagnóstico profundo en fila ${targetRow}...`);
            try {
                const { updateExcelData, fetchRawData } = require('./apiService');

                // Forzamos lectura para ver encabezados reales en consola
                const rawData = await fetchRawData();
                if (rawData && rawData.length > 0) {
                    console.log(`[TEST DEBUG] Encabezados detectados en este momento:`, Object.keys(rawData[0]).map(k => `[${k}]`).join(', '));
                }

                const alphabet = "ABCDEFGHIJKLMNOPQRST".split("");
                const bombUpdates = {};
                const numericTest = parseInt(testNum.replace(/\D/g, '')) || 0;

                alphabet.forEach((letter, index) => {
                    // Por defecto texto
                    bombUpdates[letter] = `TEST_${letter}_${index}`;
                });

                // CASOS ESPECIALES DE TIPO DE DATO
                bombUpdates["E"] = numericTest;           // Columna E como NÚMERO puro
                bombUpdates["F"] = `'${testNum}`;         // Columna F con COMILLA (Texto)
                bombUpdates["G"] = parseFloat(testNum);   // Columna G como FLOAT

                bombUpdates["numero"] = testNum;          // Como texto
                bombUpdates["Numero"] = numericTest;      // Como número
                bombUpdates["whatsapp"] = testNum;
                bombUpdates["observaciones"] = "BOMBARDEO TIPOS " + new Date().toLocaleTimeString();

                await message.reply(`💣 Iniciando bombardeo de tipos de datos en fila ${targetRow}...`);

                const res = await updateExcelData(parseInt(targetRow), bombUpdates);
                await message.reply(`✅ Bombardeo de tipos completado. Revisa el resultado: ${JSON.stringify(res, null, 2)}`);
            } catch (err) {
                await message.reply(`❌ Error en el diagnóstico: ${err.message}`);
            }
            return;
        }

        // Interceptor de Simulación
        if (adminState.state === 'simulating_client' && message.from === OPERATOR_NUMBER) {
            if (bodyLower.includes('@bot detener')) {
                userStates.set(message.from, { ...adminState, state: 'main_menu', simulationCount: 0 });
                await message.reply("🎭 *MODO SIMULACIÓN DESACTIVADO* 🤖");
                return;
            }

            const newCount = (adminState.simulationCount || 1) - 1;
            if (newCount <= 0) {
                userStates.set(message.from, { ...adminState, state: 'main_menu', simulationCount: 0 });
                console.log(`[Simulación] Finalizada para ${message.from}`);
            } else {
                userStates.set(message.from, { ...adminState, simulationCount: newCount });
                console.log(`[Simulación] Procesando mensaje de admin como cliente (${newCount} restantes)`);
                await processIncomingMessage(message);
                return;
            }
        }

        const body = (message.body || '').trim().toLowerCase();

        if (body === '!liberar masivo' || body === 'liberar masivo') {
            let count = 0;
            for (const [key, val] of userStates.entries()) {
                let stateStr = typeof val === 'object' ? val.state : val;
                if (stateStr === 'waiting_human') {
                    userStates.delete(key);
                    count++;
                }
            }
            await message.reply(`✅ *Liberación masiva completada!*\nSe reactivó el bot para ${count} clientes que estaban en espera.`);
            return;
        }

        if (body.startsWith('!bot') || body.startsWith('!liberar') || body.startsWith('liberar ')) {
            let targetPhone = body.replace('!bot', '').replace('!liberar', '').replace('liberar', '').trim().replace(/\D/g, '');
            if (!targetPhone && !message.from.includes('@g.us')) {
                targetPhone = userId.replace(/\D/g, '');
            }

            if (targetPhone) {
                const targetId = targetPhone + '@c.us';
                userStates.delete(targetId);
                await client.sendMessage(targetId, '🤖 *BOT REACTIVADO*: Un asesor me ha pedido retomar la atención automática. ¿En qué puedo ayudarte?');
                await message.reply(`✅ Bot reactivado para ${targetPhone}`);
            } else {
                await message.reply('❌ Por favor especifica el número (ej: !bot 57311...)');
            }
            return;
        }

        if (body.toLowerCase().startsWith('confirmar_cobros ')) {
            const phone = body.split(' ')[1].replace(/\D/g, '');
            const targetId = phone + '@c.us';
            if (pendingConfirmations.has(targetId)) {
                const records = pendingConfirmations.get(targetId);
                const fs = require('fs');
                const path = require('path');
                const file = path.join(__dirname, 'pending_charges.json');
                let existing = [];
                try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
                const entry = { requester: targetId, records, timestamp: new Date().toISOString() };
                existing.push(entry);
                fs.writeFileSync(file, JSON.stringify(existing, null, 2));
                for (const r of records) {
                    const dest = r.phone + '@c.us';
                    await client.sendMessage(dest, `Se ha generado un cobro para *${r.name}* solicitado por ${targetId}. Por favor, responde si este pago fue procesado.`);
                }
                pendingConfirmations.delete(targetId);
                await message.reply('Cobros confirmados y enviados.');
            } else {
                await message.reply('No encontré cobros pendientes para ese usuario.');
            }
        }
    }

    // Comandos de Grupo / Admin
    const isBotCommand = (message.from === GROUP_ID || isFromAdmin) && message.body && message.body.toLowerCase().startsWith('@bot');
    const isReplyConfirmation = message.from === GROUP_ID && message.hasQuotedMsg && (
        ['si', 'ya', 'listo', 'confirmado', 'vale', 'ok', 'claro'].includes(message.body.toLowerCase().trim()) ||
        message.body.toLowerCase().includes('confirmar') ||
        message.body.toLowerCase().includes('si me llego')
    );

    if (isBotCommand || isReplyConfirmation) {
        const { detectAdminIntent } = require('./aiService');
        const adminAI = await detectAdminIntent(message.body);
        console.log(`[Admin AI] Intención detectada: ${adminAI.intent} para ${adminAI.target_user || adminAI.target}`);

        if (adminAI.intent === 'dormir_bot') {
            globalBotSleep = true;
            await message.reply('😴 Modo dormido activado, jefe.');
            return;
        } else if (adminAI.intent === 'despertar_bot') {
            globalBotSleep = false;
            await message.reply('😃 ¡He despertado, jefe! Vuelvo a atender a los clientes.');
            return;
        } else if (adminAI.intent === 'liberar_bot') {
            const { handleBatchUnanswered } = require('./adminService');
            if (message.body.toLowerCase().includes('masivo') || message.body.toLowerCase().includes('pendientes')) {
                await handleBatchUnanswered(message, client, userStates, processIncomingMessage);
            } else {
                // Liberar a uno solo
                let targetPhone = (adminAI.target_user || adminAI.target) ? (adminAI.target_user || adminAI.target).replace(/\D/g, '') : null;
                let targetId = targetPhone ? targetPhone + '@c.us' : (isFromAdmin && !message.from.includes('@g.us') ? message.to : null);

                if (targetId) {
                    userStates.delete(targetId);
                    await client.sendMessage(targetId, '🤖 *BOT REACTIVADO*: Un asesor me ha pedido retomar la atención automática. ¿En qué puedo ayudarte?');
                    await message.reply(`✅ Bot reactivado para ${targetId.replace('@c.us', '')}`);
                } else {
                    await message.reply('❌ No pude saber a quién liberar, jefe.');
                }
            }
            return;
        } else if (adminAI.intent === 'enviar_credenciales') {
            const targetPlat = adminAI.target_platform || 'Amazon';
            const targetEmail = adminAI.target_email || (adminAI.target_user && adminAI.target_user.includes('@') ? adminAI.target_user : null);
            const targetPhone = adminAI.target_user && !adminAI.target_user.includes('@') ? adminAI.target_user.replace(/\D/g, '') : null;

            try {
                const { fetchRawData } = require('./apiService');
                const allRows = await fetchRawData(3, 2500, true);
                
                let targetRow = null;
                if (targetEmail) {
                    targetRow = allRows.find(r => {
                        const m = (r.correo || r.Correo || r['customer mail'] || r['Customer Mail'] || '').toString().toLowerCase().trim();
                        const s = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                        return (m === targetEmail.toLowerCase() || m.includes(targetEmail.toLowerCase())) && s.includes(targetPlat.toLowerCase());
                    });
                }
                
                if (!targetRow) {
                    targetRow = allRows.find(r => {
                        const s = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                        const w = (r.whatsapp || '').toString().trim();
                        const n = (r.Nombre || r.nombre || '').toString().toLowerCase().trim();
                        return s.includes(targetPlat.toLowerCase()) && (!w || w.length < 5) && (!n || n === 'libre');
                    });
                }

                if (targetRow) {
                    const { getMaskedAccessData } = require('./aiService');
                    const masked = getMaskedAccessData(targetRow);
                    const pinLine = targetRow.pin ? `\n📌 PIN: \`${targetRow.pin}\`` : '';
                    const vencStr = targetRow.vencimiento ? `\n📅 Vence: *${targetRow.vencimiento}*` : '';
                    
                    const credMsg = `🤖 ¡Hola! Un asesor de nuestro equipo te envía las credenciales de acceso de *${masked.streamingName || targetPlat.toUpperCase()}*:\n\n` +
                        `📺 *Plataforma:* ${masked.streamingName || targetPlat.toUpperCase()}\n` +
                        `📧 *Usuario:* \`${masked.correo || targetRow.correo}\`\n` +
                        `🔑 *Contraseña:* \`${masked.clave || targetRow.clave || targetRow.password}\`${pinLine}${vencStr}\n\n` +
                        `¡Que disfrutes tu servicio! 😊`;

                    let sent = false;
                    if (targetPhone) {
                        const targetJid = targetPhone.includes('@') ? targetPhone : (targetPhone.length === 10 ? '57' + targetPhone + '@c.us' : targetPhone + '@c.us');
                        await client.sendMessage(targetJid, credMsg);
                        sent = true;
                    } else if (targetEmail) {
                        const custRow = allRows.find(r => (r.correo || r['customer mail'] || '').toString().toLowerCase().includes(targetEmail.toLowerCase()) && (r.whatsapp || r.numero));
                        if (custRow && (custRow.whatsapp || custRow.numero)) {
                            const p = (custRow.whatsapp || custRow.numero).replace(/\D/g, '');
                            const jid = p.length === 10 ? '57' + p + '@c.us' : p + '@c.us';
                            await client.sendMessage(jid, credMsg);
                            sent = true;
                        }
                    }

                    const destDesc = targetEmail || targetPhone || "destinatario";
                    if (sent) {
                        await message.reply(`✅ Credenciales de *${targetPlat.toUpperCase()}* enviadas con éxito a *${destDesc}* 🚀\n\n📧 Cuenta: \`${targetRow.correo}\``);
                    } else {
                        await message.reply(`✅ Credenciales de *${targetPlat.toUpperCase()}* localizadas para *${destDesc}*:\n\n📧 Correo: \`${targetRow.correo}\`\n🔑 Clave: \`${targetRow.clave || targetRow.password}\`${pinLine}`);
                    }
                } else {
                    await message.reply(`⚠️ No encontré una cuenta libre o registrada de *${targetPlat}* para *${targetEmail || targetPhone || 'ese destino'}*.`);
                }
            } catch (err) {
                console.error("Error en enviar_credenciales admin:", err);
                await message.reply(`❌ Ocurrió un error al procesar el envío de credenciales: ${err.message}`);
            }
            return;
        } else if (adminAI.intent === 'dame_cuenta') {
            const { handleAdminForceRetrieve } = require('./adminService');
            await handleAdminForceRetrieve(message, adminAI.target_platform || adminAI.target_user || message.body, client, adminAI.target_user);
            return;
        } else if (adminAI.intent === 'confirmar_pago' || isReplyConfirmation) {
            const { handleAdminPaymentConfirmation } = require('./adminService');
            let targetPhone = adminAI.target_user ? adminAI.target_user.replace(/\D/g, '') : null;

            // Fallback manual si la IA no detectó el número pero está en el texto (soporta LIDs de 14 dígitos y celulares de 10-12 dígitos)
            if (!targetPhone) {
                const regex = /6\d{13}|9\d{13}|57\s*3\d{2}\s*\d{7}|3\d{9}/;
                const match = message.body.match(regex);
                if (match) targetPhone = match[0].replace(/\s+/g, '');
            }

            let targetId = null;
            if (targetPhone) {
                if (targetPhone.includes('@')) {
                    targetId = targetPhone;
                } else if (targetPhone.length > 12) {
                    // Es un LID
                    targetId = targetPhone + '@lid';
                    if (!userStates.has(targetId)) {
                        const matchingKey = Array.from(userStates.keys()).find(k => k.includes(targetPhone));
                        if (matchingKey) targetId = matchingKey;
                    }
                } else {
                    targetId = (targetPhone.length === 10 ? '57' + targetPhone : targetPhone) + '@c.us';
                }
            }

            // Prioridad: 1. Quoted Message, 2. Target Phone, 3. globalLastPaymentUserId
            if (isReplyConfirmation) {
                const quotedMsg = await message.getQuotedMessage();
                const phoneRegex = /(6\d{13})|(9\d{13})|(57\d{10})|(\d{10})/;
                const match = quotedMsg.body.match(phoneRegex);
                if (match) {
                    let num = match[0];
                    if (num.length > 12) {
                        targetId = num + '@lid';
                    } else {
                        if (num.length === 10) num = '57' + num;
                        targetId = num + '@c.us';
                    }
                } else if (quotedMsg.from !== client.info.wid._serialized) {
                    targetId = quotedMsg.from;
                }
            }

            if (!targetId && globalLastPaymentUserId) {
                console.log(`[Admin Logic] No se halló ID en comando, usando memoria global: ${globalLastPaymentUserId}`);
                targetId = globalLastPaymentUserId;
            }

            if (targetId) {
                const cmd = adminAI.months ? `confirmar ${adminAI.months} meses` : "confirmar";
                await handleAdminPaymentConfirmation(message, cmd, client, userStates, targetId);
            } else {
                await message.reply('❌ No pude identificar al cliente para confirmar el pago, jefe. Intenta poniendo el número o respondiendo al reporte del cliente.');
            }
            return;
        } else if (adminAI.intent === 'programar_mensaje') {
            let recipients = [];
            const isCredentialsRequest = message.body.toLowerCase().includes('credenciales') ||
                message.body.toLowerCase().includes('cuenta');

            const isPinOnlyRequest = message.body.toLowerCase().includes('pin') &&
                (message.body.toLowerCase().includes('unicamente') ||
                    message.body.toLowerCase().includes('únicamente') ||
                    message.body.toLowerCase().includes('solo') ||
                    message.body.toLowerCase().includes('solamente'));

            // Intentar detectar lista de destinatarios (Nombre + Teléfono) en el cuerpo del mensaje
            const lines = message.body.split('\n');
            const parsedRecipients = [];
            const otherLines = [];

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Expresión regular para detectar un Nombre seguido de un Teléfono de 10 a 20 caracteres (dígitos, espacios, etc)
                // Ejemplo: Wilson Garcia  57 313 3495828
                const match = trimmed.match(/^([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+)\s+([\d\s+-]{10,20})$/);
                if (match) {
                    const name = match[1].trim();
                    const phone = match[2].replace(/\D/g, '');
                    if (phone.length >= 10 && phone.length <= 15) {
                        parsedRecipients.push({ name, phone });
                        continue;
                    }
                }
                otherLines.push(line);
            }

            if (parsedRecipients.length > 0) {
                const otherText = otherLines.join('\n');
                const quoteMatch = otherText.match(/[“"«]([^”"»]+)[”"»]/s);
                let msgToSend = '';
                if (quoteMatch) {
                    msgToSend = quoteMatch[1].trim();
                } else {
                    msgToSend = otherText
                        .replace(/@bot\s+envia\s+un\s+mensaje\s+a\s+estos\s+destinatarios\s+diciendo/gi, '')
                        .replace(/@bot\s+envia\s+mensaje/gi, '')
                        .trim();
                    msgToSend = msgToSend.replace(/^[“"«]/, '').replace(/[”"»]$/, '').trim();
                }

                parsedRecipients.forEach(rec => {
                    const targetId = rec.phone + '@c.us';
                    recipients.push({
                        targetId,
                        targetName: rec.name,
                        messageText: msgToSend
                    });
                });
            }

            if (recipients.length === 0) {

                // Caso A: El destinatario es una o varias cuentas de correo/plataformas (ej: sheerpremium@gmail.com, elizabetdiagama, sheerit6)
                let isEmailOrAccountTarget = false;
                let targetUserStr = (adminAI.target_user || '').toLowerCase().trim();
                let targetAccounts = targetUserStr.replace(/\by\b/g, ',').split(',').map(t => t.trim()).filter(t => t.length > 0);

                const { fetchRawData } = require('./apiService');
                let rawData = [];
                try {
                    rawData = await fetchRawData();
                } catch (err) {
                    console.error('Error fetching raw data for programar_mensaje:', err.message);
                }

                if (targetAccounts.length > 0 && rawData.length > 0) {
                    isEmailOrAccountTarget = targetAccounts.some(acc => {
                        if (acc.includes('@')) return true;
                        return rawData.some(row => {
                            const email = (row.correo || row.Correo || '').toString().toLowerCase();
                            return email.includes(acc) && acc.length >= 4;
                        });
                    });
                }

                if (isEmailOrAccountTarget) {
                    try {
                        const matchingRows = rawData.filter(row => {
                            const rowEmail = (row.correo || row.Correo || '').toString().toLowerCase().trim();
                            const rowPlat = (row.Streaming || row.streaming || '').toString().toLowerCase();
                            const platFilter = adminAI.target_platform ? adminAI.target_platform.toLowerCase().trim() : '';

                            const emailMatch = targetAccounts.some(acc => {
                                if (acc.includes('@') && acc.includes('.')) {
                                    return rowEmail === acc;
                                }
                                return rowEmail.includes(acc) && acc.length >= 4;
                            });
                            const platMatch = platFilter ? rowPlat.includes(platFilter) : true;
                            const hasPhone = row.numero || row.whatsapp;

                            const isExtra = rowPlat.includes('extra');
                            if (isCredentialsRequest && isExtra) return false;

                            return emailMatch && platMatch && hasPhone;
                        });

                        if (matchingRows.length === 0) {
                            await message.reply(`❌ Jefe, no encontré a ningún cliente asignado a las cuentas *${targetAccounts.join(', ')}* en el Excel.`);
                            return;
                        }

                        matchingRows.forEach(row => {
                            const tel = (row.numero || row.whatsapp).toString().replace(/\D/g, '');
                            const targetId = (tel.startsWith('57') ? tel : '57' + tel) + '@c.us';
                            const targetName = row.Nombre || row.nombre || 'Cliente';

                            let msgToSend = adminAI.message_text || '';
                            if (isPinOnlyRequest) {
                                const streamingName = (row.Streaming || 'Streaming').toUpperCase();
                                const pin = row['pin perfil'] || row['pin'] || 'Sin PIN';
                                msgToSend = `📍 *PIN / INVITACIÓN DE PERFIL ${streamingName}*\n\n${pin}`;
                            } else if (isCredentialsRequest || msgToSend.toLowerCase().includes('credenciales') || msgToSend.trim().length <= 5) {
                                const streamingName = (row.Streaming || 'Streaming').toUpperCase();
                                const pin = row['pin perfil'] || row['pin'] || '';
                                msgToSend = `🔐 *CREDENCIALES ${streamingName}*\n\n📧 Correo: ${row.correo}\n🔒 Clave: ${row.contraseña}${pin ? `\n🔢 PIN: ${pin}` : ''}`;
                            }

                            recipients.push({
                                targetId,
                                targetName,
                                messageText: msgToSend
                            });
                        });
                    } catch (err) {
                        console.error('Error buscando destinatarios por email:', err.message);
                        await message.reply(`❌ Error al consultar los clientes de esa cuenta en Excel: ${err.message}`);
                        return;
                    }
                } else {
                    // Caso B: Destinatario único (nombre, teléfono o "este cliente")
                    let targetId = null;
                    let targetName = null;

                    if (adminAI.target_user === 'este cliente' || (!adminAI.target_user && !message.from.includes('@g.us'))) {
                        targetId = userId;
                        targetName = 'este cliente';
                    } else if (adminAI.target_user) {
                        const cleanTarget = adminAI.target_user.replace(/\D/g, '');
                        if (cleanTarget.length >= 8) {
                            targetId = (cleanTarget.startsWith('57') ? cleanTarget : '57' + cleanTarget) + '@c.us';
                            targetName = cleanTarget;
                        } else {
                            // Buscar por nombre
                            const { searchContactByName } = require('./googleContactsService');
                            let foundPhone = await searchContactByName(adminAI.target_user);

                            if (!foundPhone) {
                                const { fetchRawData } = require('./apiService');
                                try {
                                    const rawData = await fetchRawData();
                                    const userRow = rawData.find(r => {
                                        const rowName = (r.Nombre || r['Nombre Completo'] || "").toString().toLowerCase();
                                        return rowName.includes(adminAI.target_user.toLowerCase());
                                    });
                                    if (userRow && userRow.numero) {
                                        const tel = userRow.numero.toString().replace(/\D/g, '');
                                        foundPhone = tel.startsWith('57') ? tel : '57' + tel;
                                    }
                                } catch (e) {
                                    console.error('Error buscando nombre en Excel para programar:', e.message);
                                }
                            }

                            if (foundPhone) {
                                targetId = foundPhone.includes('@') ? foundPhone : foundPhone + '@c.us';
                                targetName = adminAI.target_user;
                            }
                        }
                    }

                    if (!targetId) {
                        await message.reply('❌ Jefe, no pude identificar al cliente al que deseas enviarle el mensaje. Por favor especifica su nombre o número.');
                        return;
                    }

                    // Generar credenciales si fue solicitado
                    let msgToSend = adminAI.message_text || '';
                    if (isPinOnlyRequest) {
                        const { getAccountsByPhone } = require('./apiService');
                        try {
                            const phoneNumber = targetId.replace('@c.us', '').replace(/\D/g, '');
                            const userAccounts = await getAccountsByPhone(phoneNumber);
                            const platFilter = adminAI.target_platform || '';
                            const targetAccount = userAccounts.find(a => (a.Streaming || '').toLowerCase().includes(platFilter.toLowerCase()));
                            if (targetAccount) {
                                const streamingName = (targetAccount.Streaming || 'Streaming').toUpperCase();
                                const pin = targetAccount['pin perfil'] || targetAccount['pin'] || 'Sin PIN';
                                msgToSend = `📍 *PIN / INVITACIÓN DE PERFIL ${streamingName}*\n\n${pin}`;
                            } else {
                                await message.reply(`❌ Jefe, no encontré ninguna cuenta de *${platFilter.toUpperCase() || 'Streaming'}* activa para el cliente.`);
                                return;
                            }
                        } catch (err) {
                            console.error('Error buscando PIN único para programar:', err.message);
                        }
                    } else if (isCredentialsRequest || msgToSend.toLowerCase().includes('credenciales') || msgToSend.trim().length <= 5) {
                        const { getAccountsByPhone } = require('./apiService');
                        const { formatDirectCredentials } = require('./aiService');
                        try {
                            const phoneNumber = targetId.replace('@c.us', '').replace(/\D/g, '');
                            const userAccounts = await getAccountsByPhone(phoneNumber, null, true);
                            const platFilter = adminAI.target_platform || '';

                            const formatted = formatDirectCredentials(userAccounts, platFilter);
                            if (formatted) {
                                msgToSend = formatted;
                            } else if (msgToSend.trim().length === 0) {
                                await message.reply(`❌ Jefe, no encontré ninguna cuenta activa de *${platFilter.toUpperCase() || 'Streaming'}* para el cliente.`);
                                return;
                            }
                        } catch (err) {
                            console.error('Error buscando credenciales para programar:', err.message);
                        }
                    }

                    if (!msgToSend || msgToSend.trim().length === 0) {
                        await message.reply('❌ Jefe, no detecté el contenido del mensaje que quieres enviar.');
                        return;
                    }

                    recipients.push({
                        targetId,
                        targetName,
                        messageText: msgToSend
                    });
                }
            }

            // 3. Procesar envíos (programados o con confirmación obligatoria previa)
            if (adminAI.scheduled_time) {
                const { scheduleNewMessage } = require('./scheduledMessageService');
                let successCount = 0;
                let lastFormattedTime = '';

                for (const rec of recipients) {
                    try {
                        const result = await scheduleNewMessage(client, rec.targetId, rec.messageText, adminAI.scheduled_time);
                        lastFormattedTime = result.formattedTime;
                        successCount++;
                    } catch (err) {
                        console.error(`Error programando a ${rec.targetId}:`, err.message);
                    }
                }

                if (successCount === 0) {
                    await message.reply('❌ Jefe, no se pudo programar el envío a ningún destinatario.');
                } else if (recipients.length === 1) {
                    await message.reply(`📅 *MENSAJE PROGRAMADO CON ÉXITO*\n\n👤 *Cliente:* ${recipients[0].targetName} (@${recipients[0].targetId.replace('@c.us', '')})\n🕒 *Envío:* ${lastFormattedTime}\n📝 *Mensaje:* "${recipients[0].messageText.substring(0, 100)}..."`);
                } else {
                    await message.reply(`📅 *DIFUSIÓN PROGRAMADA CON ÉXITO*\n\n📧 *Cuenta:* ${adminAI.target_user}\n👥 *Destinatarios:* ${successCount} clientes programados.\n🕒 *Envío:* ${lastFormattedTime}`);
                }
            } else {
                // ENVIOS INMEDIATOS: Pedir confirmación OBLIGATORIA al jefe para evitar desastres
                userStates.set(userId, {
                    state: 'awaiting_admin_broadcast_confirmation',
                    payload: {
                        status: 'pending_confirmation',
                        action_type: 'broadcast',
                        is_prerendered: true, // Indica que el mensaje ya está pre-renderizado y no debe alterarse
                        target_account: adminAI.target_user,
                        platform: adminAI.target_platform || 'Streaming',
                        new_password: '',
                        custom_message: recipients[0].messageText,
                        only_fields: isPinOnlyRequest ? ['pin perfil'] : [],
                        count: recipients.length,
                        recipients: recipients.map(r => ({
                            tel: r.targetId.replace('@c.us', ''),
                            nombre: r.targetName,
                            pin_perfil: r.messageText // Mensaje pre-renderizado individual
                        }))
                    },
                    timestamp: Date.now()
                });

                const preview = recipients[0].messageText;
                await message.reply(`📢 *PREPARANDO ENVÍO INMEDIATO DE DIFUSIÓN*\n\n📧 *Cuenta:* ${adminAI.target_user}\n👥 *Destinatarios:* ${recipients.length} clientes.\n\n📝 *Vista previa del mensaje a enviar:*\n---\n${preview}\n---\n\n¿Deseas proceder con el envío masivo inmediato a los ${recipients.length} clientes? Responde *sí* para confirmar o *no* para cancelar.`);
            }
            return;
        }

        // Fallback a lógica antigua para comandos específicos no manejados por IA
        let command = "";
        if (isBotCommand) {
            command = message.body.toLowerCase().replace('@bot', '').trim();
        }

        if (command.startsWith('autorizar')) {
            const parts = command.split(' ');
            if (parts.length < 3) {
                await message.reply('❌ Formato: @bot autorizar [contacts/gmail] [codigo] [email_opcional]');
            } else {
                const service = parts[1].toLowerCase();
                const code = parts[2];
                const email = parts[3] ? parts[3].toLowerCase().trim() : null;
                const { getOAuth2Client, clearCachedClient } = require('./googleAuthService');
                if (email) clearCachedClient(service, email);
                await message.reply(`⏳ Intentando autorizar servicio ${service}${email ? ' para ' + email : ''} con el código proporcionado...`);
                try {
                    const auth = await getOAuth2Client(service, code, email);
                    if (auth) {
                        await message.reply(`✅ Servicio ${service}${email ? ' (' + email + ')' : ''} autorizado y token guardado correctamente.`);
                    } else {
                        await message.reply(`❌ No se pudo autorizar el servicio ${service}. Revisa los logs.`);
                    }
                } catch (e) {
                    await message.reply(`❌ Error al autorizar: ${e.message}`);
                }
            }
            return;
        } else if (command === 'pruebas' || command === 'prueba de escritura') {
            const { executeTestMode } = require('./adminService');
            await executeTestMode(message, client);
            return;
        } else if (command === 'si, prueba de escritura' || command === 'sí, prueba de escritura') {
            await message.reply('🧪 Iniciando prueba de escritura verificada...');
            const { recordNewSale } = require('./salesRegistryService');
            const { fetchRawData } = require('./apiService');

            // Dummy state para forzar escritura en una fila de Netflix
            const dummyState = {
                nombre: "TEST_IA_VERIFICADO",
                items: [{ platform: { name: "Netflix" } }],
                subscriptionType: 'mensual'
            };

            // Intentar escribir
            const results = await recordNewSale(userId, dummyState, "TEST_VERIFICACION_API");

            if (results && results.some(r => r.status === 'success')) {
                const successMatch = results.find(r => r.status === 'success');
                const targetRow = successMatch.index;
                await message.reply(`⏳ Escritura enviada a la fila ${targetRow}. Verificando persistencia con la API de lectura...`);

                // Esperar un momento para que Azure procese el cambio
                await new Promise(r => setTimeout(r, 3000));

                // Volver a leer para confirmar
                const freshData = await fetchRawData();
                const verifiedRow = freshData[targetRow - 2]; // 0-indexed in array

                if (verifiedRow && (verifiedRow.Nombre === "TEST_IA_VERIFICADO" || verifiedRow.nombre === "TEST_IA_VERIFICADO")) {
                    await message.reply(`✅ *¡CONFIRMADO!*\nLa API de lectura detectó el cambio en la fila ${targetRow}. La comunicación Escritura -> Excel -> Lectura es 100% correcta.`);
                } else {
                    await message.reply(`⚠️ *AVISO*: La escritura se envió con éxito, pero la API de lectura aún no muestra el cambio (puede ser delay de sincronización de OneDrive). Por favor revisa el Excel manualmente en unos segundos.`);
                }
            } else {
                await message.reply(`❌ *FALLO EN PRUEBA*\nNo se encontró cupo disponible para probar o la API de Azure devolvió un error.`);
            }
            return;
        } else if (command.includes('confirmar') || command.includes('si me llego') || command.includes('si la recibi')) {
            await handleAdminPaymentConfirmation(message, command, client, userStates, null);
            return;
        } else if (command === '' || command === 'funciones' || command === 'comandos') {
            await showAdminFunctions(message);
            return;
        } else if (command === 'ayuda' || command === 'manual' || command === 'help') {
            await showDetailedHelp(message);
            return;
        } else if (command.startsWith('enviale medios') || command.startsWith('medios')) {
            await handleSendManualPaymentMethods(message, command, client, userStates);
            return;
        } else if (command.includes('credencial') || command.includes('credenciales')) {
            const { handleSendCredentialsCommand, handleSendBulkCredentials } = require('./adminService');
            const { getAccountsByPhone } = require('./apiService');
            const isEmailOrPhone = command.includes('@') || /573\d{9}|3\d{9}/.test(command);
            if (isEmailOrPhone) {
                await handleSendCredentialsCommand(message, command, client, getAccountsByPhone, userStates);
            } else {
                await handleSendBulkCredentials(message, command, client, getAccountsByPhone, userStates);
            }
            return;
        } else {
            // --- Admin Data Queries (Dashboard Conversacional) ---
            // Si el comando @bot no coincide con nada rígido, usar IA para consultar datos o conversar
            const { processAdminQuery } = require('./adminQueries');

            // Resolución de texto de consulta
            let queryText = command; // Usamos el comando ya limpio
            const isAffirmative = ['si', 'sí', 'dale', 'ok', 'yes', 'proceder', 'confirmar'].includes(queryText.toLowerCase());

            // Recalcular estados para asegurar frescura
            const freshAdminState = userStates.get(userId);
            const freshIsAwaitingConfirm = freshAdminState && freshAdminState.state === 'awaiting_admin_broadcast_confirmation';
            const freshIsAwaitingSuggestion = freshAdminState && freshAdminState.state === 'awaiting_admin_suggestion_selection';

            if (queryText.length > 0) {
                // --- CASO 1: Respuesta afirmativa ("si", "dale") ---
                if (isAffirmative && (freshIsAwaitingConfirm || freshIsAwaitingSuggestion)) {
                    if (freshIsAwaitingSuggestion) {
                        if (freshAdminState.payload && freshAdminState.payload.options && freshAdminState.payload.options.length === 1) {
                            const selectedPlatform = freshAdminState.payload.options[0];
                            const { fetchRawData } = require('./apiService');
                            const rawData = await fetchRawData();
                            const resultDirect = await processAdminQuery(message, selectedPlatform, userStates, client, freshAdminState.originalFilters, rawData);
                            if (resultDirect && resultDirect.filteredData) await handleAdminResultLogic(resultDirect.filteredData, userId, userStates, message, freshIsAwaitingConfirm, freshAdminState);
                            return;
                        }
                    }
                    const result = await processAdminQuery(message, queryText, userStates, client, freshAdminState);
                    if (result && result.filteredData) await handleAdminResultLogic(result.filteredData, userId, userStates, message, freshIsAwaitingConfirm, freshAdminState);
                    return;
                }

                // --- CASO 1.5: Cancelar Broadcast ---
                if (freshIsAwaitingConfirm && !isAffirmative) {
                    const isNegative = ['no', 'cancelar', 'abortar', 'detener'].includes(queryText.toLowerCase());
                    if (isNegative) {
                        userStates.delete(userId);
                        await message.reply("🚫 *Envío masivo cancelado.*");
                        return;
                    }
                    // Si no es negativo ni afirmativo, dejamos que pase a Caso 3 para que processAdminQuery
                    // lo trate como un refinamiento contextual (ej. "descarta los extra").
                }

                // --- CASO 2: Selección directa de plataforma en estado de sugerencia ---
                if (freshIsAwaitingSuggestion && !isAffirmative) {
                    const { fetchRawData } = require('./apiService');
                    const rawData = await fetchRawData();
                    const resultDirect = await processAdminQuery(message, queryText, userStates, client, freshAdminState.originalFilters, rawData);
                    if (resultDirect && resultDirect.filteredData) await handleAdminResultLogic(resultDirect.filteredData, userId, userStates, message, freshIsAwaitingConfirm, freshAdminState);
                    return;
                }

                // --- CASO 3: Consulta general (Data o Conversación) ---
                const result = await processAdminQuery(message, queryText, userStates, client, freshAdminState);
                if (result && result.filteredData) {
                    await handleAdminResultLogic(result.filteredData, userId, userStates, message, freshIsAwaitingConfirm, freshAdminState);
                }
                return;
            }
        }
        return;
    }

    // MANEJO CONVERSACIONAL DEL GRUPO ADMIN (Respuestas)
    if (message.from === GROUP_ID) {
        const groupStateData = userStates.get(GROUP_ID);
        if (groupStateData && typeof groupStateData === 'object') {
            const gState = groupStateData.state;
            const targetResponse = message.body.trim();

            if (gState === 'awaiting_target_for_credentials') {
                const { handleSendBulkCredentials } = require('./adminService');
                const { getAccountsByPhone } = require('./apiService');
                await handleSendBulkCredentials(message, `${groupStateData.platform} ${targetResponse}`, client, getAccountsByPhone, userStates, true);
                userStates.delete(GROUP_ID);
                return;
            } else if (gState === 'awaiting_target_for_payment_methods') {
                await handleSendManualPaymentMethods(message, `medios ${targetResponse}`, client, userStates, true);
                userStates.delete(GROUP_ID);
                return;
            } else if (gState === 'awaiting_admin_broadcast_confirmation' || gState === 'awaiting_admin_suggestion_selection') {
                const isAffirmative = ['si', 'sí', 'dale', 'ok', 'yes', 'proceder', 'confirmar'].includes(targetResponse.toLowerCase());
                if (isAffirmative) {
                    const { processAdminQuery } = require('./adminQueries');
                    const result = await processAdminQuery(message, targetResponse, userStates, client);
                    const isAwaitingConfirm = gState === 'awaiting_admin_broadcast_confirmation';
                    if (result && result.filteredData) {
                        await handleAdminResultLogic(result.filteredData, GROUP_ID, userStates, message, isAwaitingConfirm, groupStateData);
                    }
                    return;
                }
            }
        }
    }

    let cleanBody = combinedBody;
    if (cleanBody.startsWith('"') && cleanBody.endsWith('"')) {
        cleanBody = cleanBody.slice(1, -1).trim();
    }

    // --- GENERAL CODE INTERCEPTOR (Netflix, Disney+, Max, Amazon, GPT, Apple, etc.) ---
    const lowerBody = cleanBody.toLowerCase();

    const wantsCodeKeywords = [
        'código', 'codigo', 'codigoo', 'codigooo', 'actualizar hogar', 'mi codigo', 'mi código',
        'enviar código', 'enviar codigo', 'el código', 'el codigo',
        'pide codigo', 'pide código', 'authenticator', 'token', 'verificacion', 'verificación',
        'envia el codigo', 'envía el código', 'mandar codigo', 'mandar código'
    ];
    const platformsSupported = [
        'netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'gpt', 'chatgpt',
        'youtube', 'spotify', 'paramount', 'apple', 'claude', 'canva',
        'crunchyroll', 'vix', 'gamma', 'iptv', 'magis', 'microsoft'
    ];
    const isPaymentState = currentStateData && (currentStateData.state === 'awaiting_payment_confirmation' || currentStateData.state === 'waiting_admin_confirmation');
    const isPaymentOrReceipt = isPaymentState || lowerBody.includes('qr') || lowerBody.includes('barras') || lowerBody.includes('pago') || lowerBody.includes('comprobante') || lowerBody.includes('recibo') || lowerBody.includes('abono') || lowerBody.includes('transferencia');
    const hasExplicitCodeKeyword = wantsCodeKeywords.some(kw => lowerBody.includes(kw)) || /\bc[oó]dig[oó]+\b/i.test(lowerBody);
    const hasCodeKeyword = hasExplicitCodeKeyword && !isPaymentOrReceipt;
    const hasPlatformKeyword = platformsSupported.some(p => lowerBody.includes(p));
    const isQuestionOrCode = (lowerBody === '?' || wantsCodeKeywords.some(kw => lowerBody === kw) || /\bc[oó]dig[oó]+\b/i.test(lowerBody)) && !isPaymentOrReceipt;

    if (hasCodeKeyword || (isQuestionOrCode && hasPlatformKeyword)) {
        try {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(realPhone, foundName);

            if (userAccounts.length > 0) {
                let targetAccount = null;

                // 0. Si el usuario envió un correo explícito en su mensaje, buscar por ese correo directamente
                const emailInMsg = lowerBody.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailInMsg) {
                    const directEmail = emailInMsg[0].toLowerCase().trim();
                    const accByEmail = userAccounts.find(a => (a.correo || "").toLowerCase().trim() === directEmail);
                    if (accByEmail) {
                        targetAccount = accByEmail;
                    } else {
                        targetAccount = {
                            correo: directEmail,
                            Streaming: matchedPlatform ? matchedPlatform.toUpperCase() : (userAccounts[0] ? userAccounts[0].Streaming : 'AMAZON')
                        };
                    }
                }

                // 1. Intentar buscar coincidencia directa por plataforma si no se especificó correo
                if (!targetAccount) {
                    const matchedPlatform = platformsSupported.find(p => lowerBody.includes(p));
                    if (matchedPlatform) {
                        targetAccount = userAccounts.find(c => {
                            const streamingName = (c.Streaming || "").toLowerCase();
                            if (matchedPlatform === 'hbo' || matchedPlatform === 'max') {
                                return streamingName.includes('hbo') || streamingName.includes('max');
                            }
                            if (matchedPlatform === 'amazon' || matchedPlatform === 'prime') {
                                return streamingName.includes('amazon') || streamingName.includes('prime');
                            }
                            return streamingName.includes(matchedPlatform);
                        });
                    }

                    // Si especificó una plataforma pero no está entre sus cuentas activas, no usar fallbacks
                    if (matchedPlatform && !targetAccount) {
                        const activePlats = Array.from(new Set(userAccounts.map(a => (a.Streaming || "").toUpperCase()).filter(Boolean))).join(', ');
                        await message.reply(`🤖 Veo que solicitas un código para *${matchedPlatform.toUpperCase()}*, pero no tienes una cuenta activa de esa plataforma vinculada a tu número de WhatsApp. ${activePlats ? `Actualmente solo tienes activo: *${activePlats}*` : 'No tienes servicios activos con nosotros'}.\n\nSi deseas renovar o adquirir tu cuenta de *${matchedPlatform.toUpperCase()}*, por favor indícalo para ayudarte. 😊`);
                        return;
                    }
                }

                // 2. Si no hay coincidencia directa (y no se especificó plataforma ajena), pero solo tiene 1 cuenta, usar esa
                if (!targetAccount && userAccounts.length === 1) {
                    targetAccount = userAccounts[0];
                }

                // 3. Si tiene varias, presentar opciones para evitar errores o falsos supuestos
                if (!targetAccount && userAccounts.length > 1) {
                    let msg = `🤖 Veo que tienes registradas múltiples cuentas activas. ¿De cuál de ellas necesitas el código de verificación?\n\n`;
                    userAccounts.forEach((acc, idx) => {
                        const platName = (acc.Streaming || "").toUpperCase();
                        const email = (acc.correo || "").trim().toLowerCase();
                        const profile = acc['pin perfil'] || acc['Nombre'] || "";
                        const profileStr = profile ? ` (Perfil: ${profile})` : "";
                        msg += `${idx + 1} - *${platName}* - ${email}${profileStr}\n`;
                    });
                    msg += `\n*Responde únicamente con el número de la opción que deseas.* 📲`;

                    await message.reply(msg);

                    userStates.set(userId, {
                        state: 'awaiting_code_account_selection',
                        candidates: userAccounts,
                        timestamp: Date.now(),
                        nombre: foundName
                    });
                    return;
                }

                if (targetAccount) {
                    await processAccountVerificationCode(message, userId, targetAccount, realPhone, client, userStates);
                    return;
                }
            }
        } catch (e) {
            console.error("Error en interceptor general de códigos:", e);
        }
    }

    if (cleanBody.toLowerCase().startsWith("hola, estoy interesado en")) {
        message.body = cleanBody;
        await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
        return;
    }

    let mediaData = [];
    if (isMedia) {
        // --- MANEJO DE MULTIMEDIA (LOTE) ---
        const history = await getChatHistoryText(message);

        try {
            for (const m of messages) {
                const media = await downloadMediaWithRetry(m);
                if (media && media.data && media.mimetype) {
                    const cleanMime = media.mimetype.split(';')[0].trim();
                    const isAudio = m.type === 'ptt' || m.type === 'audio' || cleanMime.startsWith('audio/');
                    if (isAudio) {
                        try {
                            const { transcribeAudioWithGemini } = require('./aiService');
                            console.log(`[AUDIO DETECTED] 🎙️ Nota de voz de @${userId}. Transcribiendo con Gemini...`);
                            const audioText = await transcribeAudioWithGemini({ data: media.data, mimeType: cleanMime });
                            if (audioText) {
                                console.log(`[AUDIO TRANSCRIBED] 🎙️ Transcripción: "${audioText}"`);
                                m.body = audioText;
                                m.isAudioNote = true;
                                if (!message.body) message.body = audioText;
                                else message.body += `\n${audioText}`;
                            }
                        } catch (audioErr) {
                            console.error("[AUDIO ERROR] Error transcribiendo audio:", audioErr.message);
                        }
                    } else {
                        mediaData.push({ data: media.data, mimeType: cleanMime });
                    }
                }
            }
        } catch (err) {
            console.error("Error descargando multimedia del lote:", err.message);
        }

        // Si solo se enviaron notas de voz (sin fotos/imágenes adjuntas), desactivar isMedia para no confundir al bot
        if (mediaData.length === 0 && messages.some(m => m.isAudioNote)) {
            isMedia = false;
        }

        // --- INTERCEPTOR GLOBAL DE PAGOS ---
        if (mediaData.length > 0) {
            // Tomamos la primera imagen para el interceptor de pagos (normalmente el usuario manda el recibo solo)
            const batchText = messages.map(m => m.body).filter(b => b).join('\n');
            const check = await isPaymentReceipt(mediaData[0], `[TEXTO EN ESTE LOTE: ${batchText}]\n\n${history}`);
            console.log(`[PAYMENT INTERCEPTOR DEBUG] Result check: isReceipt=${check.isReceipt}, amount=${check.amount}, bank=${check.bank}, platform=${check.inferredPlatform}`);

            if (check.isReceipt) {
                console.log(`[PAYMENT INTERCEPTOR] ✅ Comprobante detectado (${check.bank || 'Banco'}) para @${userId}`);

                const existing = userStates.get(userId);
                const stateData = typeof existing === 'object' ? { ...existing } : { nombre: foundName };

                const { getAccountsByPhone } = require('./apiService');
                let userAccounts = [];
                try { userAccounts = await getAccountsByPhone(realPhone, foundName); } catch (e) { }

                const historyLower = (history || "").toLowerCase();
                const lastMsgLower = (batchText || "").toLowerCase();
                const isNewRequested = historyLower.includes('otro') ||
                    historyLower.includes('otra') ||
                    historyLower.includes('nueva') ||
                    historyLower.includes('nuevo') ||
                    historyLower.includes('adquirir') ||
                    historyLower.includes('adicional') ||
                    lastMsgLower.includes('otro') ||
                    lastMsgLower.includes('otra') ||
                    lastMsgLower.includes('nueva') ||
                    lastMsgLower.includes('nuevo') ||
                    lastMsgLower.includes('adquirir') ||
                    lastMsgLower.includes('adicional') ||
                    stateData.intent === 'comprar' ||
                    stateData.state === 'awaiting_purchase_platforms';

                // Si el carrito está vacío, intentar auto-rellenarlo inteligentemente
                if (!stateData.items || stateData.items.length === 0) {
                    const { getPlatforms } = require('./salesService');
                    let platforms = [];
                    try { platforms = await getPlatforms(); } catch (e) { }

                    // 1. PRIORIDAD MÁXIMA: Si el usuario YA TIENE cuentas activas y no solicitó servicio nuevo
                    if (userAccounts && userAccounts.length > 0 && !isNewRequested) {
                        const { getPlatformPriceFromExcel } = require('./billingService');
                        let totalAllAccountsPrice = 0;
                        const accountsWithPrices = userAccounts.map(acc => {
                            const price = getPlatformPriceFromExcel(acc, platforms);
                            return { ...acc, calculatedPrice: price };
                        });

                        totalAllAccountsPrice = accountsWithPrices.reduce((sum, a) => sum + (a.calculatedPrice || 0), 0);
                        if (userAccounts.length > 1) {
                            totalAllAccountsPrice = Math.max(0, totalAllAccountsPrice - (1000 * (userAccounts.length - 1)));
                        }

                        // A. Si el monto transferido coincide exactamente con el combo total de todas sus cuentas
                        if (check.amount && check.amount === totalAllAccountsPrice) {
                            console.log(`[PAYMENT INTERCEPTOR] Monto $${check.amount} coincide exactamente con el combo total de sus cuentas (${userAccounts.map(a => a.Streaming).join(', ')}).`);
                            stateData.items = userAccounts;
                            stateData.total = totalAllAccountsPrice;
                            stateData.isRenewal = true;
                            stateData.isAutoFilled = true;
                            userStates.set(userId, stateData);
                        }
                        // B. Si el monto transferido coincide con una sola cuenta específica del usuario
                        else if (check.amount && accountsWithPrices.some(ap => ap.calculatedPrice === check.amount)) {
                            const matchedAcc = accountsWithPrices.find(ap => ap.calculatedPrice === check.amount);
                            console.log(`[PAYMENT INTERCEPTOR] Monto $${check.amount} coincide con la cuenta ${matchedAcc.Streaming} (precio real: $${matchedAcc.calculatedPrice}) del usuario.`);
                            stateData.items = [matchedAcc];
                            stateData.total = check.amount;
                            stateData.isRenewal = true;
                            stateData.isAutoFilled = true;
                            userStates.set(userId, stateData);
                        }
                        // C. Si solo tiene 1 cuenta activa, es renovación de esa cuenta
                        else if (userAccounts.length === 1) {
                            console.log(`[PAYMENT INTERCEPTOR] Usuario tiene 1 sola cuenta activa (${userAccounts[0].Streaming}). Renovando automáticamente.`);
                            stateData.items = [userAccounts[0]];
                            stateData.total = check.amount || accountsWithPrices[0].calculatedPrice;
                            stateData.isRenewal = true;
                            stateData.isAutoFilled = true;
                            userStates.set(userId, stateData);
                        }
                        // D. Si tiene múltiples cuentas y el monto cubre el combo total
                        else if (userAccounts.length > 1 && check.amount && check.amount >= totalAllAccountsPrice) {
                            console.log(`[PAYMENT INTERCEPTOR] Monto $${check.amount} cubre el combo completo de sus cuentas.`);
                            stateData.items = userAccounts;
                            stateData.total = totalAllAccountsPrice || check.amount;
                            stateData.isRenewal = true;
                            stateData.isAutoFilled = true;
                            userStates.set(userId, stateData);
                        }
                        // E. Si se detectó una plataforma que coincide con alguna de sus cuentas o corregir plataforma inferida errónea
                        else if (check.inferredPlatform) {
                            const matchedAcc = userAccounts.find(acc => {
                                const accStr = (acc.Streaming || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                                const infStr = check.inferredPlatform.toLowerCase().replace(/[^a-z0-9]/g, '');
                                return accStr.includes(infStr) || infStr.includes(accStr);
                            });
                            if (matchedAcc) {
                                console.log(`[PAYMENT INTERCEPTOR] Plataforma detectada ${check.inferredPlatform} coincide con su cuenta ${matchedAcc.Streaming}.`);
                                stateData.items = [matchedAcc];
                                stateData.total = check.amount;
                                stateData.isRenewal = true;
                                stateData.isAutoFilled = true;
                                userStates.set(userId, stateData);
                            } else if (userAccounts.length === 1) {
                                console.log(`[PAYMENT INTERCEPTOR] Corrigiendo plataforma inferida (${check.inferredPlatform}) a la única cuenta activa real del cliente: ${userAccounts[0].Streaming}.`);
                                stateData.items = [userAccounts[0]];
                                stateData.total = check.amount;
                                stateData.isRenewal = true;
                                stateData.isAutoFilled = true;
                                userStates.set(userId, stateData);
                            }
                        }
                    }

                    // 2. Si todavía no se llenó (ej: compra nueva de cliente sin cuentas o con solicitud explícita)
                    if (!stateData.items || stateData.items.length === 0) {
                        if (check.inferredPlatform) {
                            console.log(`[PAYMENT INTERCEPTOR] Auto-rellenando carrito vacío con inferredPlatform: ${check.inferredPlatform}. isNewRequested=${isNewRequested}`);
                            let catalogPrice = 0;
                            let matchedItems = [];
                            const lowerInferred = check.inferredPlatform.toLowerCase().replace(/[^a-z0-9]/g, '');

                            const matchedPlats = platforms.filter(p => {
                                const cleanPlat = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                                return lowerInferred.includes(cleanPlat) || cleanPlat.includes(lowerInferred);
                            });

                            for (const plat of matchedPlats) {
                                let price = plat.price || 0;
                                let planName = plat.name;

                                if (plat.plans && plat.plans.length > 0) {
                                    const specificPlan = plat.plans.find(plan => {
                                        const cleanPlan = plan.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                                        const cleanInferred = check.inferredPlatform.toUpperCase().replace(/[^A-Z0-9]/g, '');
                                        return cleanInferred.includes(cleanPlan) || cleanPlan.includes(cleanInferred);
                                    }) || (check.amount ? plat.plans.find(plan => plan.price === check.amount) : null);

                                    if (specificPlan) {
                                        price = specificPlan.price;
                                        planName = `${plat.name} - ${specificPlan.name}`;
                                    } else {
                                        price = plat.plans[0].price;
                                        planName = `${plat.name} - ${plat.plans[0].name}`;
                                    }
                                }

                                catalogPrice += price;
                                matchedItems.push({
                                    Streaming: planName,
                                    platform: { name: plat.name }
                                });
                            }

                            if (matchedItems.length > 1) {
                                catalogPrice = Math.max(0, catalogPrice - 1000);
                            }

                            if (matchedItems.length > 0) {
                                stateData.items = matchedItems;
                            } else {
                                stateData.items = [{ Streaming: check.inferredPlatform, platform: { name: check.inferredPlatform } }];
                            }
                            stateData.total = catalogPrice || check.amount;
                            stateData.isAutoFilled = true;
                            userStates.set(userId, stateData);
                        } else if (userAccounts.length === 1 && !isNewRequested) {
                            stateData.items = [userAccounts[0]];
                            stateData.total = check.amount;
                            stateData.isAutoFilled = true;
                            stateData.isRenewal = true;
                            userStates.set(userId, stateData);
                        } else if (userAccounts.length > 1 && !isNewRequested) {
                            stateData.items = userAccounts;
                            stateData.total = check.amount;
                            stateData.isAutoFilled = true;
                            stateData.isRenewal = true;
                            userStates.set(userId, stateData);
                        }
                    }

                    // Si el carrito contiene plataformas que el usuario YA TIENE activas en Excel/DB, es obligatoriamente una RENOVACIÓN
                    if (userAccounts && userAccounts.length > 0 && !isNewRequested && stateData.items && stateData.items.length > 0) {
                        const { isSamePlatformFamily } = require('./salesRegistryService');
                        const matchingActiveAccounts = userAccounts.filter(acc => {
                            return stateData.items.some(item => {
                                const itemPlat = (item.Streaming || (item.platform ? item.platform.name : '') || item.name || '').toUpperCase();
                                const accPlat = (acc.Streaming || '').toUpperCase();
                                return isSamePlatformFamily(itemPlat, accPlat) || itemPlat.includes(accPlat) || accPlat.includes(itemPlat);
                            });
                        });
                        if (matchingActiveAccounts.length > 0) {
                            console.log(`[PAYMENT INTERCEPTOR] Encontradas ${matchingActiveAccounts.length} cuentas activas existentes para @${userId}. Marcadas estrictamente como RENOVACIÓN.`);
                            stateData.items = matchingActiveAccounts;
                            stateData.isRenewal = true;
                            userStates.set(userId, stateData);
                        }
                    }
                }

                // --- NUEVO: VALIDACIÓN AUTOMÁTICA GMAIL ---
                const { adjustDurationToMatchAmount } = require('./billingService');
                await adjustDurationToMatchAmount(stateData, check.amount, userId);

                let currentCheckAmount = check.amount || 0;
                let previousCheckPaid = (stateData.checkAmount && stateData.checkAmount !== currentCheckAmount) ? stateData.checkAmount : 0;
                let totalPaidSoFar = previousCheckPaid + currentCheckAmount;
                let leftoverAmount = 0;
                if (check.amount && check.amount > 0) {
                    const expectedTotal = Math.max(0, (stateData.total || 0) - (stateData.saldo || 0));
                    leftoverAmount = (expectedTotal > 0 && totalPaidSoFar > expectedTotal) ? (totalPaidSoFar - expectedTotal) : 0;
                    try {
                        const isShortPayment = expectedTotal > 0 && totalPaidSoFar < expectedTotal;

                        if (isShortPayment) {
                            console.log(`[PAYMENT AUTO-VALIDATE] ❌ Monto del comprobante ($${check.amount}) + anterior ($${stateData.checkAmount || 0}) es menor al total esperado ($${expectedTotal}) para @${userId}. No se auto-validará.`);

                            userStates.set(userId, {
                                ...stateData,
                                state: 'awaiting_payment_confirmation',
                                paymentMethod: check.bank || 'Transferencia',
                                checkAmount: totalPaidSoFar
                            });
                            globalLastPaymentUserId = userId;

                            const diff = expectedTotal - totalPaidSoFar;
                            const replyText = `🤖 ¡Hola! He recibido tu comprobante por valor de *$${check.amount.toLocaleString('es-CO')}*.\n\n` +
                                `Con esto, has pagado un total acumulado de *$${totalPaidSoFar.toLocaleString('es-CO')}* COP. Sin embargo, el total de tu pedido es de *$${expectedTotal.toLocaleString('es-CO')}* COP. Aún hace falta un pago por el valor restante de *$${diff.toLocaleString('es-CO')}* COP. ⚠️\n\n` +
                                `Por favor realiza la transferencia del monto restante y envía el nuevo comprobante para poder completar tu pedido y entregar/activar tu servicio. ¡Muchas gracias! 😊`;

                            await message.reply(replyText);
                            await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);

                            try {
                                const groupChat = await client.getChatById(GROUP_ID);
                                if (groupChat) {
                                    const displayTarget = realPhone || userId.replace('@c.us', '').replace('@lid', '');
                                    let adminMsg = `🚨 *COMPROBANTE DETECTADO INCOMPLETO* (@${displayTarget})\n` +
                                        `⚠️ *PAGO INCOMPLETO ACCUMULADO* (Faltan $${diff})\n` +
                                        `Banco: ${check.bank || 'No identificado'}\n` +
                                        `Monto Recibido: $${check.amount}\n` +
                                        `Total Acumulado: $${totalPaidSoFar}\n` +
                                        `Monto Esperado: $${expectedTotal}\n\n` +
                                        `Valida el pago y confirma usando:\n*confirmar ${displayTarget}*`;

                                    await groupChat.sendMessage(adminMsg);
                                    const mediaToForward = await message.downloadMedia();
                                    await groupChat.sendMessage(mediaToForward);
                                }
                            } catch (adminErr) {
                                console.error("Error notificando al grupo sobre pago incompleto:", adminErr.message);
                            }
                            return;
                        } else {
                            const match = await findMatchingPayment(check.amount, 60, userId); // Ventana de 60 min
                            if (match) {
                                console.log(`[PAYMENT AUTO-VALIDATE] ✅ Match encontrado en Gmail para @${userId} ($${check.amount})`);

                                // INTELIGENCIA DE RENOVACIÓN DE COMBOS Y MÚLTIPLES CUENTAS:
                                if (stateData.isRenewal && stateData.items && stateData.items.length > 1 && check.amount) {
                                    try {
                                        const { getJsDateFromExcel } = require('./apiService');
                                        const { getPlatformPriceFromExcel } = require('./billingService');
                                        const now = new Date();
                                        now.setHours(0, 0, 0, 0);

                                        const validItems = stateData.items.filter(item => {
                                            const str = (item.Streaming || item.Plataforma || "").toString().trim().toLowerCase();
                                            return str && str !== 'gmail.com' && !str.includes('@') && !str.endsWith('.com');
                                        });

                                        // Calcular el precio total esperado para renovar todas las cuentas
                                        let totalExpectedAll = 0;
                                        for (const item of validItems) {
                                            const price = getPlatformPriceFromExcel(item.Streaming || item.Plataforma, []);
                                            totalExpectedAll += (price || 7500);
                                        }

                                        const stateTotal = stateData.total || stateData.checkAmount || 0;
                                        // Si el monto pagado cubre exactamente el total de todas las cuentas o coincide con stateData.total:
                                        if (check.amount === stateTotal || (totalExpectedAll > 0 && Math.abs(check.amount - totalExpectedAll) <= 1000) || (stateTotal > 0 && Math.abs(check.amount - stateTotal) <= 1000)) {
                                            console.log(`[PAYMENT AUTO-RENEW ALL] ✅ El monto de $${check.amount} coincide con el total de todas las cuentas (${validItems.length} cuentas). Auto-renovando todas sin preguntar.`);
                                            stateData.items = validItems;
                                            // Continuar directamente a la validación y entrega automática de todas
                                        } else {
                                            const urgentItems = validItems.filter(item => {
                                                const d = getJsDateFromExcel(item.deben || item.vencimiento);
                                                if (!d) return true;
                                                const diffDays = (d - now) / (1000 * 60 * 60 * 24);
                                                return diffDays <= 7;
                                            });

                                            const candidateList = urgentItems.length > 0 ? urgentItems : validItems;
                                            const formatDateForDisplay = (rawVal) => {
                                                if (!rawVal) return "N/A";
                                                const d = getJsDateFromExcel(rawVal);
                                                if (!d || isNaN(d.getTime())) return String(rawVal);
                                                const day = String(d.getDate()).padStart(2, '0');
                                                const month = String(d.getMonth() + 1).padStart(2, '0');
                                                const year = d.getFullYear();
                                                return `${day}/${month}/${year}`;
                                            };

                                            const allPlatsNames = [...new Set(candidateList.map(acc => (acc.Streaming || acc.Plataforma || "Servicio").toUpperCase()))].join(', ');
                                            
                                            let promptMsg = `🤖 ¡Hola! He recibido tu comprobante de pago por *$${check.amount.toLocaleString('es-CO')}* COP.\n\n` +
                                                `Veo que tienes varias cuentas activas en nuestro sistema. Por favor responde únicamente con el número de la opción deseada:\n\n` +
                                                `1 - Renovar *TODAS* mis cuentas (${allPlatsNames}) ✅\n`;
                                            
                                            candidateList.forEach((acc, idx) => {
                                                const platName = (acc.Streaming || acc.Plataforma || "Servicio").toUpperCase();
                                                const vencStr = formatDateForDisplay(acc.deben || acc.vencimiento);
                                                const profileOrName = acc.Nombre || acc.nombre || acc.whatsapp || acc["Customer Mail"] || "";
                                                const detailStr = (profileOrName && profileOrName.toLowerCase() !== 'libre') ? ` (Para: ${profileOrName})` : '';
                                                promptMsg += `${idx + 2} - Renovar solo *${platName}*${detailStr} (Vence: ${vencStr})\n`;
                                            });
                                            promptMsg += `${candidateList.length + 2} - Es para un servicio nuevo u otro motivo ❌`;

                                            await message.reply(promptMsg);

                                            userStates.set(userId, {
                                                state: 'awaiting_payment_multi_renewal_selection',
                                                candidateAccounts: candidateList,
                                                amount: check.amount,
                                                bank: check.bank,
                                                matchId: match.id,
                                                subject: match.subject,
                                                chatJid: originalChatJid,
                                                nombre: foundName,
                                                leftoverAmount: leftoverAmount
                                            });
                                            return;
                                        }
                                    } catch (err) {
                                        console.error("Error en Smart Combo Filter:", err.message);
                                    }
                                }

                                // EN CASO DE MÚLTIPLES CUENTAS ACTIVAS: Si el pago cubre la totalidad del cobro, renovar automáticamente sin preguntar
                                if (stateData.isRenewal && stateData.items && stateData.items.length > 1) {
                                    const itemsSum = stateData.items.reduce((sum, item) => {
                                        const itemPrice = item.price || (item.platform ? item.platform.price : 0) || 0;
                                        return sum + itemPrice;
                                    }, 0);

                                    const targetTotal = stateData.total || itemsSum;
                                    const isFullPayment = targetTotal > 0 ? (check.amount >= (targetTotal - 1000)) : true;

                                    if (isFullPayment) {
                                        console.log(`[PAYMENT AUTO-RENEW] 🚀 El pago ($${check.amount}) cubre la totalidad del cobro ($${targetTotal}) para @${userId}. Renovando todas las cuentas automáticamente sin preguntar.`);
                                        // Continúa el flujo directo a executePaymentValidation
                                    } else {
                                        // Si el pago es parcial (menor al total de todas las cuentas), preguntar a cuáles aplicarlo
                                        const allPlatsStr = stateData.items.map(item => (item.Streaming || item.name || "Servicio").toUpperCase()).join(', ');
                                        let msg = `🤖 ¡Hola! He recibido tu comprobante de pago por *$${check.amount.toLocaleString('es-CO')}* COP.\n\n` +
                                            `Veo que tienes varias cuentas activas (*${allPlatsStr}*). Tu pago cubre parcialmente algunas de tus cuentas. Por favor indica a cuáles deseas aplicar tu pago: 😊\n\n` +
                                            `1 - Renovar TODAS mis cuentas activas (${allPlatsStr}) ✅\n`;

                                        stateData.items.forEach((acc, idx) => {
                                            const platName = (acc.Streaming || acc.name || "Servicio").toUpperCase();
                                            const mail = (acc.correo || "").trim().toLowerCase();
                                            const profileStr = acc['pin perfil'] ? ` (Perfil: ${acc['pin perfil']})` : "";
                                            msg += `${idx + 2} - Renovar solo ${platName}${mail ? ` [${mail}]` : ''}${profileStr}\n`;
                                        });

                                        const otherOptIdx = stateData.items.length + 2;
                                        msg += `${otherOptIdx} - Servicio nuevo u otro motivo ❌\n\n` +
                                            `*Responde únicamente con el número de la opción elegida.* 📲`;

                                        await message.reply(msg);

                                        userStates.set(userId, {
                                            state: 'awaiting_payment_multi_renewal_selection',
                                            candidateAccounts: stateData.items,
                                            amount: check.amount,
                                            bank: check.bank,
                                            matchId: match.id,
                                            subject: match.subject,
                                            chatJid: originalChatJid,
                                            nombre: foundName,
                                            leftoverAmount: leftoverAmount
                                        });
                                        return;
                                    }
                                }

                                // SI LA PLATAFORMA FUE AUTO-RELLENADA DE FORMA IMPLÍCITA (PORQUE EL RECIBO NO TENÍA LA PLATAFORMA), PEDIR CONFIRMACIÓN
                                if (stateData.isImplicitFallback && stateData.items && stateData.items.length > 0) {
                                    const targetPlat = (stateData.items[0].Streaming || "Servicio").toUpperCase();
                                    let msg = `🤖 ¡Hola! He recibido tu comprobante de Nequi/Abono de *$${check.amount}*.\n\n` +
                                        `Veo que tienes una cuenta activa de *${targetPlat}*. ¿Este pago es para renovar tu servicio de *${targetPlat}* por un valor de *${check.amount}*? ¿Esta información es correcta para poder proceder? 😊\n\n` +
                                        `1 - Sí, renovar ${targetPlat} ✅\n` +
                                        `2 - No, es para un servicio nuevo u otro motivo ❌`;
                                    await message.reply(msg);

                                    userStates.set(userId, {
                                        state: 'awaiting_payment_renewal_confirmation',
                                        matchedAccount: stateData.items[0],
                                        amount: check.amount,
                                        bank: check.bank,
                                        matchId: match.id,
                                        subject: match.subject,
                                        chatJid: originalChatJid,
                                        nombre: foundName,
                                        leftoverAmount: leftoverAmount
                                    });
                                    return;
                                }

                                // Si el usuario ya tiene una cuenta activa en Excel/DB para este teléfono en la plataforma comprada, es una RENOVACIÓN
                                const { isSamePlatformFamily } = require('./salesRegistryService');
                                const targetPlatformName = (stateData.items && stateData.items[0])
                                    ? (stateData.items[0].Streaming || (stateData.items[0].platform ? stateData.items[0].platform.name : "") || stateData.items[0].name || "").toLowerCase()
                                    : "";

                                const userHasActiveAccount = userAccounts && Array.isArray(userAccounts) && userAccounts.some(acc => {
                                    const s = (acc.Streaming || "").toLowerCase();
                                    if (!s) return false;
                                    if (!targetPlatformName) return true;
                                    return isSamePlatformFamily(s, targetPlatformName) || s.includes(targetPlatformName) || targetPlatformName.includes(s);
                                });

                                if (userHasActiveAccount) {
                                    stateData.isRenewal = true;
                                }

                                let hasNetflix = false;
                                if (stateData.items && Array.isArray(stateData.items)) {
                                    hasNetflix = stateData.items.some(item => {
                                        const name = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "").toLowerCase();
                                        return name.includes('netflix') && !name.includes('extra');
                                    });
                                }

                                if (hasNetflix && !stateData.isRenewal) {
                                    await message.reply("🤖 ¡Gracias! He recibido tu comprobante de pago. 🎉\n\nListo, me confirmas por favor localidad o municipio donde se va a usar y operador de internet\n\nEj. suba-movistar");

                                    userStates.set(userId, {
                                        ...stateData,
                                        state: 'awaiting_netflix_operator_post_payment',
                                        paymentMethod: check.bank || 'Transferencia',
                                        checkAmount: check.amount,
                                        gmailMatchId: match.id,
                                        leftoverAmount: leftoverAmount
                                    });

                                    return;
                                }

                                // SI EL CARRITO FUE AUTO-RELLENADO DESDE LA IA / HISTORIAL (CARRITO VACÍO PREVIO PARA VENTA NUEVA), CONFIRMAR CON EL USUARIO ANTES DE ENTREGAR
                                if (!stateData.isRenewal && stateData.isAutoFilled && stateData.items && stateData.items.length > 0) {
                                    const item = stateData.items[0];
                                    const targetPlat = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "Servicio").toUpperCase();
                                    const actionWord = "activar tu";
                                    const buttonWord = "activar";

                                    let msg = `🤖 ¡Hola! He recibido tu comprobante de pago por *$${check.amount.toLocaleString('es-CO')}* COP.\n\n` +
                                        `Veo que deseas ${actionWord} servicio de *${targetPlat}*, ¿es correcto para proceder con la entrega de tus credenciales? 😊\n\n` +
                                        `1 - Sí, ${buttonWord} ${targetPlat} ✅\n` +
                                        `2 - No, es para otra plataforma u otro motivo ❌`;
                                    await message.reply(msg);

                                    userStates.set(userId, {
                                        state: 'awaiting_payment_autofill_confirmation',
                                        pendingStateData: { ...stateData, total: check.amount, leftoverAmount: leftoverAmount, paymentMethod: `Gmail Match (${check.bank || 'Bre-B'})` },
                                        amount: check.amount,
                                        bank: check.bank,
                                        matchId: match.id,
                                        chatJid: originalChatJid,
                                        nombre: foundName,
                                        targetPlat: targetPlat
                                    });
                                    return;
                                }

                                // Ejecutar validación automática directa si todo coincide perfectamente
                                const validationResult = await executePaymentValidation(
                                    userId,
                                    { ...stateData, total: check.amount, leftoverAmount: leftoverAmount, paymentMethod: `Gmail Match (${check.bank || 'Bre-B'})` },
                                    client,
                                    userStates,
                                    null,
                                    match.id
                                );

                                if (validationResult.success) {
                                    // Notificar al grupo administrativo del éxito automático
                                    try {
                                        const groupChat = await client.getChatById(GROUP_ID);
                                        if (false && groupChat) {
                                            let successMsg = `✅ *PAGO AUTO-VALIDADO* (@${userId.replace('@c.us', '')})\n` +
                                                `Monto: $${check.amount}\n` +
                                                `Banco: ${check.bank || 'Bre-B'}\n`;

                                            if (leftoverAmount > 0) {
                                                const originalPrice = check.amount - leftoverAmount;
                                                successMsg += `💰 *EXCEDENTE DETECTADO:* Se cobraron $${check.amount} pero el total era $${originalPrice}. Quedó un saldo a favor de *$${leftoverAmount}* COP.\n`;
                                            }

                                            successMsg += `Asunto: ${match.subject}\n` +
                                                `ID Gmail: ${match.id}\n\n` +
                                                `El bot ya entregó el servicio automáticamente.`;
                                            await groupChat.sendMessage(successMsg);
                                        }
                                    } catch (e) { }
                                    return;
                                }
                            }
                        }
                    } catch (autoErr) {
                        console.error(`[PAYMENT AUTO-VALIDATE] ❌ Error crítico durante validación automática para ${userId}:`, autoErr.message);
                    }
                }

                // Si no hubo match automático, seguimos con el flujo manual
                // Revisamos si en el carrito (items) hay un servicio de Netflix
                let hasNetflix = false;
                if (stateData.items && Array.isArray(stateData.items)) {
                    hasNetflix = stateData.items.some(item => {
                        const name = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "").toLowerCase();
                        // Solo pedir operador si es Netflix pero NO es Extra
                        return name.includes('netflix') && !name.includes('extra');
                    });
                }

                if (hasNetflix && !stateData.isRenewal) {
                    await message.reply("🤖 ¡Gracias! He recibido tu comprobante de pago. 🎉\n\nListo, me confirmas por favor localidad o municipio donde se va a usar y operador de internet\n\nEj. suba-movistar");

                    userStates.set(userId, {
                        ...stateData,
                        state: 'awaiting_netflix_operator_post_payment',
                        paymentMethod: check.bank || 'Transferencia',
                        checkAmount: check.amount,
                        leftoverAmount: leftoverAmount
                    });

                    return;
                }

                userStates.set(userId, {
                    ...stateData,
                    state: 'awaiting_payment_confirmation',
                    paymentMethod: check.bank || 'Transferencia',
                    checkAmount: check.amount,
                    leftoverAmount: leftoverAmount
                });

                globalLastPaymentUserId = userId; // Guardamos en memoria para que el admin solo diga "@bot confirmar"

                const AUTO_KEYS = ['0087387259'];
                const normalizeKey = (k) => (k || '').replace(/[\s\-\.]/g, '');
                const rawKey = normalizeKey(check.destinationKey);
                const rawName = (check.destinationName || '').toUpperCase();
                const QR_NAMES = ['SHEERIT', 'ESTEBAN AVILA'];
                const isQrMatch = QR_NAMES.some(n => rawName.includes(n));
                const isAutoKey = rawKey && AUTO_KEYS.some(vk => rawKey.includes(vk) || vk.includes(rawKey));

                const isAutoMethod = isAutoKey || isQrMatch || (check.bank && ['bancolombia', 'bre-b', 'breb'].includes(check.bank.toLowerCase()));

                let methodUsedName = 'el medio de pago';
                if (isAutoKey) methodUsedName = 'el pago mediante Llave Bre-V';
                else if (isQrMatch) methodUsedName = 'el pago mediante QR Negocios';
                else if (check.bank && ['bancolombia', 'bre-b', 'breb'].includes(check.bank.toLowerCase())) {
                    methodUsedName = `el pago mediante ${check.bank}`;
                }

                const notaTexto = isAutoMethod
                    ? `Aunque ${methodUsedName} cuenta con validación automática, no logramos detectar la notificación de tu transferencia en nuestro sistema (a veces el banco tarda en notificar). Por esta razón, nuestro equipo validará tu comprobante de forma manual. Esto puede demorar un poco más. ⏳`
                    : `Como enviaste el comprobante por un medio manual (Nequi/Daviplata tradicional), nuestro equipo humano tendrá que verificarlo de forma manual. Esto puede demorar un poco más. ⏳`;

                const replyText = `🤖 He recibido tu comprobante de pago. ¡Muchas gracias! 🎉

⚠️ *Nota:* ${notaTexto}

💡 *Recomendación para la próxima:* Si realizas tus transferencias utilizando nuestro *QR Negocios* o la *Llave Bre-V / Bre-B*, el bot validará tu pago automáticamente y te entregará el servicio en segundos sin esperar por humanos. ⚡🤖

Un asesor ya está notificado y revisará tu transferencia lo más pronto posible. ¡Gracias por tu paciencia! 😊`;

                await message.reply(replyText);

                // Si el comprobante era de un método automático (Bre-V, QR, Bancolombia),
                // programar reintentos en segundo plano (15s, 35s, 60s) por si el correo del banco viene con retraso
                if (isAutoMethod && check.amount) {
                    const retryDelays = [15000, 35000, 60000];
                    retryDelays.forEach(delayMs => {
                        setTimeout(async () => {
                            try {
                                const currSt = userStates.get(userId);
                                if (!currSt || currSt.state !== 'awaiting_payment_confirmation') return;

                                const { findMatchingEmailPayment } = require('./gmailService');
                                const retryRes = await findMatchingEmailPayment(check.amount, check.bank || 'bancolombia');
                                if (retryRes && retryRes.success && retryRes.match) {
                                    console.log(`[PAYMENT AUTO-RETRY] 🎉 ¡Pago encontrado en Gmail tras ${delayMs/1000}s para ${userId}!`);
                                    const valRes = await executePaymentValidation(
                                        userId,
                                        { ...stateData, total: check.amount, leftoverAmount: leftoverAmount, paymentMethod: `Gmail Match (${check.bank || 'Bre-B'})` },
                                        client,
                                        userStates,
                                        null,
                                        retryRes.match.id
                                    );
                                    if (valRes && valRes.success) {
                                        await safeSend(null, `🤖 ¡Excelente noticia! 🎉 Tu pago de *$${check.amount.toLocaleString('es-CO')}* COP acaba de ser verificado con éxito por el banco. Procedo a renovar tu cuenta. ¡Muchas gracias por tu compra! 😊`, originalChatJid || userId, client);
                                        try {
                                            const groupChat = await client.getChatById(GROUP_ID);
                                            if (groupChat) {
                                                const displayTarget = realPhone || userId.replace('@c.us', '').replace('@lid', '');
                                                await groupChat.sendMessage(`✅ *PAGO AUTO-VALIDADO TRAS REINTENTO* (@${displayTarget})\nMonto: $${check.amount}\nBanco: ${check.bank || 'Bre-B'}\nGmail ID: ${retryRes.match.id}\nServicio entregado/renovado automáticamente.`);
                                            }
                                        } catch (e) {}
                                    }
                                }
                            } catch (rErr) {
                                console.error(`[PAYMENT AUTO-RETRY Error ${delayMs/1000}s]:`, rErr.message);
                            }
                        }, delayMs);
                    });
                }

                // Notificar al grupo administrativo
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        const displayTarget = realPhone || userId.replace('@c.us', '').replace('@lid', '');
                        let adminMsg = `🚨 *COMPROBANTE DETECTADO* (@${displayTarget})\n` +
                            `Banco: ${check.bank || 'No identificado'}\n` +
                            `Monto: ${check.amount || 'No legible'}\n\n`;

                        if (leftoverAmount > 0) {
                            adminMsg += `💰 *EXCEDENTE DETECTADO:* Sobran *$${leftoverAmount.toLocaleString('es-CO')}* COP.\n\n`;
                        }

                        adminMsg += `Valida el pago y confirma usando:\n*confirmar ${displayTarget}*`;

                        await groupChat.sendMessage(adminMsg);
                        const mediaToForward = await message.downloadMedia();
                        await groupChat.sendMessage(mediaToForward);
                    }

                    if (stateData.isRenewal && stateData.items && stateData.items.length > 0) {
                        const { updateExcelData } = require('./apiService');
                        for (const item of stateData.items) {
                            if (item._rowNumber) {
                                try {
                                    await updateExcelData(item._rowNumber, { observaciones: "⚠️ REVISAR COMPROBANTE EN CHAT" });
                                    console.log(`[PAYMENT] Excel actualizado con nota de revisión para la fila ${item._rowNumber}`);
                                } catch (err) {
                                    console.error("Error actualizando observaciones en Excel para comprobante:", err.message);
                                }
                            }
                        }
                    }

                } catch (adminErr) {
                    console.error("Error notificando al grupo sobre pago interceptado:", adminErr.message);
                }
            }
        }

        // --- INTERCEPTOR DE TEXTO PARA PAGOS (Sin media) ---
        // Si el usuario dice algo como "ya pagué" o "aquí el soporte" sin la imagen aún
        const checkText = await isPaymentReceipt(combinedBody, `Contexto: El usuario está enviando un mensaje de texto. Evalúa si confirma un pago.`);
        if (checkText.isReceipt) {
            console.log(`[PAYMENT INTERCEPTOR] 📝 Texto de pago detectado para @${userId}`);

            let replyText = "🤖 ¡Entendido! Quedo a la espera de la imagen de tu comprobante para que un asesor pueda validarlo rápidamente. 😊";

            // Solo preguntar operador si es Netflix
            const state = userStates.get(userId);
            const isNetflix = state && state.items && state.items.some(it => (it.Streaming || "").toLowerCase().includes('netflix'));
            if (isNetflix) {
                replyText += "\n\nPor cierto, como es para Netflix, ¿podrías decirme tu localidad y operador de internet? Esto nos ayuda a asegurar la estabilidad de tu cuenta. 🏠";
            }

            await message.reply(replyText);
            userStates.set(userId, { ...state, state: 'awaiting_payment_confirmation' });
            return;
        }
    }

    // Si no hay media, o no fue interceptado como pago, evaluamos el texto combinado
    const inputToUse = combinedBody || message.body || "";

    // --- CONTEXTO DE CLIENTE ---
    const phoneNumber = (realPhone || userId).replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
    try {
        userAccounts = await getAccountsByPhone(realPhone || phoneNumber, foundName);
        if (userAccounts && userAccounts.length > 0) {
            const accPhone = (userAccounts[0].numero || userAccounts[0].Numero || userAccounts[0].whatsapp || userAccounts[0].WhatsApp || '').toString().replace(/\D/g, '');
            if (accPhone && accPhone.length >= 10 && accPhone.length <= 13) {
                realPhone = accPhone;
            }
        }
    } catch (e) {
        console.warn("[Context] Error fetching accounts for AI context:", e.message);
    }

    const getDisplayPhone = (targetAccount = null) => {
        if (targetAccount) {
            const accPhone = (targetAccount.numero || targetAccount.Numero || targetAccount.whatsapp || targetAccount.WhatsApp || '').toString().replace(/\D/g, '');
            if (accPhone && accPhone.length >= 10 && accPhone.length <= 13) return accPhone;
        }
        if (userAccounts && userAccounts.length > 0) {
            const accPhone = (userAccounts[0].numero || userAccounts[0].Numero || userAccounts[0].whatsapp || userAccounts[0].WhatsApp || '').toString().replace(/\D/g, '');
            if (accPhone && accPhone.length >= 10 && accPhone.length <= 13) return accPhone;
        }
        if (realPhone && realPhone.length >= 10 && realPhone.length <= 13 && !realPhone.includes('@')) {
            return realPhone;
        }
        return (phoneNumber || userId).replace('@c.us', '').replace('@lid', '');
    };

    // 2. DETECCIÓN DE INTENCIÓN Y NOMBRE (Global para todos los estados)
    const hist = await getChatHistoryText(message, 25);
    const messageAgeMinutes = Math.floor((Date.now() / 1000 - message.timestamp) / 60);

    // --- INTERCEPTOR RÁPIDO PARA CLAVE/CONTRASEÑA/PERFIL ---
    const inputLower = (inputToUse || "").toLowerCase().trim();
    
    const isPasswordQuery = [
        'no entra la clave', 'no entra la contraseña', 'no me sirve la clave', 'no me sirve la contraseña',
        'cual es la clave', 'cuál es la clave', 'cual es la contraseña', 'cuál es la contraseña',
        'olvide la clave', 'olvidé la clave', 'olvide la contraseña', 'olvidé la contraseña',
        'contraseña incorrecta', 'contraseñas incorrectas', 'clave incorrecta', 'claves incorrectas',
        'contraseña invalida', 'contraseña inválida', 'clave invalida', 'clave inválida',
        'error de contraseña', 'error de clave', 'no da la clave', 'no da la contraseña'
    ].some(kw => inputLower.includes(kw));

    if (isPasswordQuery) {
        console.log(`[Fast-Track Password] Interceptado reporte de clave/contraseña para @${userId}`);
        const { processCheckCredentials } = require('./billingService');
        await processCheckCredentials(userId, client, inputToUse, "", userStates);
        return;
    }

    const isProfileQuery = [
        'no hay perfil', 'no hay perfiles', 'no está mi perfil', 'no esta mi perfil', 'no sale mi perfil',
        'no sale mi nombre', 'no encuentro mi perfil', 'a cual puedo ingresar', 'a cuál puedo ingresar',
        'a que perfil entro', 'a qué perfil entro', 'cuál es mi perfil', 'cual es mi perfil', 'en cual perfil entro',
        'cual perfil', 'cuál perfil'
    ].some(kw => inputLower.includes(kw));

    if (isProfileQuery) {
        console.log(`[Fast-Track Profile Query] Interceptada duda de perfil por texto para @${userId}`);
        await message.reply(`🤖 ¡Hola! En tu pantalla puedes seleccionar la opción **"Añadir perfil"** (o el botón **"+"**). 📺\n\n` +
            `Crea tu perfil colocándole **tu nombre** para que tengas tu propio espacio y lista personal. 😊\n\n` +
            `⚠️ *Recuerda:* No modifiques los perfiles de otros usuarios para evitar confusiones.`);
        return;
    }

    // Construimos el contexto del lote actual para que la IA entienda la ráfaga de mensajes
    const batchContext = messages.length > 1
        ? `\n[MENSAJES EN ESTA RÁFAGA RECIENTE]:\n${messages.map(m => `- ${m.body || '[Media]'}`).join('\n')}\n`
        : "";

    // Añadimos el contexto de antigüedad al historial para que la IA se disculpe si es necesario
    // --- COOLDOWN DE RESPUESTAS (Anti-Burst) ---
    const now = Date.now();
    const cleanDigits = userId.replace(/\D/g, '');
    const lastResp = Math.max(
        lastResponseTimestamps.get(userId) || 0,
        cleanDigits ? (lastResponseTimestamps.get(cleanDigits) || 0) : 0,
        originalChatJid ? (lastResponseTimestamps.get(originalChatJid) || 0) : 0
    );
    if (!isFromAdmin && (now - lastResp < RESPONSE_COOLDOWN)) {
        console.log(`[Cooldown] Ignorando ráfaga duplicada para ${userId} (${now - lastResp}ms desde última respuesta)`);
        return;
    }
    lastResponseTimestamps.set(userId, now);
    if (cleanDigits) lastResponseTimestamps.set(cleanDigits, now);
    if (originalChatJid) lastResponseTimestamps.set(originalChatJid, now);

    const timedHist = `[ESTE MENSAJE LLEGÓ HACE ${messageAgeMinutes} MINUTOS]\n${hist}`;
    const detection = await detectInitialIntent(inputToUse, timedHist, (mediaData && mediaData.length > 0) ? mediaData[0] : null, userAccounts);

    // --- OCR/IMAGE CODE REQUEST INTERCEPTOR via Gemini ---
    let isCodeRequestFromImage = false;
    const imageMediaData = (mediaData || []).filter(m => m.mimeType && m.mimeType.startsWith('image/'));
    if (detection && imageMediaData.length > 0) {
        const explanationLower = (detection.explanation || "").toLowerCase();
        const mediaDescLower = (detection.mediaDescription || "").toLowerCase();
        const extractedDetailsLower = (detection.extractedDetails || "").toLowerCase();
        const bodyLower = inputToUse.toLowerCase();
        const fullOcrContext = `${bodyLower} ${explanationLower} ${mediaDescLower} ${extractedDetailsLower}`;

        const isIncorrectPassword = [
            'incorrecta', 'incorrecto', 'no son correctos', 'contraseña incorrecta', 'clave incorrecta', 'credenciales incorrectas',
            'datos de acceso', 'datos anteriores', 'clave antigua', 'contraseña antigua', 'no me permite el ingreso', 'no permite el ingreso'
        ].some(kw => explanationLower.includes(kw) || bodyLower.includes(kw));

        const wantsImgCode = [
            'hogar', 'dispositivo', 'código', 'codigo', '2fa', 'authenticator', 'autenticación',
            'televisor', 'tv', 'google authenticator', 'código de 6 dígitos', '6-digit', 'authenticating',
            'no forma parte', 'hogar con netflix', 'tu tv no forma parte', 'enviamos a tu email', 'ingresa el código',
            'código vence en 15', 'codigo vence en 15', 'solicita el reenvio', 'solicita el reenvío',
            'ver temporalmente', 'si estás de viaje', 'si estas de viaje', 'fuera de casa', 'entendimos mal',
            'obtener un código para ver netflix temporalmente', 'crea tu propia cuenta para disfrutar de netflix'
        ].some(kw => fullOcrContext.includes(kw));

        const isProfileSelectScreen = [
            'elige tu perfil', 'quién está viendo', 'quien esta viendo', 'quién va a ver', 'quien va a ver',
            'no sale mi nombre', 'cuál perfil', 'cual perfil', 'cuál es mi perfil', 'cual es mi perfil', 'mi nombre'
        ].some(kw => fullOcrContext.includes(kw));

        if (isProfileSelectScreen) {
            console.log(`[BOT MEDIA OCR PROFILE SELECT SCREEN] Se detectó pantalla de selección de perfil en @${userId}.`);
            await message.reply(`🤖 ¡Veo la pantalla de perfiles en tu dispositivo! 📺\n\n` +
                `💡 *Instrucciones para ingresar a tu perfil:*\n\n` +
                `1. Si no ves un perfil con tu nombre, selecciona la opción **"Añadir perfil"** (o botón **"+"**).\n` +
                `2. Asígnale a tu nuevo perfil **tu nombre exacto** (tal como estás registrado con nosotros) para llevar el control de tu suscripción. 😊\n\n` +
                `⚠️ *Importante:* Por favor **no tomes ni modifiques los perfiles de otros usuarios** (como perfiles que ya tengan otros nombres creados).\n\n` +
                `_Si la plataforma no te deja crear un perfil nuevo porque alcanzó el límite máximo de perfiles, avísanos y te reasignamos una cuenta de inmediato._`);
            return;
        }

        if (wantsImgCode && !isIncorrectPassword) {
            const isOptionsScreen = [
                'entendimos mal', 'varias opciones', 'actualizar hogar con netflix', 'estoy de viaje',
                'no forma parte del hogar', 'tu tv no forma parte', 'no forma parte', 'ver temporalmente',
                'si estás de viaje', 'si estas de viaje', 'fuera de casa', 'código para ver netflix temporalmente',
                'crea tu propia cuenta para disfrutar de netflix'
            ].some(kw => fullOcrContext.includes(kw));

            if (isOptionsScreen) {
                console.log(`[BOT MEDIA OCR OPTIONS SCREEN] Se detectó pantalla de opciones/hogar de Netflix/TV en @${userId}. Guiando al usuario.`);
                const phoneDigits = userId.replace(/\D/g, '');
                const phoneParam = phoneDigits && phoneDigits.length >= 10 && phoneDigits.length <= 13 ? `?tel=${phoneDigits}` : '';
                await message.reply(`🤖 ¡Hola! Veo la pantalla de confirmación de Netflix en tu TV (no es que la sesión se haya cerrado ni que la clave esté mal). 📺\n\n` +
                    `👉 *Para activarlo de inmediato en tu televisor:*\n\n` +
                    `1️⃣ Con el control remoto de tu TV, selecciona el botón **"Ver temporalmente"** (o *"Actualizar Hogar con Netflix"*).\n` +
                    `2️⃣ En la siguiente pantalla selecciona **"Enviar correo"** (o *"Enviar código"*).\n` +
                    `3️⃣ En cuanto le des enviar, escribe aquí la palabra *código* (o entra a https://sheerit.co/actualizar${phoneParam}) y el sistema te entregará el código de 4 dígitos para que sigas viendo sin problema. 🚀`);
                return;
            }

            isCodeRequestFromImage = true;
            console.log(`[BOT MEDIA OCR DETECTED IN FLOW] Gemini detected code request in image/explanation. Routing to code generator.`);
        }
    }

    if (isCodeRequestFromImage) {
        try {
            if (userAccounts.length > 0) {
                let targetAccount = null;
                const platformsSupported = ['netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'gpt', 'chatgpt', 'youtube', 'spotify'];

                // 0. Si la imagen contiene un correo explícito (ej: yulisadiagama@gmail.com), buscar primero por ese correo
                const textForDetection = (inputToUse + " " + (detection.explanation || "") + " " + (detection.mediaDescription || "")).toLowerCase();
                const emailInImage = textForDetection.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                if (emailInImage) {
                    const extractedMail = emailInImage[0].trim();
                    targetAccount = userAccounts.find(c => (c.correo || "").toLowerCase().trim() === extractedMail);
                    if (targetAccount) {
                        console.log(`[BOT MEDIA OCR MATCH EMAIL] Cuenta encontrada por correo extraído de la imagen: ${extractedMail}`);
                    }
                }

                // 1. Filtrar todas las cuentas de la plataforma solicitada
                if (!targetAccount) {
                    const matchedPlatform = platformsSupported.find(p => textForDetection.includes(p));
                    if (matchedPlatform) {
                        const matchingAccounts = userAccounts.filter(c => {
                            const streamingName = (c.Streaming || "").toLowerCase();
                            if (matchedPlatform === 'hbo' || matchedPlatform === 'max') {
                                return streamingName.includes('hbo') || streamingName.includes('max');
                            }
                            if (matchedPlatform === 'amazon' || matchedPlatform === 'prime') {
                                return streamingName.includes('amazon') || streamingName.includes('prime');
                            }
                            return streamingName.includes(matchedPlatform);
                        });

                        if (matchingAccounts.length === 1) {
                            targetAccount = matchingAccounts[0];
                        } else if (matchingAccounts.length > 1) {
                            // Si el usuario mencionó parte del correo en el mensaje o imagen (ej: sheerit6)
                            const specificMatch = matchingAccounts.find(c => {
                                const mail = (c.correo || "").toLowerCase().trim();
                                const mailUser = mail.split('@')[0];
                                return textForDetection.includes(mail) || (mailUser.length > 3 && textForDetection.includes(mailUser));
                            });

                            if (specificMatch) {
                                targetAccount = specificMatch;
                            } else {
                                let msg = `🤖 Veo que tienes registradas múltiples cuentas activas de *${matchedPlatform.toUpperCase()}*. ¿De cuál de ellas necesitas el código?\n\n`;
                                matchingAccounts.forEach((acc, idx) => {
                                    const email = (acc.correo || "").trim().toLowerCase();
                                    const profile = acc['pin perfil'] || acc['Nombre'] || "";
                                    const profileStr = profile ? ` (Perfil: ${profile})` : "";
                                    msg += `${idx + 1} - ${email}${profileStr}\n`;
                                });
                                msg += `\n*Responde únicamente con el número de la opción que deseas.* 📲`;

                                await message.reply(msg);

                                userStates.set(userId, {
                                    state: 'awaiting_code_account_selection',
                                    candidates: matchingAccounts,
                                    timestamp: Date.now(),
                                    nombre: foundName
                                });
                                return;
                            }
                        }
                    }
                }

                // 2. Si no hay coincidencia por plataforma, pero solo tiene 1 cuenta en total, usar esa
                if (!targetAccount && userAccounts.length === 1) {
                    targetAccount = userAccounts[0];
                }

                // 3. Si tiene varias cuentas de plataformas diferentes y no especificó cuál
                if (!targetAccount && userAccounts.length > 1) {
                    let msg = `🤖 Veo que tienes registradas múltiples cuentas activas. ¿De cuál de ellas necesitas el código de verificación?\n\n`;
                    userAccounts.forEach((acc, idx) => {
                        const platName = (acc.Streaming || "").toUpperCase();
                        const email = (acc.correo || "").trim().toLowerCase();
                        const profile = acc['pin perfil'] || acc['Nombre'] || "";
                        const profileStr = profile ? ` (Perfil: ${profile})` : "";
                        msg += `${idx + 1} - *${platName}* - ${email}${profileStr}\n`;
                    });
                    msg += `\n*Responde únicamente con el número de la opción que deseas.* 📲`;

                    await message.reply(msg);

                    userStates.set(userId, {
                        state: 'awaiting_code_account_selection',
                        candidates: userAccounts,
                        timestamp: Date.now(),
                        nombre: foundName
                    });
                    return;
                }

                if (targetAccount) {
                    await processAccountVerificationCode(message, userId, targetAccount, phoneNumber, client, userStates);
                    return;
                }
            }
        } catch (e) {
            console.error("Error en interceptor OCR de códigos:", e);
        }
    }

    // --- DETECCIÓN INTELIGENTE DE FALLO PREMATURO (Solo para imágenes/mensajes con errores reales en la plataforma correspondiente) ---
    if (detection && mediaData && mediaData.length > 0 && !isCodeRequestFromImage) {
        const explanationLower = (detection.explanation || "").toLowerCase();
        const bodyLower = inputToUse.toLowerCase();
        const errorKeywords = ['falla', 'error', 'funciona', 'caido', 'suspendid', 'problema', 'sale asi', 'sacó', 'mira lo que', 'no deja', 'qué pasó', 'que paso', 'bloquead', 'no sirve'];
        const hasErrorText = errorKeywords.some(k => explanationLower.includes(k) || bodyLower.includes(k));

        if (hasErrorText) {
            const { isSamePlatformFamily } = require('./salesRegistryService');
            const { getTodayInBogota, getJsDateFromExcel } = require('./apiService');

            const fullText = explanationLower + " " + bodyLower;
            const activeAccountWithProblem = userAccounts.find(acc => {
                const streamName = (acc.Streaming || "").toLowerCase();
                const expDate = getJsDateFromExcel(acc.deben);
                const today = getTodayInBogota();
                const isActive = expDate && expDate > today;
                if (!isActive) return false;

                return fullText.includes(streamName) || isSamePlatformFamily(acc.Streaming, detection.detectedPlatform || "");
            });

            if (activeAccountWithProblem) {
                const expD = getJsDateFromExcel(activeAccountWithProblem.deben);
                const dateStr = expD ? expD.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : activeAccountWithProblem.deben;
                console.log(`[FAULT DETECTOR] 🚨 Posible fallo prematuro detectado para @${userId} en ${activeAccountWithProblem.Streaming}`);
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        const clientTag = getDisplayPhone(activeAccountWithProblem);
                        const adminMsg = `🚨 *POSIBLE FALLO PREMATURO* (@${clientTag})\n` +
                            `El cliente reporta un error pero su cuenta de *${activeAccountWithProblem.Streaming}* vence hasta el *${dateStr}*.\n\n` +
                            `Favor revisar el chat de inmediato.`;
                        await groupChat.sendMessage(adminMsg);
                        if (message.hasMedia) {
                            const mediaToForward = await message.downloadMedia();
                            await groupChat.sendMessage(mediaToForward);
                        }
                    }
                } catch (e) { }
            }
        }
    }

    // 3. IDENTIDAD TERCERO: IA revisando historial o mensaje actual
    if ((!foundName || foundName === 'Cliente') && detection.userName) {
        foundName = detection.userName;
        console.log(`[AI Discovery] Nombre hallado para @${userId.replace('@c.us', '')}: ${foundName}`);

        // Actualizar estado en memoria si ya existe
        if (currentStateData) {
            userStates.set(userId, { ...currentStateData, nombre: foundName });
        }
    }

    // --- NUEVO: INTERCEPTAR SUBINTENCIONES / FLUJOS DE PARÉNTESIS ---
    if (detection.intent === 'duda_contexto') {
        console.log(`[Sub-Intent / Parentesis] Duda de contexto detectada para @${userId.replace('@c.us', '')} en estado '${currentState || 'undefined'}'. Respondiendo con fallback sin alterar estado.`);
        const fallbackResult = await generateEmpatheticFallback(inputToUse, isMedia, hist, (mediaData && mediaData.length > 0) ? mediaData[0] : null, userAccounts, userId, userStates);
        if (typeof fallbackResult === 'string') {
            await safeReply(message, fallbackResult, userId);
        } else {
            await safeReply(message, fallbackResult.replyMessage, userId);
            if (fallbackResult.needsEscalation) {
                userStates.set(userId, { ...currentStateData, state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
            }
        }
        return;
    }

    // 4.6 BREAKOUT DE FLUJOS (Si el usuario cambia de tema bruscamente o está frustrado)
    const flowsRequiringBreakout = ['selecting_plans', 'awaiting_purchase_platforms', 'adding_platform', 'awaiting_payment_method', 'awaiting_name_for_contact', 'awaiting_churn_reason'];

    // Pivotar si detecta una plataforma distinta a la que estamos configurando
    let isPivottingPlatform = false;
    if (currentState === 'selecting_plans' && currentStateData.selected && currentStateData.currentIndex !== undefined) {
        const currentPlatformName = currentStateData.selected[currentStateData.currentIndex].platform.name.toLowerCase();
        if (detection.detectedPlatform && !currentPlatformName.includes(detection.detectedPlatform.toLowerCase())) {
            isPivottingPlatform = true;
            console.log(`[Flow Breakout] Pivotando plataforma: ${currentPlatformName} -> ${detection.detectedPlatform}`);
        }
    } else if (currentState === 'awaiting_payment_method' && currentStateData.items && currentStateData.items.length > 0) {
        const currentPlatformName = (currentStateData.items[0].Streaming || currentStateData.items[0].platform?.name || "").toLowerCase();
        if (detection.detectedPlatform && !currentPlatformName.includes(detection.detectedPlatform.toLowerCase()) && detection.intent === 'comprar') {
            console.log(`[Flow Breakout] Pivotando de renovación a compra de nueva plataforma: ${currentPlatformName} -> ${detection.detectedPlatform}`);
            userStates.delete(userId);
            currentState = null;
            currentStateData = null;
        }
    }

    const isSingleDigit = /^\d+$/.test(inputToUse.trim());
    const statesExpectingNumbers = ['selecting_plans', 'adding_platform', 'awaiting_code_account_selection', 'awaiting_payment_renewal_confirmation', 'awaiting_payment_multi_renewal_confirmation', 'awaiting_payment_autofill_confirmation'];
    const isMenuDigit = ['1', '2', '3', '4', '5'].includes(inputToUse.trim());
    let isForcedMenuBreakout = false;
    if (isMenuDigit && currentState && !statesExpectingNumbers.includes(currentState)) {
        isForcedMenuBreakout = true;
    }

    const isChangingTopic = detection.intent &&
        !['desconocido', 'comprar', 'pagar', 'cierre', 'renovar', 'duda_contexto'].includes(detection.intent) &&
        !(isSingleDigit && statesExpectingNumbers.includes(currentState));
    const isVeryFrustrated = detection.frustrationLevel >= 7;

    // NUEVO breakout específico para awaiting_churn_reason cuando el usuario explícitamente NO quiere cancelar o quiere comprar/otra acción
    let isChurnRefusal = false;
    let isChurnSwitchToPurchase = false;
    if (currentState === 'awaiting_churn_reason') {
        const lowerBody = inputToUse.toLowerCase();
        const hasRefusalText = lowerBody.includes('no quiero cancelar') ||
            lowerBody.includes('no cancel') ||
            lowerBody.includes('no voy a cancelar') ||
            lowerBody.includes('me arrepenti') ||
            lowerBody.includes('me arrepentí') ||
            lowerBody.includes('error') ||
            lowerBody.includes('solo preguntaba') ||
            lowerBody.includes('solo estoy preguntando') ||
            lowerBody.includes('cuanto me saldria') ||
            lowerBody.includes('cuánto me saldría');
        const isExplicitOtherAction = lowerBody.startsWith('quiero comprar') ||
            lowerBody.startsWith('quiero renovar') ||
            lowerBody.startsWith('comprar ') ||
            lowerBody.startsWith('renovar ');

        // Detectar si el usuario quiere comprar otro servicio, cambiar de plataforma o preguntar por otra
        const isPurchaseOrOtherIntent = ['comprar', 'pagar', 'renovar', 'soporte'].includes(detection.intent) ||
            detection.detectedPlatform ||
            lowerBody.includes('quiero') ||
            lowerBody.includes('tienen') ||
            lowerBody.includes('tiene') ||
            lowerBody.includes('precio') ||
            lowerBody.includes('venden') ||
            lowerBody.includes('cambiar') ||
            lowerBody.includes('amazon') ||
            lowerBody.includes('disney') ||
            lowerBody.includes('spotify') ||
            lowerBody.includes('youtube') ||
            lowerBody.includes('hbo') ||
            lowerBody.includes('max') ||
            lowerBody.includes('apple') ||
            lowerBody.includes('paramount') ||
            lowerBody.includes('crunchyroll');

        if (hasRefusalText || isExplicitOtherAction) {
            isChurnRefusal = true;
            console.log(`[Churn Breakout] El cliente rechaza la cancelación o solicita otra acción explícita. Intent: ${detection.intent}, Texto: "${inputToUse}"`);
        } else if (isPurchaseOrOtherIntent) {
            isChurnSwitchToPurchase = true;
            console.log(`[Churn Breakout] El cliente en awaiting_churn_reason quiere comprar/cambiar de servicio. Intent: ${detection.intent}, Plataforma: ${detection.detectedPlatform}, Texto: "${inputToUse}"`);
        }
    }

    const paymentConfirmationStates = ['awaiting_payment_renewal_confirmation', 'awaiting_payment_multi_renewal_confirmation', 'awaiting_payment_autofill_confirmation'];
    let isNumericSelectionBreakout = false;
    if (statesExpectingNumbers.includes(currentState) && !isSingleDigit && !paymentConfirmationStates.includes(currentState)) {
        if (['comprar', 'pagar', 'renovar', 'soporte'].includes(detection.intent)) {
            isNumericSelectionBreakout = true;
            console.log(`[Flow Breakout] Rompiendo selección numérica '${currentState}' por intent de texto: ${detection.intent}`);
        }
    }

    if ((flowsRequiringBreakout.includes(currentState) && (isChangingTopic || isVeryFrustrated || isPivottingPlatform || isForcedMenuBreakout)) || isChurnRefusal || isChurnSwitchToPurchase || isNumericSelectionBreakout) {
        console.log(`[Flow Breakout] Rompiendo flujo '${currentState}' para @${userId}. Razón: ${isChurnRefusal ? 'Rechazo de cancelación' : (isChurnSwitchToPurchase ? 'Cambio a compra/nuevo servicio' : (isNumericSelectionBreakout ? 'Breakout selección numérica' : (isForcedMenuBreakout ? 'Fuerza de menú numérico' : (isPivottingPlatform ? 'Pivot plataforma' : (isChangingTopic ? 'Cambio de tema (' + detection.intent + ')' : 'Alta frustración')))))}`);

        if (isVeryFrustrated) {
            userStates.set(userId, { ...currentStateData, state: 'waiting_human', waitingCount: 1, waiting_human_mode: 'bot' });
            await message.reply("🤖 Hola, he detectado que necesitas soporte personalizado. Ya le dejé un recordatorio a un asesor humano para que revise tu caso personalmente. Recuerda que de forma automática puedo ayudarte a **vender cuentas, revisar tus credenciales, registrar pagos y extraer códigos de acceso (2FA/Hogar/TV de Netflix, Disney+, Max, etc. escribiendo 'código de ...')**. En un momento te atenderemos. ¡Gracias por tu paciencia! 😊");
            return;
        }

        if (isChurnRefusal && currentStateData.rowNumber) {
            // Limpiar el preventivo "cortar (bot ...)" que escribimos en Excel
            const { updateExcelData } = require('./apiService');
            updateExcelData(currentStateData.rowNumber, { "observaciones": "" })
                .then(() => console.log(`[Churn Breakout] Observaciones limpiadas en fila ${currentStateData.rowNumber} (Rechazo de cancelación)`))
                .catch(e => console.error("[Churn Breakout] Error al limpiar observaciones:", e.message));

            await message.reply("🤖 ¡Ah, entiendo perfectamente! Qué alegría que quieras continuar con nosotros. Permíteme ayudarte con eso...");
        } else if (isChurnSwitchToPurchase) {
            // El cliente efectivamente cancela o pausa la cuenta anterior, pero desea comprar o cambiar a otra plataforma
            console.log(`[Churn Breakout] Cliente pasa de cancelar a comprar/consultar: ${detection.detectedPlatform || inputToUse}`);
            userStates.delete(userId);
        }

        // Si el usuario simplemente cambió de tema o plataforma
        // Limpiamos el estado actual para que el mensaje sea procesado por la lógica global (case undefined)
        currentState = undefined;
        currentStateData = undefined;
    }

    switch (currentState) {
        case undefined:
            const cleanInput = inputToUse.trim();
            if (['1', '2', '3', '4', '5'].includes(cleanInput)) {
                userStates.set(userId, { state: 'main_menu' });
                await handleMainMenuSelection(message, userId, detection, message.hasMedia, (mediaData && mediaData.length > 0) ? mediaData[0] : null);
                return;
            }

            // 3. IDENTIDAD TERCERO movido arriba

            // Determinar si el nombre es completo según la IA o si ya lo teníamos validado
            const nameIsComplete = detection.isNameComplete || false;

            // 4. RECUPERACIÓN DE ESTADO (Stateless Recovery)
            if (detection.recoveredState) {
                if (detection.recoveredState === 'waiting_human') {
                    try {
                        const chat = await message.getChat();
                        const recentMsgs = await chat.fetchMessages({ limit: 15 });
                        const lastHumanMsg = [...recentMsgs].reverse().find(m => m.fromMe && m.body && !m.body.includes('🤖'));
                        if (lastHumanMsg) {
                            const lastHumanTimeMs = lastHumanMsg.timestamp * 1000;
                            const timeSinceLastHumanMs = Date.now() - lastHumanTimeMs;
                            const hoursSinceLastHuman = timeSinceLastHumanMs / (1000 * 60 * 60);
                            console.log(`[Flow Recovery Debug] Último mensaje humano detectado hace ${hoursSinceLastHuman.toFixed(2)} horas.`);
                            if (hoursSinceLastHuman > 2) {
                                console.log(`[Flow Recovery] 🕒 El último mensaje del asesor fue hace más de 2 horas. Ignorando 'waiting_human' recuperado por la IA.`);
                                detection.recoveredState = null;
                            }
                        } else {
                            console.log(`[Flow Recovery Debug] No se encontró mensaje humano previo en los últimos 15 mensajes. Ignorando 'waiting_human'.`);
                            detection.recoveredState = null;
                        }
                    } catch (e) {
                        console.error("[Flow Recovery Error] Error al verificar último mensaje humano:", e.message);
                    }
                }
            }

            if (detection.recoveredState) {
                console.log(`[Flow Recovery] Recuperando estado: ${detection.recoveredState} para @${userId.replace('@c.us', '')}`);
                const metadata = detection.metadata || {};
                userStates.set(userId, { state: detection.recoveredState, nombre: foundName, ...metadata });

                if (detection.recoveredState === 'waiting_human') {
                    // Si la intención es soporte o compra con frustración, NO nos quedamos callados.
                    // Esto evita que el bot ignore fallas reales si un humano habló hace días.
                    const isCritical = ['soporte', 'comprar', 'pagar'].includes(detection.intent);
                    if (isCritical && (detection.frustrationLevel >= 4)) {
                        console.log(`[Flow Recovery] 🚨 Detectada intención crítica (${detection.intent}) con frustración (${detection.frustrationLevel}). Rompiendo silencio para @${userId}.`);
                    } else {
                        console.log(`[Flow Recovery] 🤫 Silenciando bot para @${userId.replace('@c.us', '')} por intervención humana detectada en historial.`);
                        return; // Silencio absoluto si un humano estaba hablando y no hay urgencia
                    }
                }

                if (detection.recoveredState === 'awaiting_payment_method') {
                    if (['pagar', 'comprar', 'renovar'].includes(detection.intent) || (detection.metadata && detection.metadata.paymentMethod)) {
                        await handleAwaitingPaymentMethod(message, userId, false, null, inputToUse);
                    } else {
                        await message.reply(`🤖 ¡Hola${foundName ? ' ' + foundName : ''}! Veo que estábamos en proceso de pago. ¿Por cuál medio deseas realizar la transferencia? (Nequi, Daviplata, Bancolombia, etc.)`);
                    }
                    return;
                }
            }

            // --- VERIFICACIÓN INTELIGENTE DE VENTAS WEB PENDIENTES (TEMPORALES) ---
            try {
                const { checkPendingWebSaleForPhone } = require('./billingService');
                const pendingSale = await checkPendingWebSaleForPhone(realPhone, foundName);
                if (pendingSale) {
                    console.log(`[Web Sale Check] Detectada venta pendiente en BD para ${realPhone}: Orden ${pendingSale.order_id}`);
                    const apiKey = process.env.BOLD_IDENTITY_KEY;
                    let isApprovedInBold = false;
                    if (apiKey) {
                        try {
                            const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                            const boldRes = await fetch(`https://integrations.api.bold.co/online/payment/v1/orders/${pendingSale.order_id}`, {
                                method: 'GET',
                                headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
                            });
                            if (boldRes.ok) {
                                const boldData = await boldRes.json();
                                const bState = (boldData.status || boldData.data?.status || boldData.payment_status || '').toUpperCase();
                                if (bState === 'APPROVED' || bState === 'SALE_APPROVED' || bState === 'SUCCESS' || bState === 'PAID') {
                                    isApprovedInBold = true;
                                }
                            }
                        } catch (e) { }
                    }

                    const lowerInput = (inputToUse || '').toLowerCase();
                    const isRejectingOrder = /no he pedido|no ped[ií]|no compr[eé]|error|no es m[ií]o/i.test(lowerInput);
                    const isSupportOrIssue = /problema|se cay[oó]|no tengo suscripci[oó]n|pantalla|ca[ií]da|soporte|asesor|ayuda|no funciona|falla/i.test(lowerInput);
                    const isPaymentQuery = message.hasMedia || /ya pagu[eé]|comprobante|mi pedido|mis claves|mi orden|mi cuenta/i.test(lowerInput);

                    if (isApprovedInBold) {
                        console.log(`[Web Sale Check] ✅ ¡Orden ${pendingSale.order_id} aprobada en Bold API! Ejecutando entrega inmediata...`);
                        await approveBoldOrder(pendingSale.order_id);
                        return;
                    } else if (isPaymentQuery && !isRejectingOrder && !isSupportOrIssue) {
                        const amountFmt = pendingSale.amount ? `$${Number(pendingSale.amount).toLocaleString('es-CO')} COP` : '';
                        await message.reply(
                            `🤖 ¡Hola ${pendingSale.firstName || ''}! 👋 Veo que tu pedido de *${pendingSale.platformName}* (${amountFmt}) está registrado en nuestro sistema (Orden \`${pendingSale.order_id}\`). 🎉\n\n` +
                            `En este momento estamos monitoreando la confirmación de tu banco (Nequi/PSE) en tiempo real. Tan pronto como tu banco confirme la transacción a nuestra pasarela, recibirás tus claves automáticamente por este mismo chat. 😊`
                        );
                        return;
                    }
                }
            } catch (pErr) {
                console.error("[Web Sale Check Error]:", pErr.message);
            }

            // 4.5 DETECCIÓN DE FRUSTRACIÓN / INSISTENCIA (Startup/Unread handle)
            const frustration = detection.frustrationLevel || 0;
            const unreads = message._unreadCount || 0;

            const solvableIntents = ["comprar", "pagar", "credenciales", "catalogo", "renovar"];
            const cleanText = (message.body || "").toLowerCase().trim();
            const isExplicitHumanRequest = cleanText.includes('asesor') || cleanText.includes('humano') || cleanText === '5';
            const isAwaitingDetails = currentStateData && currentStateData.state === 'awaiting_support_details';
            const shouldForceHuman = (frustration >= 9 || unreads >= 10 || isExplicitHumanRequest || isAwaitingDetails);

            if (shouldForceHuman && !solvableIntents.includes(detection.intent)) {
                console.log(`[Flow Recovery] 🚨 Detectada alta frustración/insistencia para @${userId}. Pasando a waiting_human.`);

                const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                const supportStatus = await isSupportOpen();

                userStates.set(userId, {
                    state: 'waiting_human',
                    nombre: foundName,
                    waitingCount: 1,
                    waiting_human_mode: 'bot'
                });

                if (!supportStatus.open) {
                    const { getOfflineReplyMessage } = require('./supportScheduleService');
                    const offlineMsg = await getOfflineReplyMessage(userId, userStates);
                    await message.reply(offlineMsg);
                } else {
                    const queuePos = getQueuePosition(userId, userStates);
                    let replyText = "🤖 Hola, he detectado que necesitas soporte personalizado. Ya le dejé un recordatorio a un asesor humano para que revise tu caso personalmente. Recuerda que de forma automática puedo ayudarte a **vender cuentas, revisar tus credenciales, registrar pagos y extraer códigos de acceso (2FA/Hogar/TV de Netflix, Disney+, Max, etc. escribiendo 'código de ...')**.";
                    if (queuePos) {
                        replyText += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}. En un momento te atenderemos. ¡Gracias por tu paciencia! 😊`;
                    } else {
                        replyText += "\n\nEn un momento te atenderemos. ¡Gracias por tu paciencia! 😊";
                    }
                    await message.reply(replyText);
                }
                return;
            }

            // 5. MANEJO DE INTENCIONES
            if (detection.intent === 'cancelar') {
                console.log(`[Cierre] Intent 'cancelar' detectado para ${userId}. Pidiendo razón de churn.`);

                let rowNumberToCancel = null;
                if (userAccounts && userAccounts.length > 0) {
                    let targetAccount = userAccounts[0];
                    if (detection.detectedPlatform) {
                        const targetSearch = detection.detectedPlatform.toLowerCase().replace(/[^a-z0-9]/g, '');
                        const match = userAccounts.find(a => (a.Streaming || "").toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetSearch));
                        if (match) targetAccount = match;
                    }
                    rowNumberToCancel = targetAccount._rowNumber;
                }

                if (rowNumberToCancel) {
                    await message.reply("🤖 Oh, entiendo perfectamente. Lamento mucho que hoy no podamos continuar con tu servicio. 😔\n\nEn Sheerit siempre buscamos mejorar: ¿podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho a ser mejores.");
                    userStates.set(userId, {
                        state: 'awaiting_churn_reason',
                        nombre: foundName,
                        rowNumber: rowNumberToCancel
                    });
                    // Guardado inmediato preventivo ("cortar") en caso de que el cliente no responda a la pregunta.
                    const { updateExcelData } = require('./apiService');
                    const dateStr = new Date().toLocaleDateString('es-CO');
                    updateExcelData(rowNumberToCancel, { "observaciones": `cortar (bot ${dateStr})` }).catch(e => console.error("[Churn] Error guardado preventivo:", e.message));

                } else {
                    await message.reply("🤖 Entiendo. ¡Aquí tienes tu casa para cuando decidas volver! 👋");
                    userStates.delete(userId);
                }
                return;
            }

            if (detection.intent === 'cierre') {
                console.log(`[Cierre] Intent 'cierre' detectado para ${userId}. Fin de charla natural.`);
                // Si el usuario simplemente dice gracias, listo, ok, no necesitamos contestar ni asustarlo con la cancelación.
                return;
            }

            if (detection.intent === 'comprar') {
                const existingState = userStates.get(userId) || {};

                // SI EL USUARIO TIENE CUENTAS Y NO MENCIONA UNA PLATAFORMA NUEVA, ASUMIMOS QUE ES RENOVACIÓN/PAGO
                const isExplicitPurchase = ['comprar', 'nueva', 'nuevo', 'interesado', 'interesada', 'adquirir', 'quiero', 'venden', 'precio', 'cotizar', 'cuenta de', 'cuentas de'].some(kw => inputToUse.toLowerCase().includes(kw));

                if (userAccounts.length > 0 && !isExplicitPurchase) {
                    const durationMonths = getDurationMonths(detection, inputToUse);
                    await processCheckPrices(message, userId, userStates, inputToUse, detection.detectedPlatform, durationMonths);
                    return;
                }

                // Priorizamos la venta: Si ya tenemos algún nombre (venga de contactos o de la IA), seguimos adelante.
                if (!foundName) {
                    await message.reply(`🤖 ¡Hola! Con gusto te ayudo con tu compra. ¿Me podrías regalar tu nombre y apellido completo para registrarte oficialmente? 😊`);
                    userStates.set(userId, { ...existingState, state: 'awaiting_name_for_contact', nextFlow: 'comprar', detectedPlatform: detection.detectedPlatform || null });
                    return;
                }

                // OPTIMIZACIÓN: Si el usuario ya especificó qué quiere desde el saludo (ej. "Hola, Netflix")
                // Saltamos el menú de selección de plataformas y vamos directo a la cotización detallada.
                if (detection.detectedPlatform) {
                    console.log(`[Flow Optimization] Saltando menú de plataformas para @${userId}. Plataforma detectada: ${detection.detectedPlatform}`);

                    // Limpieza de seguridad: si el usuario cambió de idea respecto a lo que había en el carrito
                    if (existingState.items && existingState.items.length > 0) {
                        const currentPlat = (existingState.items[0].Streaming || existingState.items[0].platform?.name || "").toLowerCase();
                        const newPlat = detection.detectedPlatform.toLowerCase();
                        if (!newPlat.includes(currentPlat) && !currentPlat.includes(newPlat)) {
                            console.log(`[Flow Optimization] Detectado cambio de interés (${currentPlat} -> ${newPlat}). Limpiando carrito previo.`);
                            existingState.items = [];
                            existingState.total = 0;
                        }
                    }

                    userStates.set(userId, { ...existingState, state: 'awaiting_purchase_platforms', nombre: foundName });
                    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
                    return;
                }

                // Flujo estándar con menú
                userStates.set(userId, { ...existingState, state: 'awaiting_purchase_platforms', nombre: foundName });
                await message.reply(`🤖 ¡Perfecto ${foundName}! Con gusto te ayudo con tu compra.`);
                await startPurchaseProcess(message, userId, userStates);
                return;
            } else if (detection.intent === 'renovar') {
                const durationMonths = getDurationMonths(detection, inputToUse);
                await processCheckPrices(message, userId, userStates, inputToUse, detection.detectedPlatform, durationMonths);
                return;
            } else if (detection.intent === 'credenciales') {
                const { processCheckCredentials } = require('./billingService');
                await processCheckCredentials(userId, client, message.body, "", userStates);
                return;
            } else if (detection.intent === 'catalogo') {
                await message.reply("🤖 ¡Claro! Puedes ver nuestro catálogo actualizado con todos los precios y realizar tu compra directamente en nuestra página web: https://sheerit.co/ 🌐\n\nSi tienes alguna duda específica sobre un servicio, ¡cuéntame!");
                return;
            } else if (detection.intent === 'pagar') {
                const stateData = userStates.get(userId) || {};
                if (userAccounts.length === 0 && stateData.items && stateData.items.length > 0) {
                    await handleAwaitingPaymentMethod(message, userId, false, null, inputToUse);
                } else {
                    const durationMonths = getDurationMonths(detection, inputToUse);
                    await processCheckPrices(message, userId, userStates, inputToUse, detection.detectedPlatform, durationMonths);
                }
                return;
            } else if (detection.intent === 'soporte') {
                const is2fa = detection.metadata && detection.metadata.is2faScreen;
                const platform = detection.detectedPlatform;

                if (is2fa && platform) {
                    console.log(`[2FA Screen Interceptor] Detectado pantallazo de 2FA para la plataforma: ${platform}`);
                    const { getAccountsByPhone } = require('./apiService');
                    const userAccounts = await getAccountsByPhone(realPhone, foundName);

                    if (userAccounts.length > 0) {
                        const targetPlatformLower = platform.toLowerCase();
                        const matchingAccounts = userAccounts.filter(c => {
                            const streamingName = (c.Streaming || "").toLowerCase();
                            if (targetPlatformLower.includes('hbo') || targetPlatformLower.includes('max')) {
                                return streamingName.includes('hbo') || streamingName.includes('max');
                            }
                            if (targetPlatformLower.includes('amazon') || targetPlatformLower.includes('prime')) {
                                return streamingName.includes('amazon') || streamingName.includes('prime');
                            }
                            return streamingName.includes(targetPlatformLower) || targetPlatformLower.includes(streamingName);
                        });

                        let targetAccount = null;
                        const fullText = ((message.body || "") + " " + (detection.explanation || "")).toLowerCase();

                        if (matchingAccounts.length === 1) {
                            targetAccount = matchingAccounts[0];
                        } else if (matchingAccounts.length > 1) {
                            // Buscar si mencionó el correo o fragmento del correo
                            const specificMatch = matchingAccounts.find(c => {
                                const mail = (c.correo || "").toLowerCase().trim();
                                const mailUser = mail.split('@')[0];
                                return fullText.includes(mail) || (mailUser.length > 3 && fullText.includes(mailUser));
                            });

                            if (specificMatch) {
                                targetAccount = specificMatch;
                            } else {
                                let msg = `🤖 Hola, detecté que necesitas un código para *${platform.toUpperCase()}*.\n\nVeo que tienes registradas múltiples cuentas de esta plataforma. ¿Para cuál de ellas lo necesitas?\n\n`;
                                matchingAccounts.forEach((acc, idx) => {
                                    const email = (acc.correo || "").trim().toLowerCase();
                                    const profile = acc['pin perfil'] || acc['Nombre'] || "";
                                    const profileStr = profile ? ` (Perfil: ${profile})` : "";
                                    msg += `${idx + 1} - ${email}${profileStr}\n`;
                                });
                                msg += `\n*Responde únicamente con el número de la opción que deseas.* 📲`;

                                await message.reply(msg);

                                userStates.set(userId, {
                                    state: 'awaiting_code_account_selection',
                                    candidates: matchingAccounts,
                                    timestamp: Date.now(),
                                    nombre: foundName
                                });
                                return;
                            }
                        }

                        // Si no hay coincidencia directa pero solo tiene 1 cuenta, usar esa
                        if (!targetAccount && userAccounts.length === 1) {
                            targetAccount = userAccounts[0];
                        }

                        // Si tiene varias de otras plataformas y no especificó
                        if (!targetAccount && userAccounts.length > 1) {
                            let msg = `🤖 Hola, detecté que necesitas un código para *${platform.toUpperCase()}*.\n\nVeo que tienes registradas múltiples cuentas activas. ¿De cuál de ellas necesitas el código de verificación?\n\n`;
                            userAccounts.forEach((acc, idx) => {
                                const platName = (acc.Streaming || "").toUpperCase();
                                const email = (acc.correo || "").trim().toLowerCase();
                                const profile = acc['pin perfil'] || acc['Nombre'] || "";
                                const profileStr = profile ? ` (Perfil: ${profile})` : "";
                                msg += `${idx + 1} - *${platName}* - ${email}${profileStr}\n`;
                            });
                            msg += `\n*Responde únicamente con el número de la opción que deseas.* 📲`;

                            await message.reply(msg);

                            userStates.set(userId, {
                                state: 'awaiting_code_account_selection',
                                candidates: userAccounts,
                                timestamp: Date.now(),
                                nombre: foundName
                            });
                            return;
                        }

                        if (targetAccount) {
                            await processAccountVerificationCode(message, userId, targetAccount, realPhone, client, userStates);
                            return;
                        }
                    } else {
                        // No tiene cuentas activas
                        await message.reply(`🤖 ¡Hola! Veo que enviaste una captura de pantalla para obtener el código de *${platform.toUpperCase()}*, pero no encontré ninguna cuenta activa de esa plataforma vinculada a tu número de WhatsApp. Si deseas renovar o adquirir una, por favor indícalo. 😊`);
                        return;
                    }
                }

                // Si no es un caso de 2FA/código, revisamos si ya le habíamos pedido detalles
                const wasAwaitingDetails = currentStateData && currentStateData.state === 'awaiting_support_details';
                const cleanText = (message.body || "").toLowerCase().trim();
                const isExplicitHumanRequest = cleanText.includes('asesor') || cleanText.includes('humano') || cleanText === '5';

                if (wasAwaitingDetails || isExplicitHumanRequest) {
                    const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                    const supportStatus = await isSupportOpen();

                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

                    if (!supportStatus.open) {
                        const { getOfflineReplyMessage } = require('./supportScheduleService');
                        const offlineMsg = await getOfflineReplyMessage(userId, userStates);
                        await safeReply(message, offlineMsg, userId);
                    } else {
                        const queuePos = getQueuePosition(userId, userStates);
                        let replyText = "🤖 Entendido. He transferido tu caso a soporte técnico. Un asesor humano te atenderá lo antes posible.";
                        if (queuePos) {
                            replyText += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}. ¡Gracias por tu paciencia!`;
                        }
                        await safeReply(message, replyText, userId);
                    }
                } else if (message.hasMedia || (mediaData && mediaData.length > 0)) {
                    await safeReply(message, `🤖 ¡Hola! He recibido la captura de pantalla del error que me enviaste. 📺\n\nYa notifiqué a nuestro equipo de soporte técnico para revisar la falla y darte solución lo antes posible. ¡Gracias por tu paciencia! 😊`, userId);
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot', nombre: foundName });
                } else {
                    await safeReply(message, `🤖 ¡Hola! Entiendo que tienes un inconveniente con tu cuenta. Para poder ayudarte a solucionarlo lo antes posible (e incluso resolverlo automáticamente si es un código de acceso o restablecimiento de hogar), por favor **envíame una foto del error que te aparece en pantalla o descríbeme detalladamente qué plataforma es y qué error te sale**. 📲`, userId);
                    userStates.set(userId, { state: 'awaiting_support_details', timestamp: Date.now(), platform: platform, nombre: foundName });
                }
                return;
            }

            // 6. FLUJO POR DEFECTO (Más sutil y conversacional)
            const historyForFallback = await getChatHistoryText(message);

            userAccounts = [];
            try { userAccounts = await getAccountsByPhone(realPhone, foundName); } catch (e) { }

            const fallbackResult = await generateEmpatheticFallback(message.body || "", message.hasMedia, historyForFallback, (mediaData && mediaData.length > 0) ? mediaData[0] : null, userAccounts, userId, userStates);
            const fallbackMsg = typeof fallbackResult === 'string' ? fallbackResult : (fallbackResult?.replyMessage || "");

            if (fallbackMsg && fallbackMsg.trim() !== "") {
                console.log(`[Fallback Conversacional] Enviando respuesta empática de Gemini a @${userId}`);
                await safeReply(message, fallbackMsg, userId);
                if (typeof fallbackResult === 'object' && fallbackResult.needsEscalation) {
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot', nombre: foundName });
                }
            } else {
                console.log(`[Fallback Menú] Enviando menú de bienvenida estándar a @${userId}`);
                const currentData = userStates.get(userId) || {};
                if (foundName) {
                    userStates.set(userId, { ...currentData, state: 'main_menu', nombre: foundName });
                    await safeReply(message, `🤖 ¡Hola de nuevo${!nameIsComplete ? '' : ', *' + foundName + '*'}! Qué gusto saludarte.\n\nEscoge una opción:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)`, userId);
                } else {
                    const welcomeMsg = "🤖 ¡Hola! Soy el asistente virtual de *Sheerit*.\n\nPara poder ayudarte mejor, ¿cómo te llamas? O si lo prefieres, escoge una opción del menú:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)";
                    await safeReply(message, welcomeMsg, userId);
                    userStates.set(userId, { ...currentData, state: 'main_menu' });
                }
            }
            break;
        case 'awaiting_payment_renewal_confirmation':
            const responseOption = (message.body || "").trim();
            if (responseOption === '1') {
                const stateInfo = currentStateData;
                await message.reply("🤖 ¡Excelente! Estoy registrando tu renovación en el Excel y generando tus credenciales. Dame un momento... ⏳");
                const tempState = {
                    nombre: stateInfo.nombre,
                    items: [stateInfo.matchedAccount],
                    total: stateInfo.amount,
                    chatJid: stateInfo.chatJid || userId
                };
                const valResult = await executePaymentValidation(userId, tempState, client, userStates, null, stateInfo.matchId);
                if (!valResult.success) {
                    await message.reply("🤖 Hubo un problema al renovar automáticamente tu cuenta. Un asesor revisará tu caso en un momento. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                }
            } else {
                const textLower = responseOption.toLowerCase();
                const platformsSupported = ['netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'spotify', 'youtube', 'apple', 'crunchyroll', 'vix', 'paramount', 'canva', 'chatgpt', 'gpt', 'claude', 'gemini', 'microsoft'];
                const targetPlatform = platformsSupported.find(p => textLower.includes(p));

                if (targetPlatform) {
                    const platformName = targetPlatform.toUpperCase();
                    const otherActiveAccount = userAccounts && userAccounts.find(acc => {
                        const s = (acc.Streaming || "").toLowerCase();
                        return s.includes(targetPlatform);
                    });

                    if (otherActiveAccount) {
                        await message.reply(`🤖 ¡Entendido! Registrando la renovación de tu servicio de *${platformName}* con tu pago verificado de *$${currentStateData.amount}*... ⏳`);
                        const tempState = {
                            nombre: currentStateData.nombre,
                            items: [otherActiveAccount],
                            total: currentStateData.amount,
                            chatJid: currentStateData.chatJid || userId
                        };
                        await executePaymentValidation(userId, tempState, client, userStates, null, currentStateData.matchId);
                    } else {
                        await message.reply(`🤖 ¡Entendido! He registrado tu pago verificado de *$${currentStateData.amount.toLocaleString('es-CO')}* COP para el servicio de *${platformName}*. 🚀\n\nUn asesor validará los detalles y te entregará tus credenciales de *${platformName}* lo más pronto posible. ¡Gracias por tu compra! 😊`);
                        userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                await groupChat.sendMessage(`🚨 *PAGO VERIFICADO ($${currentStateData.amount}) PARA NUEVO SERVICIO (${platformName})* de @${getDisplayPhone()}\n` +
                                    `Monto: $${currentStateData.amount}\n` +
                                    `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                                    `Plataforma solicitada: ${platformName}\n` +
                                    `Asunto: ${currentStateData.subject}`);
                            }
                        } catch (e) { }
                    }
                } else if (responseOption === '2') {
                    await message.reply("🤖 Entendido. He pausado el registro automático para que un asesor de soporte revise tu comprobante y te entregue tu nuevo servicio manualmente. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                    try {
                        const groupChat = await client.getChatById(GROUP_ID);
                        if (groupChat) {
                            await groupChat.sendMessage(`🚨 *PAGO MANUAL REQUERIDO (NUEVO SERVICIO)* de @${getDisplayPhone()}\n` +
                                `Monto: $${currentStateData.amount}\n` +
                                `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                                `Asunto: ${currentStateData.subject}\n` +
                                `El cliente indicó que el pago NO es para renovar su cuenta actual de ${(currentStateData.matchedAccount.Streaming || "Servicio").toUpperCase()}.`);
                        }
                    } catch (e) { }
                } else {
                    await message.reply("🤖 Por favor, responde únicamente con *1* (Sí, renovar) o *2* (No, servicio nuevo), o especifícame qué servicio deseas activar con tu pago verificado. 😊");
                }
            }
            break;
        case 'awaiting_payment_multi_renewal_confirmation':
            const multiResponseOption = (message.body || "").trim();
            if (multiResponseOption === '1') {
                const stateInfo = currentStateData;
                await message.reply("🤖 ¡Excelente! Estoy registrando la renovación de tus servicios en el Excel y preparando tus credenciales. Dame un momento... ⏳");
                const tempState = {
                    nombre: stateInfo.nombre,
                    items: stateInfo.matchedAccounts,
                    total: stateInfo.amount,
                    chatJid: stateInfo.chatJid || userId
                };
                const valResult = await executePaymentValidation(userId, tempState, client, userStates, null, stateInfo.matchId);
                if (!valResult.success) {
                    await message.reply("🤖 Hubo un problema al renovar automáticamente tus cuentas. Un asesor revisará tu caso en un momento. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                }
            } else {
                const textLower = multiResponseOption.toLowerCase();
                const platformsSupported = ['netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'spotify', 'youtube', 'apple', 'crunchyroll', 'vix', 'paramount', 'canva', 'chatgpt', 'gpt', 'claude', 'gemini', 'microsoft'];
                const targetPlatform = platformsSupported.find(p => textLower.includes(p));

                if (targetPlatform) {
                    const platformName = targetPlatform.toUpperCase();
                    const otherActiveAccount = userAccounts && userAccounts.find(acc => {
                        const s = (acc.Streaming || "").toLowerCase();
                        return s.includes(targetPlatform);
                    });

                    if (otherActiveAccount) {
                        await message.reply(`🤖 ¡Entendido! Registrando la renovación de tu servicio de *${platformName}* con tu pago verificado de *$${currentStateData.amount}*... ⏳`);
                        const tempState = {
                            nombre: currentStateData.nombre,
                            items: [otherActiveAccount],
                            total: currentStateData.amount,
                            chatJid: currentStateData.chatJid || userId
                        };
                        await executePaymentValidation(userId, tempState, client, userStates, null, currentStateData.matchId);
                    } else {
                        await message.reply(`🤖 ¡Entendido! He registrado tu pago verificado de *$${currentStateData.amount.toLocaleString('es-CO')}* COP para el servicio de *${platformName}*. 🚀\n\nUn asesor validará los detalles y te entregará tus credenciales de *${platformName}* lo más pronto posible. ¡Gracias por tu compra! 😊`);
                        userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                await groupChat.sendMessage(`🚨 *PAGO VERIFICADO ($${currentStateData.amount}) PARA NUEVO SERVICIO (${platformName})* de @${getDisplayPhone()}\n` +
                                    `Monto: $${currentStateData.amount}\n` +
                                    `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                                    `Plataforma solicitada: ${platformName}\n` +
                                    `Asunto: ${currentStateData.subject}`);
                            }
                        } catch (e) { }
                    }
                } else if (multiResponseOption === '2') {
                    await message.reply("🤖 Entendido. He pausado el registro automático para que un asesor de soporte revise tu comprobante y te entregue tu nuevo servicio manualmente. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                    try {
                        const groupChat = await client.getChatById(GROUP_ID);
                        if (groupChat) {
                            const platformsList = currentStateData.matchedAccounts.map(item => (item.Streaming || item.name || "Servicio").toUpperCase());
                            const uniquePlats = [...new Set(platformsList)];
                            const platformsStr = uniquePlats.join(', ');
                            await groupChat.sendMessage(`🚨 *PAGO MANUAL REQUERIDO (NUEVO SERVICIO)* de @${getDisplayPhone()}\n` +
                                `Monto: $${currentStateData.amount}\n` +
                                `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                                `Asunto: ${currentStateData.subject}\n` +
                                `El cliente indicó que el pago NO es para renovar sus cuentas actuales de ${platformsStr}.`);
                        }
                    } catch (e) { }
                } else {
                    await message.reply("🤖 Por favor, responde únicamente con *1* (Sí, renovar) o *2* (No, servicio nuevo), o especifícame qué servicio deseas activar con tu pago verificado. 😊");
                }
            }
            break;
        case 'awaiting_payment_multi_renewal_selection': {
            const selChoice = parseInt((message.body || "").trim());
            const multiCandidates = currentStateData.candidateAccounts || [];
            
            if (selChoice === 1) {
                const allPlatsNames = [...new Set(multiCandidates.map(acc => (acc.Streaming || acc.Plataforma || "Servicio").toUpperCase()))].join(', ');
                await message.reply(`🤖 ¡Entendido! Estoy registrando la renovación de *TODAS* tus cuentas (*${allPlatsNames}*) y preparando tus credenciales. Dame un momento... ⏳`);
                const tempState = {
                    nombre: currentStateData.nombre,
                    items: multiCandidates,
                    total: currentStateData.amount,
                    chatJid: currentStateData.chatJid || userId
                };
                const valResult = await executePaymentValidation(userId, tempState, client, userStates, null, currentStateData.matchId);
                if (!valResult.success) {
                    await message.reply("🤖 Hubo un problema al renovar automáticamente tus cuentas. Un asesor revisará tu caso en un momento. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                }
            } else if (!isNaN(selChoice) && selChoice >= 2 && selChoice <= multiCandidates.length + 1) {
                const chosenAccount = multiCandidates[selChoice - 2];
                const platName = (chosenAccount.Streaming || "Servicio").toUpperCase();
                await message.reply(`🤖 ¡Entendido! Estoy registrando la renovación de tu cuenta de *${platName}* y preparando tus credenciales. Dame un momento... ⏳`);
                const tempState = {
                    nombre: currentStateData.nombre,
                    items: [chosenAccount],
                    total: currentStateData.amount,
                    chatJid: currentStateData.chatJid || userId
                };
                const valResult = await executePaymentValidation(userId, tempState, client, userStates, null, currentStateData.matchId);
                if (!valResult.success) {
                    await message.reply("🤖 Hubo un problema al renovar automáticamente tu cuenta. Un asesor revisará tu caso en un momento. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                }
            } else if (!isNaN(selChoice) && selChoice === multiCandidates.length + 2) {
                await message.reply("🤖 Entendido. He pausado el registro automático para que un asesor de soporte revise tu comprobante y te entregue tu nuevo servicio manualmente. ¡Gracias por tu paciencia! 😊");
                userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
            } else {
                await message.reply(`🤖 Por favor, responde únicamente con el número de la opción que deseas (1 a ${multiCandidates.length + 2}).`);
            }
            break;
        }
        case 'awaiting_payment_autofill_confirmation':
            const autofillOption = (message.body || "").trim().toLowerCase();
            if (autofillOption === '1' || autofillOption === 'si' || autofillOption === 'sí') {
                const stateInfo = currentStateData;
                await message.reply("🤖 ¡Excelente! Procediendo a la asignación y entrega de tu servicio... ⏳");
                const valResult = await executePaymentValidation(
                    userId,
                    stateInfo.pendingStateData,
                    client,
                    userStates,
                    null,
                    stateInfo.matchId
                );
                if (!valResult.success) {
                    await message.reply("🤖 Hubo un inconveniente al asignar automáticamente tu cuenta. Un asesor revisará tu caso en un momento. ¡Gracias por tu paciencia! 😊");
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                }
            } else if (autofillOption === '2' || autofillOption === 'no') {
                await message.reply("🤖 Entendido. He pausado la asignación automática para que un asesor te colabore. Por favor, escríbeme cuál plataforma deseas activar. 😊");
                userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        await groupChat.sendMessage(`🚨 *PAGO MANUAL REQUERIDO (PLATAFORMA ERRÓNEA)* de @${getDisplayPhone()}\n` +
                            `Monto: $${currentStateData.amount}\n` +
                            `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                            `El cliente indicó que el pago NO era para ${currentStateData.targetPlat || 'la plataforma inferida'}.`);
                    }
                } catch (e) { }
            } else {
                await message.reply("🤖 Por favor, responde únicamente con *1* (Sí, activar) o *2* (No, otra plataforma).");
            }
            break;
        case 'awaiting_code_account_selection':
            const cleanTxt = (message.body || "").toLowerCase().trim();
            const isClosingMsg = ['gracias', 'muchas gracias', 'listo', 'ok', 'vale', 'todo bien', 'ya pude', 'perfecto', 'excelente', 'chao', 'adios'].some(k => cleanTxt.includes(k));
            if (isClosingMsg) {
                await message.reply("¡Con mucho gusto! Me alegra que todo esté funcionando bien. ¡Que disfrutes tu servicio! 😊🎬");
                userStates.delete(userId);
                return;
            }
            const selectionIdx = parseInt(cleanTxt) - 1;
            const candidates = currentStateData.candidates || [];
            if (isNaN(selectionIdx) || selectionIdx < 0 || selectionIdx >= candidates.length) {
                await message.reply(`🤖 Por favor, responde con el número de la cuenta que deseas (1 a ${candidates.length}).`);
                return;
            }
            const selectedAccount = candidates[selectionIdx];
            await processAccountVerificationCode(message, userId, selectedAccount, realPhone, client, userStates);
            break;
        case 'main_menu':
            await handleMainMenuSelection(message, userId, detection, message.hasMedia, (mediaData && mediaData.length > 0) ? mediaData[0] : null);
            break;
        case 'awaiting_apple_one_details':
            const text = (message.body || "").trim();
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
            const phoneRegex = /(?:57)?\s*3\d{2}\s*\d{7}|\d{10}/;

            const emailMatch = text.match(emailRegex);
            const phoneMatch = text.match(phoneRegex);

            if (emailMatch || phoneMatch) {
                const appleId = emailMatch ? emailMatch[0].trim() : "No especificado";
                const rawUserPhone = userId.split('@')[0].split(':')[0].replace(/\D/g, '');
                const phoneNumber = phoneMatch ? phoneMatch[0].replace(/\s+/g, '') : rawUserPhone;

                await message.reply(`🤖 ¡Perfecto! He recibido tus datos:\n📱 *Número:* ${phoneNumber}\n📧 *Apple ID:* ${appleId}\n\nYa reporté la información al área encargada. Por favor, está al tanto de tu correo electrónico o de tus mensajes de texto, ya que por ahí recibirás las instrucciones e invitación para unerte. ¡Muchas gracias! 😊`);

                let freeAccountMsg = "";
                try {
                    const { fetchRawData } = require('./apiService');
                    const allRows = await fetchRawData(3, 2000, true);
                    const freeIndex = allRows.findIndex(row => {
                        const stream = (row.Streaming || row.Plataforma || "").toString().toLowerCase();
                        if (stream.includes('apple')) {
                            const whatsapp = (row.whatsapp || "").toString().trim();
                            const nombre = (row.Nombre || row.nombre || "").toString().trim();
                            return !whatsapp && (!nombre || nombre.toLowerCase() === 'libre');
                        }
                        return false;
                    });
                    if (freeIndex !== -1) {
                        const freeRow = allRows[freeIndex];
                        freeAccountMsg = `📧 *Cuenta Libre:* ${freeRow.correo || freeRow.Correo || 'Sin correo'}\n📍 *Fila en sistema:* Fila ${freeIndex + 2}\n\n`;
                    } else {
                        freeAccountMsg = `⚠️ *Cuenta Libre:* No se encontró ninguna cuenta Apple con cupo libre en el sistema.\n\n`;
                    }
                } catch (err) {
                    console.error("Error finding free Apple account:", err);
                    freeAccountMsg = `⚠️ *Cuenta Libre:* Error al consultar base de datos (${err.message}).\n\n`;
                }

                try {
                    let appleGroup = null;
                    try {
                        appleGroup = await client.getChatById('120363401686024541@g.us');
                    } catch (chatErr) {
                        console.warn("No se pudo obtener el grupo por ID, buscando por nombre...", chatErr.message);
                        const chats = await client.getChats();
                        appleGroup = chats.find(c => c.isGroup && c.name.toLowerCase().includes('usuarios apple'));
                    }

                    if (appleGroup) {
                        const groupMsg = `🚨 *NUEVO REGISTRO APPLE ONE* 🚨\n\n` +
                            `👤 *Cliente:* @${userId.replace('@c.us', '')}\n` +
                            `📱 *Celular:* ${phoneNumber}\n` +
                            `📧 *Apple ID:* ${appleId}\n\n` +
                            freeAccountMsg +
                            `Por favor, envíale la invitación familiar.`;
                        await appleGroup.sendMessage(groupMsg);
                    } else {
                        console.warn("No se encontró el grupo 'usuarios apple'. Notificando al grupo admin por defecto.");
                        const adminGroup = await client.getChatById(GROUP_ID);
                        if (adminGroup) {
                            await adminGroup.sendMessage(`🚨 *NUEVO REGISTRO APPLE ONE* (Grupo 'usuarios apple' no encontrado)\n\n` +
                                `👤 *Cliente:* @${userId.replace('@c.us', '')}\n` +
                                `📱 *Celular:* ${phoneNumber}\n` +
                                `📧 *Apple ID:* ${appleId}\n\n` +
                                freeAccountMsg);
                        }
                    }
                } catch (e) {
                    console.error("Error forwarding Apple One details to group:", e.message);
                }
                userStates.set(userId, { state: 'main_menu', nombre: foundName });
            } else {
                await message.reply("🤖 Para la activación de tu servicio de *Apple One*, por favor envíame el correo electrónico de tu Apple ID (ejemplo: miusuario@icloud.com).");
            }
            break;
        case 'awaiting_netflix_operator_post_payment':
            const ispInfo = (message.body || "").trim();
            const st = userStates.get(userId) || {};

            userStates.set(userId, { ...st, state: 'awaiting_payment_confirmation', netflixIsp: ispInfo });

            // Si tenemos un matchId de Gmail precargado, podemos autovalidar inmediatamente!
            if (st.gmailMatchId) {
                await message.reply("🤖 ¡Excelente! He validado tu comprobante y registrado tu información de operador. Estoy generando tus credenciales, dame un momento... ⏳");
                const validationResult = await executePaymentValidation(
                    userId,
                    { ...st, netflixIsp: ispInfo, total: st.checkAmount, paymentMethod: `Gmail Match (${st.paymentMethod || 'Bre-B'})` },
                    client,
                    userStates,
                    null,
                    st.gmailMatchId
                );

                if (validationResult.success) {
                    try {
                        const groupChat = await client.getChatById(GROUP_ID);
                        if (false && groupChat) {
                            await groupChat.sendMessage(`✅ *PAGO AUTO-VALIDADO CON OPERADOR* (@${userId.replace('@c.us', '')})\n` +
                                `Monto: $${st.checkAmount}\n` +
                                `Banco: ${st.paymentMethod || 'Bre-B'}\n` +
                                `Operador: ${ispInfo}\n` +
                                `ID Gmail: ${st.gmailMatchId}\n\n` +
                                `El bot ya entregó el servicio automáticamente.`);
                        }
                    } catch (e) { }
                    return;
                }
            }

            try {
                const groupChat = await client.getChatById(GROUP_ID);
                const matchData = await getNetflixMatchReport(ispInfo); // ahora retorna { rawReport, hasStock }

                if (!matchData.hasStock) {
                    await message.reply("🤖 En este momento no hay stock inmediato en tu misma red sugerido en el sistema, por lo que un asesor humano se encargará personalmente de crear la cuenta nueva para ti desde cero y validará tu comprobante. ¡Gracias por tu paciencia! 😊");
                } else {
                    await message.reply("🤖 ¡Gracias por la información! Un asesor validará tu pago en un momento y te entregará tu cuenta. ¡Gracias por tu paciencia! 😊");
                }

                if (groupChat) {
                    const checkBank = st.paymentMethod || 'No identificado';
                    const checkAmount = st.checkAmount || 'No legible';
                    let adminMsg = `🚨 *COMPROBANTE DETECTADO* (@${userId.replace('@c.us', '')})\n` +
                        `Banco: ${checkBank}\n` +
                        `Monto: ${checkAmount}\n\n` +
                        `Valida el pago y confirma usando:\n*confirmar ${userId.replace('@c.us', '')}*`;

                    adminMsg += `\n${matchData.rawReport}`;
                    await groupChat.sendMessage(adminMsg);
                }
            } catch (adminErr) {
                await message.reply("🤖 ¡Gracias por la información! Un asesor validará tu pago en un momento y te entregará tu cuenta. ¡Gracias por tu paciencia! 😊");
                console.error("Error notificando al grupo sobre operador de Netflix:", adminErr.message);
            }
            break;
        case 'awaiting_payment_method':
            await handleAwaitingPaymentMethod(message, userId, message.hasMedia, (mediaData && mediaData.length > 0) ? mediaData[0] : null, inputToUse);
            break;
        case 'awaiting_cobros_confirmation':
            await handleAwaitingCobrosConfirmation(message, originalChatJid || userId, userStates, pendingConfirmations, client);
            break;
        case 'awaiting_payment_confirmation':
            await handleAwaitingPaymentConfirmation(message, userId, message.hasMedia, (mediaData && mediaData.length > 0) ? mediaData[0] : null);
            break;
        case 'awaiting_advisor_reason':
            try {
                const reason = inputToUse.trim();
                console.log(`[Advisor Flow] El usuario dio la razón de soporte: "${reason}"`);

                const { analyzeAdvisorReason } = require('./aiService');
                const analysis = await analyzeAdvisorReason(reason, hist);

                console.log(`[Advisor Flow AI Analysis] Can resolve? ${analysis.canResolve}. Action: ${analysis.action}. Explanation: ${analysis.explanation}`);

                if (analysis.canResolve && analysis.action) {
                    if (analysis.action === 'comprar') {
                        userStates.set(userId, { state: 'awaiting_purchase_platforms', nombre: foundName });
                        await message.reply(`🤖 Entiendo que deseas adquirir un nuevo servicio (${analysis.explanation}). ¡Yo mismo puedo ayudarte con eso de inmediato!`);
                        const { handleSubscriptionInterest } = require('./salesService');
                        await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
                        return;
                    } else if (analysis.action === 'pagar' || analysis.action === 'renovar') {
                        userStates.set(userId, { state: 'main_menu', nombre: foundName });
                        await message.reply(`🤖 Veo que deseas realizar un pago o renovar tus cuentas (${analysis.explanation}). ¡Puedo ayudarte con eso ahora mismo!`);
                        const { processCheckPrices } = require('./billingService');
                        await processCheckPrices(message, userId, userStates, reason, analysis.detectedPlatform, 1);
                        return;
                    } else if (analysis.action === 'credenciales') {
                        userStates.set(userId, { state: 'main_menu', nombre: foundName });
                        await message.reply(`🤖 Veo que necesitas revisar tus credenciales o claves de acceso (${analysis.explanation}).`);
                        const { processCheckCredentials } = require('./billingService');
                        await processCheckCredentials(userId, client, reason, "");
                        return;
                    } else if (analysis.action === 'soporte') {
                        await message.reply("🤖 Entiendo que experimentas un problema técnico. Para ayudarte a solucionarlo de inmediato, por favor indícame con qué plataforma tienes el inconveniente o envíame una captura de pantalla del error.");
                        userStates.set(userId, { state: 'main_menu', nombre: foundName });
                        return;
                    }
                }
            } catch (err) {
                console.error("Error in awaiting_advisor_reason flow:", err.message);
            }

            // Fallback: comunicar con humano
            try {
                const chat = await client.getChatById(GROUP_ID);
                if (chat) {
                    let realPhone = userId.replace(/\D/g, '');
                    try {
                        const contact = await message.getContact();
                        if (contact && contact.number) realPhone = contact.number;
                    } catch (e) { }
                    await chat.sendMessage(`🚨 *Atención Asesor Requerida* (@${realPhone})\n\nMotivo del cliente: "${inputToUse}"`);
                }
            } catch (error) {
                console.error('Error enviando mensaje al grupo:', error);
            }
            await message.reply("🤖 Entendido. He notificado a un asesor humano sobre tu solicitud. Un asesor te responderá por este chat lo más pronto posible. He silenciado mis respuestas automáticas de charla general para no interrumpir.");
            userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot', advisorReason: inputToUse.trim() });
            break;
        case 'waiting_human':
            console.log(`[DEBUG] Usuario ${userId} en modo waiting_human.`);
            const currentSt = userStates.get(userId) || {};
            const count = currentSt.waitingCount || 0;

            // Filtro para detectar mensajes casuales, citas/versículos, agradecimientos o cierres
            const msgText = (message.body || "").toLowerCase().trim();
            const isCasualOrClosing = [
                'gracias', 'muchas gracias', 'dios te bendiga', 'dios los bendiga',
                'ok', 'vale', 'listo', 'perfecto', 'excelente', 'proverbios',
                'salmos', 'juan', 'mateo', 'lucas', 'amén', 'amen', 'bendiciones',
                'chao', 'hasta luego', 'buen dia', 'buen día', 'buenas noches'
            ].some(kw => msgText.includes(kw)) || msgText.startsWith('proverbios') || msgText.startsWith('salmos');

            const isTechnicalError = msgText.includes('error') || msgText.includes('fallo') || msgText.includes('falla') || msgText.includes('no me deja') || msgText.includes('no puedo') || msgText.includes('clave') || msgText.includes('contraseña') || msgText.includes('bloqueo') || msgText.includes('hogar') || msgText.includes('pantalla') || msgText.includes('no sirve') || message.hasMedia;

            if (isCasualOrClosing && !isTechnicalError) {
                userStates.delete(userId);
                console.log(`[Waiting Human Cleanup] Limpiado estado waiting_human para @${userId} por mensaje casual/cierre ("${msgText}").`);
                if (msgText.includes('dios') || msgText.includes('bendig') || msgText.includes('proverbios') || msgText.includes('salmos') || msgText.includes('amen')) {
                    await message.reply("¡Amén y muchas gracias! Que tengas un día muy bendecido. 🙏😊");
                } else if (msgText.includes('gracias') || msgText.includes('excelente') || msgText.includes('perfecto')) {
                    await message.reply("¡Con mucho gusto! Me alegra poder ayudarte. ¡Que disfrutes tu servicio! 😊🎬");
                }
                break;
            }

            // Update user state first so they are placed at the end of the queue
            userStates.set(userId, { ...currentSt, waitingCount: count + 1, waitingTimestamp: Date.now() });

            const { getQueuePosition } = require('./supportScheduleService');
            const pos = getQueuePosition(userId, userStates) || 1;

            if (count > 0) {
                await message.reply(`🤖 ¡Claro que sí te vamos a solucionar! Tu mensaje ha sido recibido y sigues en nuestra cola de soporte.\n\nEn este momento aún no ha llegado tu turno, pero si estamos dentro del horario laboral, ¡estamos trabajando durísimo para llegar a atenderte lo más pronto posible! 💪✨\n\n⚠️ *Aviso automático:* Cada vez que envías un mensaje nuevo, el sistema te mueve al último lugar de la fila para dar prioridad a los chats que llevan más tiempo esperando (¡entre más mensajes envíes, más se retrasará tu atención y más difícil será llegar a tu turno!).\n\n📍 *Tu posición actual en la fila es la número ${pos}.*`);
            }
            break;
        case 'awaiting_purchase_platforms':
            await handleAwaitingPurchasePlatforms(message, userId, userStates, client, GROUP_ID, detection);
            break;
        case 'selecting_plans':
            await handleSelectingPlans(message, userId, userStates);
            break;
        case 'adding_platform':
            await handleAddingPlatform(message, userId, userStates);
            break;
        case 'awaiting_name_for_contact':
            const name = (message.body || "").trim();
            try {
                const { addNewContact } = require('./googleContactsService');
                await addNewContact(name, userId.replace('@c.us', '')).catch(() => null);
            } catch (e) { }
            
            const prev = userStates.get(userId) || {};
            const clientName = name;

            if (prev.detectedPlatform) {
                userStates.set(userId, { ...prev, state: 'awaiting_purchase_platforms', nombre: clientName });
                await message.reply(`🤖 ¡Un placer conocerte, *${clientName}*! Ya quedaste registrado en nuestra base de datos.`);
                await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
                break;
            }

            userStates.set(userId, { state: 'main_menu', nombre: clientName });
            await message.reply("🤖 ¡Un placer conocerte, *" + clientName + "*! Ya quedaste registrado en nuestra base de datos. Ahora sí, ¿en qué te puedo ayudar hoy?\n\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)");
            break;
        case 'awaiting_churn_reason':
            const reason = (message.body || "").trim();
            const lowerReason = reason.toLowerCase();
            const cState = userStates.get(userId) || {};

            // Si la respuesta en realidad es una intención de compra o cambio a otra plataforma (ej: "Quiero Amazon prime video")
            const isPurchaseAttempt = ['comprar', 'pagar', 'renovar', 'soporte'].includes(detection.intent) ||
                detection.detectedPlatform ||
                lowerReason.includes('quiero') ||
                lowerReason.includes('tienen') ||
                lowerReason.includes('tiene') ||
                lowerReason.includes('precio') ||
                lowerReason.includes('venden') ||
                lowerReason.includes('cambiar') ||
                lowerReason.includes('amazon') ||
                lowerReason.includes('disney') ||
                lowerReason.includes('spotify') ||
                lowerReason.includes('youtube') ||
                lowerReason.includes('hbo') ||
                lowerReason.includes('max') ||
                lowerReason.includes('apple') ||
                lowerReason.includes('paramount') ||
                lowerReason.includes('crunchyroll');

            if (isPurchaseAttempt) {
                console.log(`[Churn Guard] Cliente en awaiting_churn_reason expresó intención de compra/cambio: "${reason}". Redirigiendo a compra.`);
                userStates.delete(userId);
                const targetPlatform = detection.detectedPlatform || (lowerReason.includes('amazon') || lowerReason.includes('prime') ? 'Amazon' : null);
                if (targetPlatform) {
                    const { processCheckPrices } = require('./billingService');
                    await processCheckPrices(message, userId, userStates, reason, targetPlatform, 1);
                } else {
                    const { handleSubscriptionInterest } = require('./salesService');
                    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
                }
                break;
            }

            // Si la razón de cancelación es almacenamiento/espacio en Outlook/Microsoft/correo
            const isStorageIssue = lowerReason.includes('almacenamiento') ||
                lowerReason.includes('espacio') ||
                lowerReason.includes('15gb') ||
                lowerReason.includes('15 gb') ||
                lowerReason.includes('correo lleno') ||
                lowerReason.includes('capacidad') ||
                lowerReason.includes('disco') ||
                lowerReason.includes('memoria') ||
                lowerReason.includes('onedrive');

            if (isStorageIssue) {
                let storageMsg = `🤖 ¡Espera! Las cuentas de *Microsoft 365 / Outlook* que ofrecemos incluyen *1 TB (1.000 GB)* de almacenamiento. 💾\n\n` +
                    `¿Te aparece el aviso de límite de *15 GB* en tu correo? Por favor envíame un *pantallazo* (captura de pantalla) del aviso o error que ves para guiarte y ayudarte a solucionar el problema de inmediato. 😊`;
                await message.reply(storageMsg);
                userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        await groupChat.sendMessage(`🚨 *SOPORTE ALMACENAMIENTO OUTLOOK/M365* de @${getDisplayPhone()}\n` +
                            `El cliente solicitó cancelar por almacenamiento: "${reason}".\n` +
                            `Se le ofreció soporte y pidió pantallazo del aviso de 15GB/espacio.`);
                    }
                } catch (e) { }
                break;
            }

            if (cState.rowNumber) {
                const { updateExcelData } = require('./apiService');
                try {
                    const dateStr = new Date().toLocaleDateString('es-CO');
                    const finalReason = `cortar ${reason} (bot ${dateStr})`;
                    await updateExcelData(cState.rowNumber, { "observaciones": finalReason });
                    console.log(`[Churn] Razón guardada en fila ${cState.rowNumber}: ${finalReason}`);
                } catch (e) {
                    console.error("[Churn] Error guardando razón en Excel:", e.message);
                }
            }
            await message.reply("🤖 ¡Muchas gracias por tu comentario! Lo tendré muy en cuenta. ¡Aquí tienes tu casa para cuando decidas volver! 👋");
            userStates.delete(userId);
            break;
        default:
            const historyText = await getChatHistoryText(message);
            await processFallbackWithEscalation(message, userId, isMedia, mediaData.length > 0 ? mediaData : null, historyText);
            break;
    }
}

/**
 * Envía una respuesta al cliente solo si no han llegado mensajes nuevos para el mismo usuario
 * durante el tiempo de procesamiento, evitando "pisar" al usuario con respuestas stale.
 */
async function safeReply(message, content, userId) {
    if (!content || content.trim() === '👍' || content.trim() === '🤖\n👍' || content.trim() === '🤖 👍') {
        console.log(`[Safe Reply] 🛑 Omitiendo respuesta vacía o emoji suelto.`);
        return null;
    }
    const { safeSend } = require('./billingService');
    return await safeSend(message, content, userId);
}

// Cola global secuencial para procesar mensajes con delays anti-spam entre usuarios
const globalMessageQueue = [];
let isProcessingGlobalQueue = false;

async function addToGlobalProcessingQueue(userId, batch) {
    globalMessageQueue.push({ userId, batch });
    triggerGlobalQueueProcessing();
}

async function triggerGlobalQueueProcessing() {
    if (isProcessingGlobalQueue) return;
    isProcessingGlobalQueue = true;

    while (globalMessageQueue.length > 0) {
        const item = globalMessageQueue.shift();
        try {
            console.log(`[Global Queue] Procesando lote para @${item.userId.replace('@c.us', '')}. Quedan en cola: ${globalMessageQueue.length}`);
            
            // Timeout de seguridad de 60s para que un mensaje trabado nunca bloquee al resto de clientes
            await Promise.race([
                processIncomingMessage(item.batch),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout procesando lote (60s)")), 60000))
            ]);

            // Si quedan elementos en la cola, esperamos un delay humano de seguridad (2 a 5 segundos) antes del siguiente
            if (globalMessageQueue.length > 0) {
                const delay = Math.floor(Math.random() * 3000) + 2000;
                console.log(`[Global Queue] Esperando delay de seguridad de ${(delay / 1000).toFixed(1)}s antes de procesar el siguiente usuario...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        } catch (err) {
            console.error(`[Global Queue] Error procesando lote para @${item.userId}:`, err.message);
        }
    }

    isProcessingGlobalQueue = false;
}

/**
 * Event Listener principal
 */
client.on('message', async (message) => {
    // 0. IGNORAR ABSOLUTAMENTE TODOS LOS ESTADOS / HISTORIAS DE WHATSAPP
    if (!message || !message.from || message.from.includes('status@broadcast') || message.isStatus || message.type === 'status_v3' || message.type === 'status') {
        return;
    }

    // Manejo de mensajes antiguos al iniciar el bot
    if (message.timestamp < BOT_START_TIME) {
        if (message.from.includes('@g.us') || message.from.includes('status@broadcast')) return;
        const shouldProcess = await new Promise(resolve => {
            startupLock = startupLock.then(async () => {
                try {
                    const chat = await message.getChat();
                    const msgs = await chat.fetchMessages({ limit: 5 });
                    let isRecentHuman = false;
                    let lastHumanTimestamp = 0;
                    const nowSec = Math.floor(Date.now() / 1000);

                    for (const m of msgs) {
                        if (m.fromMe && !m.body.includes('🤖')) {
                            // Solo considerar como conversación humana activa si ocurrió en los últimos 15 minutos
                            const ageMinutes = (nowSec - m.timestamp) / 60;
                            if (ageMinutes <= 15) {
                                isRecentHuman = true;
                                lastHumanTimestamp = m.timestamp * 1000;
                                break;
                            }
                        }
                    }

                    if (isRecentHuman) {
                        userStates.set(message.from, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: lastHumanTimestamp || Date.now(), waiting_human_mode: 'advisor' });
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                } catch (e) { resolve(true); }
            });
        });
        if (!shouldProcess) return;
    }

    // Ignorar propios excepto si es un comando de bot/administración
    if (message.fromMe) {
        const b = message.body ? message.body.toLowerCase().trim() : '';
        if (!b.startsWith('@bot') && !b.startsWith('!bot') && !b.includes('@bot')) {
            return;
        }
    }

    // Guardar último mensaje en el estado del usuario para evitar llamadas lentas a Puppeteer en el dashboard
    if (!message.from.includes('@g.us') && !message.from.includes('status@broadcast')) {
        let st = userStates.get(message.from);
        if (st && typeof st === 'object') {
            st.lastMessage = message.body || "";
            st.lastMessageTime = message.timestamp * 1000;
            userStates.set(message.from, st);
        }
    }

    // Filtros de grupo
    if (message.from.includes('@g.us')) {
        try {
            const chat = await message.getChat();
            console.log(`[GROUP MSG] Grupo: "${chat.name}" | ID: ${message.from} | De: ${message.author || message.from} | Mensaje: ${message.body || '[Sin texto]'}`);
        } catch (e) {
            console.log(`[GROUP MSG] ID: ${message.from} | De: ${message.author || message.from} | Mensaje: ${message.body || '[Sin texto]'}`);
        }
        // Los mensajes de grupo se procesan si contienen comando @bot o confirmaciones
        const b = message.body ? message.body.toLowerCase().trim() : '';
        const isBotCommand = b.startsWith('@bot') || b.startsWith('!bot') || b.includes('@bot');
        let groupState = userStates.get(message.from);
        if (groupState && typeof groupState === 'object') groupState = groupState.state;

        if (isBotCommand || groupState === 'awaiting_cobros_confirmation' || b.includes('liberar masivo') || b.startsWith('!liberar') || b.startsWith('liberar ') || b.startsWith('confirmar_cobros ')) {
            await processIncomingMessage([message]);
        }
        return;
    }

    if (message.from.includes('status@broadcast')) return;
    if (globalBotSleep && message.from !== OPERATOR_NUMBER && message.from !== GROUP_ID) return;

    // Verificar si el remitente es un proveedor registrado (no responder con bot de ventas)
    try {
        const isProv = await isProviderSender(message.from);
        if (isProv) {
            console.log(`[PROVIDER MSG IGNORED] Mensaje recibido de proveedor @${message.from.replace('@c.us', '')}. El bot no responderá automáticamente.`);
            userStates.set(message.from, { state: 'waiting_human', waiting_human_mode: 'advisor', is_provider: true });
            return;
        }
    } catch (e) { }

    // --- MECANISMO DE BATCHING PARA MENSAJES INDIVIDUALES ---
    const userId = message.from;
    if (!messageQueues.has(userId)) {
        messageQueues.set(userId, { messages: [], timer: null });
    }

    const queue = messageQueues.get(userId);
    if (queue.timer) clearTimeout(queue.timer);

    queue.messages.push(message);

    const hasAnyMedia = queue.messages.some(m => m.hasMedia || m.type === 'image' || m.type === 'document');
    const dynamicBatchInterval = hasAnyMedia ? 20000 : BATCH_INTERVAL;

    queue.timer = setTimeout(async () => {
        const batch = [...queue.messages];
        messageQueues.delete(userId);
        console.log(`[Batch Processor] Encolando lote de ${batch.length} mensajes (media: ${hasAnyMedia}, wait: ${dynamicBatchInterval}ms) para @${userId.replace('@c.us', '')}`);
        await addToGlobalProcessingQueue(userId, batch);
    }, dynamicBatchInterval);
});


// Funciones de manejo de estados
async function handleMainMenuSelection(message, userId, detection, isMedia = false, singleMediaData = null) {
    const inputToUse = message.body || "";
    const existingState = userStates.get(userId) || {};
    const foundName = existingState.nombre || null;
    const userSelection = message.body.trim();
    switch (userSelection) {
        case '1':
            const existing = userStates.get(userId) || {};
            if (detection && detection.detectedPlatform) {
                console.log(`[Menu Context] Usuario seleccionó 1 pero ya había mencionado: ${detection.detectedPlatform}`);
                userStates.set(userId, { ...existing, state: 'awaiting_purchase_platforms', nombre: foundName });
                await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
            } else {
                await startPurchaseProcess(message, userId, userStates);
            }
            break;
        case '2':
            await processCheckCredentials(userId, client, message.body, "", userStates);
            break;
        case '3':
            await processCheckPrices(message, userId, userStates);
            break;
        case '4':
            await message.reply("🤖 *Soporte Técnico Sheerit*\n\nPor favor describe tu problema detalladamente o envíame una captura de pantalla del error que estás experimentando. Te guiaré paso a paso para solucionarlo.\n\n⚠️ *Nota:* Nuestra atención es **exclusivamente por chat**, no atendemos llamadas.\n\nSi el problema es complejo, escribe *5* en cualquier momento para hablar con un asesor humano.");

            break;
        case '5':
            await message.reply("🤖 Para poder ayudarte mejor y resolver tu solicitud lo antes posible, por favor escribe detalladamente qué necesitas consultar con el asesor (ej. dudas sobre un pago, cambio de plan, soporte técnico, etc.).\n\nEl bot analizará tu respuesta y, si es necesario, te comunicará con un asesor de inmediato.");
            userStates.set(userId, { state: 'awaiting_advisor_reason', nombre: foundName });
            break;
        default:
            if (detection) {
                if (detection.intent === 'comprar') {
                    userStates.set(userId, { state: 'awaiting_purchase_platforms' });
                    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
                    return;
                } else if (detection.intent === 'pagar' || detection.intent === 'renovar') {
                    const durationMonths = getDurationMonths(detection, inputToUse);
                    await processCheckPrices(message, userId, userStates, inputToUse, detection.detectedPlatform, durationMonths);
                    return;
                } else if (detection.intent === 'credenciales') {
                    await processCheckCredentials(userId, client, message.body, "", userStates);
                    return;
                } else if (detection.intent === 'duda_contexto') {
                    if (await hasRecentHumanMessage(message)) {
                        console.log(`[Bypass Bot Reply] Silenciando respuesta 'duda_contexto' por mensaje humano reciente en las últimas 6 horas.`);
                        return;
                    }
                    const history = await getChatHistoryText(message);
                    let accounts = [];
                    try { accounts = await getAccountsByPhone(realPhone, foundName); } catch (e) { }
                    const fallback = await generateEmpatheticFallback(message.body || "", isMedia, history, singleMediaData, accounts);
                    if (fallback.replyMessage) {
                        await message.reply(fallback.replyMessage);
                    }
                    return;
                } else if (detection.intent === 'soporte') {
                    if (await hasRecentHumanMessage(message)) {
                        console.log(`[Bypass Bot Reply] Silenciando respuesta 'soporte' por conversación humana activa reciente.`);
                        userStates.set(userId, { state: 'waiting_human', waiting_human_mode: 'advisor', lastHumanInteraction: Date.now() });
                        return;
                    }
                    const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                    const supportStatus = await isSupportOpen();

                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

                    if (!supportStatus.open) {
                        const { getOfflineReplyMessage } = require('./supportScheduleService');
                        const offlineMsg = await getOfflineReplyMessage(userId, userStates);
                        await safeReply(message, offlineMsg, userId);
                    } else {
                        const queuePos = getQueuePosition(userId, userStates);
                        let replyText = "🤖 Entendido. He transferido tu caso a soporte técnico. Un asesor humano te atenderá lo antes posible.";
                        if (queuePos) {
                            replyText += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}. ¡Gracias por tu paciencia!`;
                        }
                        await safeReply(message, replyText, userId);
                    }
                    return;
                }
            }

            if (await hasRecentHumanMessage(message)) {
                console.log(`[Bypass Bot Reply] Silenciando respuesta general/fallback por mensaje humano reciente en las últimas 6 horas.`);
                return;
            }
            const history = await getChatHistoryText(message);

            let accounts = [];
            try { accounts = await getAccountsByPhone(realPhone, foundName); } catch (e) { }

            const fallback = await generateEmpatheticFallback(message.body || "", isMedia, history, singleMediaData, accounts);

            if (fallback.replyMessage && !fallback.replyMessage.includes("Por favor, selecciona una opción válida")) {
                await message.reply(fallback.replyMessage);

                if (fallback.needsEscalation) {
                    const chat = await client.getChatById(GROUP_ID);
                    if (chat) {
                        let contact;
                        try {
                            contact = await message.getContact();
                        } catch (e) {
                            contact = { number: userId.replace(/\D/g, '') };
                        }
                        const realPhone = (contact && contact.number) ? contact.number : userId.replace(/\D/g, '');
                        await chat.sendMessage(`🚨 *ESCALACIÓN DESDE EL MENÚ* (@${realPhone})\nResumen: ${fallback.escalationSummary}`);
                    }
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot', advisorReason: fallback.escalationSummary }); // No seteamos lastHumanInteraction para permitir reactivación por IA si el cliente pide otra cosa
                }
            } else {
                await message.reply("🤖 Por favor, selecciona una opción válida del menú (1-5), o escribe tu duda para ayudarte.");
            }
            break;
    }
}


async function handleRenewalModification(message, userId, textToUse, stateData) {
    if (!stateData.isRenewal || !stateData.items || stateData.items.length === 0) return false;

    const cleanText = (textToUse || '').trim().toLowerCase();
    if (!cleanText) return false;

    // Si el texto es un número aislado (como "1", "2", "3", "4", "5"), JAMÁS es una modificación de renovación
    if (/^\d+$/.test(cleanText)) {
        return false;
    }

    try {
        const { analyzeRenewalModification } = require('./aiService');
        const modification = await analyzeRenewalModification(textToUse, stateData.items);
        if (modification && modification.shouldModify) {
            console.log(`[Renewal Mod] User requested modification for @${userId}:`, modification);

            const originalItems = stateData.items;
            let updatedItems = [];

            if (modification.rowsToRenew && Array.isArray(modification.rowsToRenew) && modification.rowsToRenew.length > 0) {
                const targetRows = modification.rowsToRenew.map(r => String(r));
                updatedItems = originalItems.filter(item => {
                    const row = String(item._rowNumber || item.index || '');
                    return targetRows.includes(row);
                });
            }

            if (updatedItems.length === 0 && modification.platformsToRenew && modification.platformsToRenew.length > 0) {
                updatedItems = originalItems.filter(item => {
                    const name = (item.Streaming || (item.platform ? item.platform.name : '') || item.name || '').toLowerCase();
                    return modification.platformsToRenew.some(p => name.includes(p.toLowerCase()) || p.toLowerCase().includes(name));
                });
            }

            const excludedItems = originalItems.filter(item => !updatedItems.includes(item));
            const churnRows = excludedItems.map(item => item._rowNumber || item.index).filter(Boolean);
            if (excludedItems.length > 0) {
                const { updateExcelData } = require('./apiService');
                const dateStr = new Date().toLocaleDateString('es-CO');
                for (const row of churnRows) {
                    try {
                        await updateExcelData(row, { "observaciones": `cortar (bot ${dateStr})` });
                        console.log(`[Renewal Mod] Fila ${row} marcada como cortar (bot)`);
                    } catch (e) {
                        console.error(`[Renewal Mod] Error al marcar cortar para fila ${row}:`, e.message);
                    }
                }
            }

            if (updatedItems.length === 0) {
                const excludedNames = excludedItems.map(item => (item.Streaming || item.name || '').toUpperCase()).join(', ');
                await message.reply(`🤖 Entendido, he marcado tu renovación para no continuar con los servicios: *${excludedNames}*. Lamento mucho que hoy no podamos continuar con tu servicio. 😔\n\n¿Podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho a ser mejores.`);
                userStates.set(userId, {
                    ...stateData,
                    state: 'awaiting_churn_reason',
                    rowNumber: churnRows[0],
                    churnPlatforms: churnRows
                });
                return true;
            }

            const { getPlatformKnowledge, getTodayInBogota } = require('./apiService');
            const platforms = await getPlatformKnowledge();
            const today = getTodayInBogota();
            const duration = stateData.durationMonths || 1;

            let total = 0;
            let finalItems = [];
            updatedItems.forEach(item => {
                const streaming = (item.Streaming || "").toUpperCase();
                let price = 0;
                let mappedStreaming = streaming;
                const aliasMap = {
                    'AMAZON': 'PRIME VIDEO', 'PRIME': 'PRIME VIDEO', 'APPLE TV': 'APPLE TV+',
                    'HBO': 'HBOMAX', 'MAX': 'HBOMAX', 'DISNEY': 'DISNEY+ PREMIUM',
                    'STAR': 'DISNEY+ PREMIUM', 'YOUTUBE': 'YOUTUBE PREMIUM', 'MICROSOFT': 'MICROSOFT 365'
                };
                for (const [alias, real] of Object.entries(aliasMap)) {
                    if (mappedStreaming.includes(alias)) {
                        mappedStreaming = mappedStreaming.replace(alias, real);
                        break;
                    }
                }
                const cleanExcel = mappedStreaming.replace(/[^A-Z0-9]/g, '');
                const platInfo = platforms.find(p => {
                    const cleanPlat = p.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                    return cleanExcel.includes(cleanPlat) || cleanPlat.includes(cleanExcel);
                });
                if (platInfo) {
                    price = platInfo.price || 0;
                    if (platInfo.name.toUpperCase() === 'SPOTIFY' && !cleanExcel.includes('PROPORCIONADO') && !cleanExcel.includes('OWNER')) {
                        const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL'));
                        if (personalPlan) price = personalPlan.price;
                    } else if (platInfo.plans && platInfo.plans.length > 0) {
                        const specificPlan = platInfo.plans.find(plan => {
                            const cleanPlan = plan.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            return cleanExcel.includes(cleanPlan) || cleanPlan.includes(cleanExcel);
                        });
                        if (specificPlan) price = specificPlan.price;
                    }
                }
                const itemPrice = price * duration;
                total += itemPrice;
                finalItems.push({ ...item, price: itemPrice });
            });

            const imminentRenewals = finalItems.filter(item => {
                const expDate = require('./apiService').getJsDateFromExcel(item.deben || item.vencimiento);
                if (!expDate) return false;
                const diffDays = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
                return diffDays <= 1;
            });
            if (total > 0 && imminentRenewals.length > 1) {
                const discount = (imminentRenewals.length - 1) * 1000 * duration;
                total -= discount;
            }

            userStates.set(userId, {
                ...stateData,
                state: 'awaiting_payment_method',
                total: total,
                items: finalItems,
                checkAmount: 0,
                churnPlatforms: churnRows.length > 0 ? churnRows : null
            });

            let newMsg = '';
            if (excludedItems.length > 0) {
                const excludedNames = excludedItems.map(item => (item.Streaming || item.name || '').toUpperCase()).join(', ');
                newMsg = `🤖 Entendido. He quitado *${excludedNames}* de tu lista de renovación. Lamento mucho que hoy no podamos continuar con ese servicio. 😔 ¿Podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho a mejorar.\n\n`;
            } else {
                newMsg = `${modification.reply}\n\n`;
            }

            newMsg += `💰 *NUEVO TOTAL A PAGAR: $${total}*\n\n` +
                `Puedes transferir por:\n` +
                `🔑 *Llave Bre-V:* \`0087387259\` (AUTOMÁTICA ⚡)\n` +
                `⭐ *Bancolombia Ahorros:* \`46772753713\` (CC: 1032936324)\n\n` +
                `Una vez realizado el pago, envíame la captura del comprobante por aquí. 🤖`;
            await message.reply(newMsg);
            return true;
        }
    } catch (err) {
        console.error("Error in handleRenewalModification interceptor:", err.message);
    }
    return false;
}

async function handleAwaitingPaymentMethod(message, userId, isMedia = false, singleMediaData = null, text = null) {
    const textToUse = text || message.body || '';
    const stateData = userStates.get(userId) || {};

    // Si tenemos plataformas de churn pendientes de razón y el cliente responde con texto (no un comprobante ni método)
    const hasChurnPlatforms = stateData.churnPlatforms && stateData.churnPlatforms.length > 0;
    const isPaymentMethod = ['nequi', 'daviplata', 'bancolombia', 'llave', 'qr', 'efectivo', 'pagar', 'comprobante', 'recibo', 'medio', 'transf', 'banco'].some(k => textToUse.toLowerCase().includes(k));

    if (hasChurnPlatforms && !isPaymentMethod && !message.hasMedia && textToUse.trim().length > 3) {
        const { updateExcelData } = require('./apiService');
        const cleanReason = textToUse.trim();
        console.log(`[Churn Auto-Collector] Recibida razón de churn de @${userId}: "${cleanReason}" para filas:`, stateData.churnPlatforms);
        for (const row of stateData.churnPlatforms) {
            await updateExcelData(row, { observaciones: `cortar - ${cleanReason} (bot)` }).catch(e => { });
        }
        await message.reply("🤖 Muchas gracias por tu retroalimentación, la tendremos en cuenta para mejorar. 😊 ¿Por cuál de los medios mencionados anteriormente deseas realizar el pago de tu renovación?");

        stateData.churnPlatforms = null;
        userStates.set(userId, stateData);
        return;
    }

    const wasModified = await handleRenewalModification(message, userId, textToUse, stateData);
    if (wasModified) return;

    await processPaymentSelection(message, userId, textToUse, isMedia, singleMediaData);
}

async function processPaymentSelection(message, userId, text, isMedia = false, singleMediaData = null) {
    // Usar AI para detectar método de pago
    const method = await detectPaymentMethod(text);

    // Cargar config dinámica de pagos
    let paymentDetails = {
        'nequi': "🤖 *Nequi (AUTOMÁTICA ⚡)*\n\nPor favor realiza tu transferencia usando nuestra *Llave Bre-V* o *QR de Negocios* para recibir entrega inmediata. ⚡\n\n🔑 *Llave Bre-V:* `0087387259` (AUTOMÁTICA ⚡)",
        'daviplata': "🤖 *Daviplata (AUTOMÁTICA ⚡)*\n\nPor favor realiza tu transferencia usando nuestra *Llave Bre-V* o *QR de Negocios* para recibir entrega inmediata. ⚡\n\n🔑 *Llave Bre-V:* `0087387259` (AUTOMÁTICA ⚡)",
        'bancolombia': "🤖 *Bancolombia (Abono Directo - VALIDACIÓN AUTOMÁTICA ⚡)*\n\nNúmero de cuenta: 46772753713\nTipo: Ahorros\nCC: 1032936324\n\n💡 *Tip:* La validación es automática (sujeta a que Bancolombia envíe la notificación a tiempo; de lo contrario, un asesor validará manualmente).",
        'llave': "🤖 *LLAVE Bre-V (ENTREGA INMEDIATA ⚡)*\n\n🔑 *Llave Bre-V:* `0087387259` o `1032936324` (AUTOMÁTICA ⚡)",
        'qr negocios': "🤖 *QR Negocios (RECOMENDADO - ENTREGA INMEDIATA ⚡)*\n\nPor favor, escanea el código que te envío a continuación para la **activación automática** inmediata. ⚡"
    };

    let enabledDetails = {};
    try {
        const { getPaymentConfig } = require('./paymentConfigService');
        const config = getPaymentConfig();

        // Map keys
        const keyMap = {
            'nequi': 'nequi',
            'daviplata': 'daviplata',
            'bancolombia': 'bancolombia',
            'llave': 'llave',
            'qr negocios': 'qr_negocios'
        };

        for (const key of Object.keys(paymentDetails)) {
            const configKey = keyMap[key];
            if (config[configKey] && config[configKey].enabled) {
                let desc = config[configKey].description || paymentDetails[key];

                if (config[configKey].sub_methods) {
                    const activeSubs = config[configKey].sub_methods.filter(s => s.enabled);
                    if (activeSubs.length > 0) {
                        const keysMsg = "\n\n🔑 *Llave Bre-V:* " + activeSubs.map(s => {
                            const tag = s.automatic ? " (AUTOMÁTICA ⚡)" : " (VERIFICACIÓN MANUAL)";
                            return `\`${s.value}\` (${s.label})${tag}`;
                        }).join(' o ');
                        desc = desc + keysMsg;
                    }
                }
                enabledDetails[key] = desc;
            }
        }
    } catch (e) {
        console.error("Error loading payment config in processPaymentSelection:", e.message);
        enabledDetails = paymentDetails;
    }

    const lowerText = text.toLowerCase();
    const isQrRequest = lowerText.includes('qr') || lowerText.includes('código') || lowerText.includes('codigo') || lowerText.includes('consignar') || lowerText.includes('cuenta para');

    if (isQrRequest && enabledDetails['qr negocios']) {
        const { MessageMedia } = require('whatsapp-web.js');
        const qrPath = path.join(__dirname, 'uploads', 'qr_pago.jpeg');
        if (fs.existsSync(qrPath)) {
            try {
                const media = MessageMedia.fromFilePath(qrPath);
                await message.reply(media, undefined, { caption: "🤖 Aquí tienes nuestro *QR de Negocios* oficial. Si pagas con este QR, tu pago será validado por el bot haciendo la entrega o renovación inmediata. ⚡" });
            } catch (e) {
                console.error("Error enviando QR:", e.message);
                await message.reply("🤖 No pude enviar la imagen del QR en este momento, pero puedes usar los datos de texto abajo.");
            }
        } else {
            await message.reply("🤖 Aún no tengo configurada la imagen del QR oficial, pero puedes usar estos datos para transferir (recuerda que el QR agiliza tu entrega):");
        }
    } else if (isQrRequest && !enabledDetails['qr negocios']) {
        const activeLabels = Object.keys(enabledDetails).map(k => k.toUpperCase());
        await message.reply(`🤖 El *QR de Negocios* no está activo en este momento. Por favor utiliza uno de los siguientes medios activos: *${activeLabels.join(', ')}*.`);
    }

    // Mapeo dinámico para manejar 'llave' o 'llaves'
    let methodToUse = method;
    if (!methodToUse && (lowerText.includes('llave') || lowerText.includes('bre-v') || lowerText.includes('brev') || lowerText.includes('bre v') || lowerText.includes('bre-b') || lowerText.includes('breb') || lowerText.includes('bre b'))) methodToUse = 'llave';

    if (methodToUse && enabledDetails[methodToUse]) {
        const state = userStates.get(userId) || {};
        let finalMsg = enabledDetails[methodToUse];
        if (state.isRenewal) {
            finalMsg += "\n\n💡 *Tip de Renovación:* Si pagas con un método automático (como el QR, la Llave Bre-V o Bancolombia), tu renovación se procesará al instante. **¡Así no se te volverá a repetir este recordatorio de cobro ni un solo día más, ya que tu fecha de vencimiento se actualiza de inmediato!** ⚡🤖";
        }
        await message.reply(finalMsg);
        userStates.set(userId, typeof state === 'string' ? { state: 'awaiting_payment_confirmation' } : { ...state, state: 'awaiting_payment_confirmation' });
    } else if (methodToUse && !enabledDetails[methodToUse]) {
        const activeLabels = Object.keys(enabledDetails).map(k => k.toUpperCase());
        await message.reply(`🤖 El método de pago *${methodToUse.toUpperCase()}* no está disponible temporalmente. Puedes realizar la transferencia por: *${activeLabels.join(', ')}*.`);
    } else {
        // Fallback manual check
        let foundKey = Object.keys(enabledDetails).find(key => lowerText.includes(key));
        if (foundKey) {
            const state = userStates.get(userId) || {};
            let finalMsg = enabledDetails[foundKey];
            if (state.isRenewal) {
                finalMsg += "\n\n💡 *Tip de Renovación:* Si pagas con un método automático (como el QR, la Llave Bre-V o Bancolombia), tu renovación se procesará al instante. **¡Así no se te volverá a repetir este recordatorio de cobro ni un solo día más, ya que tu fecha de vencimiento se actualiza de inmediato!** ⚡🤖";
            }
            await message.reply(finalMsg);
            userStates.set(userId, typeof state === 'string' ? { state: 'awaiting_payment_confirmation' } : { ...state, state: 'awaiting_payment_confirmation' });
        } else {
            // Usar la IA en vez del mensaje genérico terco (esto responde precios exactos gracias a aiService)
            const historyTextForFallback = await getChatHistoryText(message);
            await processFallbackWithEscalation(message, userId, isMedia, singleMediaData, historyTextForFallback);
        }
    }
}

async function handleAwaitingPaymentConfirmation(message, userId, isMedia = false, singleMediaData = null) {
    const body = (message.body || '').toLowerCase().trim();

    // --- EVITAR DUPLICADO SI SE ACABA DE VALIDAR EL PAGO ---
    const stateData = userStates.get(userId) || {};

    if (stateData.isRenewal && stateData.items && stateData.items.length > 0 && body && !message.hasMedia) {
        const wasModified = await handleRenewalModification(message, userId, message.body, stateData);
        if (wasModified) return;
    }

    const lastValidated = stateData.lastPaymentValidated || 0;
    const timeSinceValidation = Date.now() - lastValidated;

    if (timeSinceValidation < 1000 * 60 * 5) { // 5 minutos de gracia
        await message.reply("🤖 ¡Así es! Ya registré tu pago al instante y te entregué tu cuenta. ¡Es un hecho! A disfrutar de tus pantallas. 😎🎬");
        userStates.set(userId, { ...stateData, state: 'main_menu' });
        return;
    }

    // Check if user is trying to switch payment method
    const newMethodCheck = await detectPaymentMethod(message.body);
    console.log(`[DEBUG] Payment switch check for '${message.body}': ${newMethodCheck}`);

    // Evitar falsos positivos en preguntas o frases largas (más de 2 palabras)
    const isQuestionOrLongPhrase = body.split(/\s+/).length > 2;

    if (newMethodCheck && !isQuestionOrLongPhrase) {
        await message.reply("🤖 Entendido, cambiamos el método de pago.");
        await processPaymentSelection(message, userId, message.body, isMedia, singleMediaData);
        return;
    }

    const explicitPaymentPhrases = [
        "ya pagu", "ya realice el pago", "ya realice pago", "ya hice el pago", "ya hice pago",
        "ya transferi", "ya deposite", "ya envie el pago", "ya mande el pago", "ya consigne",
        "comprobante de pago", "comprobante", "pantallazo del pago", "aqui esta el pago"
    ];
    const isExplicitPaymentText = explicitPaymentPhrases.some(phrase => body.includes(phrase));

    if (message.hasMedia || isExplicitPaymentText) {

        // --- INTENTO DE VALIDACIÓN AUTOMÁTICA POR IMAGEN ---
        if (message.hasMedia && singleMediaData) {
            console.log(`[AUTO-VALIDATE] Imagen recibida en awaiting_payment_confirmation para ${userId}. Intentando OCR automático...`);
            try {
                const { isPaymentReceipt } = require('./aiService');

                // Llave de validación AUTOMÁTICA (Bre-V - aparece en el comprobante del cliente)
                const AUTO_KEYS = ['0087387259'];
                // Llaves de validación MANUAL (también son nuestras, pero requieren revisión de asesor)
                const MANUAL_KEYS = ['46772753713', '1032936324', '3118587974'];
                const ALL_VALID_KEYS = [...AUTO_KEYS, ...MANUAL_KEYS];
                const normalizeKey = (k) => (k || '').replace(/[\s\-\.]/g, '');

                const check = await isPaymentReceipt(singleMediaData, `El usuario está en estado de confirmación de pago. Carrito: ${JSON.stringify(stateData.items || [])}. Total esperado: $${stateData.total || 'desconocido'}`);
                console.log(`[AUTO-VALIDATE] OCR result: isReceipt=${check.isReceipt}, amount=${check.amount}, bank=${check.bank}, destinationKey=${check.destinationKey}, destinationName=${check.destinationName}`);

                if (check.isReceipt) {
                    const rawKey = normalizeKey(check.destinationKey);
                    const rawName = (check.destinationName || '').toUpperCase();

                    // QR de negocios: el nombre del negocio aparece en vez de la llave
                    const QR_NAMES = ['SHEERIT', 'ESTEBAN AVILA'];
                    const isQrMatch = QR_NAMES.some(n => rawName.includes(n));

                    const isAutoKey = rawKey && AUTO_KEYS.some(vk => rawKey.includes(vk) || vk.includes(rawKey));
                    const isManualKey = rawKey && !isAutoKey && MANUAL_KEYS.some(vk => rawKey.includes(vk) || vk.includes(rawKey));
                    const keyFound = !!rawKey;
                    const isOurKey = isAutoKey || isManualKey;
                    // Auto si es llave Bre-V O si es QR con nombre del negocio
                    const isAutoValidate = isAutoKey || isQrMatch;

                    console.log(`[AUTO-VALIDATE] key="${rawKey}" name="${rawName}" isAutoKey=${isAutoKey} isQrMatch=${isQrMatch} isManualKey=${isManualKey}`);

                    if (keyFound && !isOurKey && !isQrMatch) {
                        // Llave detectada pero NO es la nuestra y no es QR del negocio → decirle al cliente directamente
                        console.log(`[AUTO-VALIDATE] ❌ Llave destino inválida: ${rawKey}`);
                        await message.reply(
                            `🤖 Revisé tu comprobante y encontré que el pago fue enviado a la llave *${check.destinationKey}*, que no corresponde a ninguna de nuestras cuentas de cobro.\n\n` +
                            `✅ *Nuestras cuentas oficiales son:*\n` +
                            `⭐ *Llave Bre-V (NEQUI/Daviplata/Cualquier banco):* \`0087387259\`\n` +
                            `⭐ *Bancolombia Ahorros:* \`46772753713\`\n\n` +
                            `Por favor realiza la transferencia a una de estas cuentas y envía nuevamente el comprobante. 😊`
                        );
                        userStates.set(userId, { ...stateData, state: 'awaiting_payment_confirmation' });
                        return;
                    }

                    if (isManualKey && !isAutoValidate) {
                        // Llave válida pero de validación MANUAL → notificar al grupo y esperar asesor
                        console.log(`[AUTO-VALIDATE] ✅ Llave manual detectada (${rawKey}). Notificando al grupo para validación manual.`);
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                let contact;
                                try { contact = await message.getContact(); } catch (e) { contact = { number: userId.replace(/\D/g, '') }; }
                                const realPhone = (contact && contact.number) ? contact.number : userId.replace(/\D/g, '');
                                await groupChat.sendMessage(
                                    `📸 *COMPROBANTE VALIDADO - REVISIÓN MANUAL* (@${realPhone})\n` +
                                    `Monto: $${check.amount || '?'}\nBanco: ${check.bank || 'Desconocido'}\nLlave destino: ${check.destinationKey}\n\n` +
                                    `⚠️ Es una de nuestras cuentas (manual). Para aprobar: *@bot confirmar ${realPhone}*`
                                );
                            }
                        } catch (e) { }
                        await message.reply("🤖 ¡Gracias! He recibido tu comprobante y lo he enviado a nuestro equipo para validación. En breve un asesor confirmará tu pago y te entregará tus accesos. 😊");
                        userStates.set(userId, { ...stateData, state: 'waiting_admin_confirmation' });
                        await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);
                        return;
                    }

                    if (isAutoValidate) {
                        // ✅ Llave Bre-V correcta o QR del negocio: validar monto y proceder
                        const { adjustDurationToMatchAmount } = require('./billingService');
                        await adjustDurationToMatchAmount(stateData, check.amount, userId);

                        const expectedTotal = Math.max(0, (stateData.total || 0) - (stateData.saldo || 0));
                        const currentAmount = check.amount || 0;
                        const previousPaid = (stateData.checkAmount && stateData.checkAmount !== currentAmount) ? stateData.checkAmount : 0;
                        const totalPaidSoFar = previousPaid + currentAmount;

                        const amountMatches = expectedTotal <= 0 ||
                            Math.abs(currentAmount - expectedTotal) < 500 ||
                            Math.abs(totalPaidSoFar - expectedTotal) < 500 ||
                            currentAmount >= (expectedTotal - 500) ||
                            totalPaidSoFar >= (expectedTotal - 500);

                        if (!amountMatches) {
                            if (expectedTotal > 0 && totalPaidSoFar < expectedTotal && currentAmount < expectedTotal) {
                                console.log(`[AUTO-VALIDATE] ❌ Monto acumulado ${totalPaidSoFar} es menor a esperado ${expectedTotal}. Guardando pago corto.`);
                                userStates.set(userId, {
                                    ...stateData,
                                    state: 'awaiting_payment_confirmation',
                                    paymentMethod: check.bank || 'Transferencia',
                                    checkAmount: totalPaidSoFar
                                });
                                const diff = expectedTotal - totalPaidSoFar;
                                await safeReply(
                                    message,
                                    `🤖 Revisé tu comprobante: detecté un pago de *$${currentAmount.toLocaleString('es-CO')}* a la llave correcta.\n\n` +
                                    `Con esto, has pagado un total de *$${totalPaidSoFar.toLocaleString('es-CO')}* COP de un total de *$${expectedTotal.toLocaleString('es-CO')}* COP. ` +
                                    `Aún hace falta un pago por el valor restante de *$${diff.toLocaleString('es-CO')}* COP. ⚠️\n\n` +
                                    `Por favor realiza la transferencia del monto restante y envía nuevamente el comprobante. 😊`,
                                    userId
                                );
                                await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);
                            } else {
                                console.log(`[AUTO-VALIDATE] ❌ Monto ${currentAmount} no coincide con esperado ${expectedTotal}.`);
                                await safeReply(
                                    message,
                                    `🤖 Revisé tu comprobante: detecté un pago de *$${currentAmount.toLocaleString('es-CO')}* a la llave correcta, ` +
                                    `pero el total de tu pedido es *$${expectedTotal.toLocaleString('es-CO')}*. ` +
                                    `Por favor verifica el monto y envía nuevamente el comprobante correcto. 😊`,
                                    userId
                                );
                            }
                            return;
                        }

                        console.log(`[AUTO-VALIDATE] ✅ Llave y monto válidos. Ejecutando entrega automática...`);

                        let hasNetflix = false;
                        if (stateData.items && Array.isArray(stateData.items)) {
                            hasNetflix = stateData.items.some(item => {
                                const name = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "").toLowerCase();
                                return name.includes('netflix') && !name.includes('extra');
                            });
                        }

                        if (hasNetflix && !stateData.isRenewal) {
                            await message.reply("🤖 ¡Gracias! He verificado tu pago ✅\n\nListo, me confirmas por favor localidad o municipio donde se va a usar y operador de internet\n\nEj. suba-movistar");
                            userStates.set(userId, {
                                ...stateData,
                                state: 'awaiting_netflix_operator_post_payment',
                                paymentMethod: check.bank || 'Transferencia',
                                checkAmount: totalPaidSoFar
                            });
                            return;
                        }

                        const validationResult = await executePaymentValidation(
                            userId,
                            { ...stateData, total: totalPaidSoFar, paymentMethod: `Auto-OCR Llave (${check.bank || 'Transferencia'})` },
                            client, userStates, null, null
                        );

                        if (validationResult.success) {
                            try {
                                const groupChat = await client.getChatById(GROUP_ID);
                                if (groupChat) {
                                    let contact;
                                    try { contact = await message.getContact(); } catch (e) { contact = { number: userId.replace(/\D/g, '') }; }
                                    const realPhone = (contact && contact.number) ? contact.number : userId.replace(/\D/g, '');
                                    await groupChat.sendMessage(`✅ *PAGO AUTO-VALIDADO por LLAVE* (@${realPhone})\nMonto: $${check.amount}\nBanco: ${check.bank || 'Desconocido'}\nLlave destino: ${check.destinationKey}\n\nEl bot ya entregó el servicio automáticamente.`);
                                }
                            } catch (e) { }
                            return;
                        }
                    }

                    // Si la llave no fue leída (OCR no la encontró), caer al flujo manual
                    if (!keyFound) {
                        console.log(`[AUTO-VALIDATE] No se pudo leer la llave destino en el comprobante. Flujo manual.`);
                    }

                } else if (check.amount === null && !check.isReceipt) {
                    // La IA no lo reconoció como comprobante
                    console.log(`[AUTO-VALIDATE] La imagen no fue reconocida como comprobante de pago.`);
                    await message.reply("🤖 No pude identificar esta imagen como un comprobante de pago bancario. Por favor envía una captura de pantalla clara de la confirmación de tu transferencia. 😊");
                    return;
                }
            } catch (autoErr) {
                console.error(`[AUTO-VALIDATE] Error durante validación automática:`, autoErr.message);
            }
        }

        // --- FALLBACK MANUAL: AVISO AL GRUPO ---
        try {
            const chat = await client.getChatById(GROUP_ID);
            if (chat) {
                const type = message.hasMedia ? "📸 Comprobante (llave no legible)" : "✅ Confirmación de pago por texto";
                let contact;
                try { contact = await message.getContact(); } catch (e) { contact = { number: userId.replace(/\D/g, '') }; }
                const realPhone = (contact && contact.number) ? contact.number : userId.replace(/\D/g, '');
                await chat.sendMessage(`🚨 ${type} recibido de @${realPhone}. Por favor revisar.\n\nPara validar: *@bot confirmar ${realPhone}* o *si me llegó ${realPhone}*`);
            }
        } catch (error) {
            console.error('Error enviando notificación al grupo:', error);
        }
        await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);

        // Revisar Netflix para pedir operador
        let hasNetflix = false;
        if (stateData.items && Array.isArray(stateData.items)) {
            hasNetflix = stateData.items.some(item => {
                const name = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "").toLowerCase();
                return name.includes('netflix') && !name.includes('extra');
            });
        }

        if (hasNetflix && !stateData.isRenewal) {
            await message.reply("🤖 ¡Gracias! He recibido tu comprobante de pago. 🎉\n\nListo, me confirmas por favor localidad o municipio donde se va a usar y operador de internet\n\nEj. suba-movistar");
            userStates.set(userId, { ...stateData, state: 'awaiting_netflix_operator_post_payment', checkAmount: stateData.total || null });
            return;
        }

        const { getPlatformAvailability } = require('./availabilityService');
        let nonImmediatePlats = [];
        if (stateData.items && Array.isArray(stateData.items)) {
            for (const item of stateData.items) {
                const name = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "");
                if (name) {
                    const avail = await getPlatformAvailability(name);
                    if (!avail.immediate) {
                        nonImmediatePlats.push(name);
                    }
                }
            }
        }

        if (nonImmediatePlats.length > 0) {
            const uniquePlats = [...new Set(nonImmediatePlats)];
            if (message.hasMedia) {
                await message.reply(`🤖 Hemos recibido tu comprobante. Ten en cuenta que para *${uniquePlats.join(', ')}* la entrega/activación tomará un poco más de lo habitual y no será de inmediato. Un asesor validará tu pago y te entregará tus accesos lo antes posible. ¡Gracias por tu paciencia! 😊`);
            } else {
                await message.reply(`🤖 Hemos recibido tu confirmación. Ten en cuenta que para *${uniquePlats.join(', ')}* la entrega/activación tomará un poco más de lo habitual y no será de inmediato. Un asesor validará que el dinero esté en la cuenta para procesar tu pedido. ¡Gracias por tu paciencia! 😊`);
            }
        } else {
            if (message.hasMedia) {
                await message.reply("🤖 Hemos recibido tu comprobante. Un asesor validará el pago en un momento para entregarte tus accesos.");
            } else {
                await message.reply("🤖 Hemos recibido tu confirmación. Un asesor validará que el dinero esté en la cuenta para procesar tu pedido.");
            }
        }

        // No registramos todavía. Guardamos el estado para que el admin lo confirme manualmente.
        const newState = { ...stateData, state: 'waiting_admin_confirmation' };
        userStates.set(userId, newState);
    } else {
        // En vez de repetir robóticamente, usamos IA para responder dudas si el usuario pregunta algo
        const { getChatHistoryText } = require('./salesService');
        const historyText = await getChatHistoryText(message);
        await processFallbackWithEscalation(message, userId, isMedia, singleMediaData, historyText);
    }
}




async function processCheckCredentialsLegacy(message, userId) {
    await processCheckCredentials(userId, client, message.body, "");
    userStates.delete(userId);
}



function getDurationMonths(detection, inputToUse) {
    let durationMonths = 1;
    if (detection && detection.metadata) {
        if (detection.metadata.duration_months) {
            durationMonths = parseInt(detection.metadata.duration_months) || 1;
        } else if (detection.metadata.duration) {
            const match = String(detection.metadata.duration).match(/\d+/);
            if (match) durationMonths = parseInt(match[0]) || 1;
        }
    }
    const lowerInput = (inputToUse || "").toLowerCase();
    const monthsMatch = lowerInput.match(/(\d+)\s*(mes|month)/i);
    if (monthsMatch && durationMonths === 1) {
        durationMonths = parseInt(monthsMatch[1]) || 1;
    }
    // Robust fallbacks for annual / years
    if (durationMonths === 1) {
        if (lowerInput.includes("anual") || lowerInput.includes("anualidad") || lowerInput.includes("año") || lowerInput.includes("year")) {
            durationMonths = 12;
        } else if (lowerInput.includes("semestral") || lowerInput.includes("semestre") || lowerInput.includes("6 meses")) {
            durationMonths = 6;
        } else if (lowerInput.includes("trimestral") || lowerInput.includes("trimestre") || lowerInput.includes("3 meses")) {
            durationMonths = 3;
        }
    }
    return durationMonths;
}



// --- AL FINAL DEL ARCHIVO index.js ---

// Esto evita que el bot se cierre si hay un error de código imprevisto
process.on('uncaughtException', (err) => {
    console.error('🔥 Error No Capturado (El bot sigue vivo):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    const errObj = reason instanceof Error ? reason : new Error(String(reason));
    console.error('🔥 Promesa Rechazada sin manejo:', reason);
    if (isCriticalBrowserError(errObj)) {
        console.error('🔥 [ANTI-ZOMBIE] Error crítico de navegador detectado en unhandledRejection. Reiniciando para PM2...');
        process.exit(1);
    }
});

// Inicializar cliente de WhatsApp Web con reintentos inteligentes sin tumbar Express
async function startClientWithRetries(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🤖 Inicializando cliente de WhatsApp Web (Intento ${attempt}/${maxRetries})...`);
            const fs = require('fs');
            const path = require('path');
            const sessionDirs = [
                path.join(__dirname, 'wwebjs_auth', 'session'),
                path.join(__dirname, 'wwebjs_auth', 'session', 'Default'),
                path.join(__dirname, '.wwebjs_auth', 'session'),
                path.join(__dirname, '.wwebjs_auth', 'session', 'Default')
            ];
            sessionDirs.forEach(dir => {
                if (fs.existsSync(dir)) {
                    ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'parent_singleton_lock'].forEach(lockFile => {
                        const lockPath = path.join(dir, lockFile);
                        if (fs.existsSync(lockPath)) {
                            try {
                                fs.unlinkSync(lockPath);
                                console.log(`🧹 [Startup Clean] ${lockFile} obsoleto eliminado en ${dir}`);
                            } catch (e) { }
                        }
                    });
                }
            });

            await client.initialize();
            console.log('✅ Cliente de WhatsApp Web inicializado correctamente.');
            return;
        } catch (err) {
            console.error(`❌ Error al inicializar cliente (Intento ${attempt}/${maxRetries}):`, err.message);
            if (attempt < maxRetries) {
                console.log('⏳ Reintentando inicialización de WhatsApp en 6 segundos manteniendo el backend encendido...');
                try {
                    if (client.pupBrowser) {
                        await client.pupBrowser.close().catch(() => {});
                    }
                } catch(e) {}
                await new Promise(r => setTimeout(r, 6000));
            } else {
                console.error('🔥 Se agotaron los reintentos de inicio. Forzando reinicio para PM2...');
                process.exit(1);
            }
        }
    }
}

startClientWithRetries();

// Escáner Atiende Pendientes deshabilitado de bucle periódico para evitar duplicados y respuestas tardías
// Los mensajes entrantes se procesan en tiempo real por los eventos 'message' y 'message_create'
// if (typeof processPendingChats === 'function') { ... }

// Bloque de escaneo automático de pagos eliminado (redundante con validación push)
