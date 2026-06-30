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
    return msg.includes('detached frame') ||
        msg.includes('execution context was destroyed') ||
        msg.includes('navigation failed') ||
        msg.includes('connection closed') ||
        msg.includes('cannot read properties of undefined') ||
        msg.includes('getchats');
}
const { pool } = require('./database');
const { initDailyAutomation } = require('./scheduledTasks');
const { detectPaymentMethod, generateCredentialsResponse, generateEmpatheticFallback, detectInitialIntent, isPaymentReceipt } = require('./aiService');
const { getAccountsByPhone } = require('./apiService');
const { searchContactByPhone, addNewContact } = require('./googleContactsService');
const { getChatHistoryText } = require('./salesService');
const { checkNewPayments, findMatchingPayment } = require('./gmailService');
const { processCheckCredentials } = require('./billingService');

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
    mapInstance.set = function(key, value) {
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
 * Guarda los estados actuales en el disco.
 */
function saveUserStates() {
    try {
        const obj = Object.fromEntries(userStates);
        fs.writeFileSync(USER_STATES_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error("[System] Error guardando user_states.json:", e.message);
    }
}

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
    executePaymentValidation
} = require('./adminService');


// Crear servidor Express
const app = express();
app.use(cors());
app.use(express.json({
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
        const userAccounts = await getAccountsByPhone(phone);

        // Check if they have a non-extra Netflix account
        const netflixAcct = userAccounts.find(c => {
            const streamingName = (c.Streaming || "").toLowerCase();
            return streamingName.includes('netflix') && !streamingName.includes('extra');
        });

        if (!netflixAcct) {
            return res.status(404).json({ success: false, message: "No se encontró cuenta de Netflix principal asociada a este número." });
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
                const recentCodes = await findRecentCodes(netflixAcct.correo, 15);
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
                    await new Promise(r => setTimeout(r, 3000));
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
                    message: `Se registró tu conexión (IP: ${clientIp}), pero la bandeja de correo de la cuenta (${netflixAcct.correo}) no está vinculada al bot. Por favor, solicita el código al soporte técnico de Sheerit para recibirlo manualmente.`,
                    account: netflixAcct.correo,
                    ip: clientIp
                });
            } else {
                return res.json({
                    success: false,
                    message: `Se registró tu conexión (IP: ${clientIp}), pero no pudimos extraer ningún código o enlace reciente de Netflix para la cuenta ${netflixAcct.correo}. Por favor, asegúrate de presionar 'Actualizar Hogar' en tu TV para enviar el correo y refresca esta página en unos momentos.`,
                    account: netflixAcct.correo,
                    ip: clientIp
                });
            }
        }

        res.json({ 
            success: true, 
            message: link 
                ? `¡Conexión verificada! Haz clic en el botón rojo de abajo para autorizar este dispositivo.`
                : `¡Conexión verificada! Ingresa el código mostrado a continuación en tu pantalla de Netflix.`, 
            account: netflixAcct.correo, 
            ip: clientIp,
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
        if (!apiKey || !secretKey) throw new Error("Llaves de Bold no configuradas en .env");

        const timestamp = Date.now();
        const random = Math.floor(1000 + Math.random() * 9000);
        const orderId = `inv${random}`;
        const amount = platform.price;
        const currency = 'COP';

        const concatenated = `${orderId}${amount}${currency}${secretKey}`;
        const integritySignature = crypto.createHash('sha256').update(concatenated).digest('hex');

        // Guardar estado en base de datos.
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
                amount,
                numbers.join(',')
            ]
        );

        res.json({
            orderId,
            apiKey,
            amount: amount.toString(),
            currency,
            description: `Suscripción a ${platform.name}`,
            tax: 'vat-19',
            integritySignature,
            redirectionUrl: 'https://sheerit.com.co/'
        });
    } catch (e) {
        console.error("Bold Generate Token Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bold/webhook', async (req, res) => {
    try {
        const signatureHeader = req.headers['x-bold-signature'] || '';
        const secretKey = process.env.BOLD_SECRET_KEY;
        if (!secretKey) throw new Error("BOLD_SECRET_KEY missing");

        const rawBodyBase64 = req.rawBody.toString('base64');
        const computedSignature = crypto.createHmac('sha256', secretKey).update(rawBodyBase64).digest('hex');

        if (computedSignature !== signatureHeader) {
            console.log(`Firma no válida. Recibida: ${signatureHeader} Calculada: ${computedSignature}`);
            return res.status(400).json({ error: 'Firma no válida' });
        }

        const data = req.body;
        const eventType = data.type || '';
        let orderId = null;
        if (data.data?.metadata?.reference) orderId = data.data.metadata.reference;
        else if (data.subject) orderId = data.subject;

        if (eventType === 'SALE_APPROVED') {
            const { pool } = require('./database');
            const [rows] = await pool.query('SELECT * FROM web_sales_pending WHERE order_id = ?', [orderId]);
            const customerData = rows[0];

            if (customerData) {
                console.log(`Venta aprobada vía Webhook para orden ${orderId}`);

                // Usando recordNewSale de whatbot
                const { recordNewSale } = require('./salesRegistryService');

                let formattedPhone = customerData.whatsapp.replace(/\D/g, '');
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
                console.log("Resultados guardado en Excel via Bold:", results);

                // --- ALINEACIÓN DE ENTREGA AUTOMÁTICA Y ESTADOS ---
                let credentialsMsg = `¡Hola ${customerData.firstName}! 👋\n\nHemos recibido tu pago exitosamente. 🎉\n\n`;
                let hasAnyCredentials = false;
                const { getMaskedAccessData } = require('./aiService');
                const { getDynamicSupportExpectationMessage } = require('./adminService');
                
                results.forEach(res => {
                    if (res.status === 'success' && res.correo) {
                        hasAnyCredentials = true;
                        const masked = getMaskedAccessData({
                            Streaming: res.name,
                            correo: res.correo,
                            contraseña: res.contraseña
                        });
                        
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
                                `Para poder enviarte la invitación familiar, por favor envíame en un solo mensaje:\n` +
                                `1. Tu número de teléfono celular\n` +
                                `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                                `*(Ejemplo: 3101234567, miusuario@gmail.com)*`;
                            await client.sendMessage(phoneId, appleMsg);
                            userStates.set(phoneId, { state: 'awaiting_apple_one_details', chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
                        } else {
                            userStates.set(phoneId, { state: 'waiting_human', waitingCount: 1, chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
                        }
                    } else {
                        userStates.set(phoneId, { state: 'main_menu', nombre: `${customerData.firstName} ${customerData.lastName}`, chatJid: phoneId, lastPaymentValidated: Date.now() });
                    }
                } else {
                    if (manualItems.length > 0) {
                        const hasAppleOne = manualItems.some(item => (item.name || "").toLowerCase().includes('apple'));
                        if (hasAppleOne) {
                            const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                                `Para poder enviarte la invitación familiar, por favor envíame en un solo mensaje:\n` +
                                `1. Tu número de teléfono celular\n` +
                                `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                                `*(Ejemplo: 3101234567, miusuario@icloud.com)*`;
                            await client.sendMessage(phoneId, appleMsg);
                            userStates.set(phoneId, { state: 'awaiting_apple_one_details', chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
                        } else {
                            let manualMsg = `🤖 ¡Tu pago ha sido verificado con éxito! 🎉\n\n`;
                            const platformsStr = manualItems.map(item => item.name.toUpperCase()).join(', ');
                            const expectation = getDynamicSupportExpectationMessage();
                            manualMsg += `Noté que tu servicio de *${platformsStr}* requiere de una activación personalizada, invitación de plan familiar o asignación manual.\n\n` +
                                `${expectation}`;
                            await client.sendMessage(phoneId, manualMsg);

                            try {
                                const groupChat = await client.getChatById(GROUP_ID);
                                if (groupChat) {
                                    await groupChat.sendMessage(`🚨 *ACTIVACIÓN MANUAL REQUERIDA* (@${phoneId.replace('@c.us', '')})\n` +
                                        `Servicios: ${platformsStr}\n` +
                                        `Monto: $${customerData.amount || ''}\n` +
                                        `Por favor, un asesor debe enviarle la invitación o acceso manualmente.`);
                                }
                            } catch (e) { }

                            userStates.set(phoneId, { state: 'waiting_human', waitingCount: 1, chatJid: phoneId, nombre: `${customerData.firstName} ${customerData.lastName}`, lastPaymentValidated: Date.now() });
                        }
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

app.get('/api/admin/stats', async (req, res) => {
    try {
        const { fetchCustomersData, getJsDateFromExcel, fetchHistoricoData } = require('./apiService');
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
            churnedCount: 0
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

        // Cargar tendencia histórica
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

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to retrieve specific client history by phone number
app.get('/api/admin/client-history', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const { fetchHistoricoData } = require('./apiService');
        const historico = await fetchHistoricoData();
        const cleanPhone = phone.toString().replace(/\D/g, '');

        if (cleanPhone.length < 7) {
            return res.json({ nombre: "", apellido: "", historial: [] });
        }

        const targetTail = cleanPhone.slice(-10);
        const histKey = Object.keys(historico).find(k => k.endsWith(targetTail));
        const clientHistory = histKey ? historico[histKey] : null;

        res.json(clientHistory || { nombre: "", apellido: "", historial: [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/actions/send-info', async (req, res) => {
    try {
        const { phone, type, password, message: customMessage } = req.body;
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
            } catch (e) {}
            return str;
        };

        let message = "";

        if (type === 'custom') {
            message = customMessage || "";
        } else {
            const { getAccountsByPhone } = require('./apiService');
            const accounts = await getAccountsByPhone(cleanPhone);
            if (!accounts || accounts.length === 0) return res.status(404).json({ success: false, message: 'Client not found', error: 'Client not found' });

            if (type === 'credentials') {
                message = `*Tus Credenciales de Sheer IT*\n\n`;
                accounts.forEach((clientData) => {
                    const pass = clientData['pin perfil'] || clientData.contraseña || clientData.Clave || clientData.clave || clientData.password || 'N/A';
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    message += `🍿 *Servicio:* ${clientData.Streaming || 'N/A'}\n` +
                               `📧 *Usuario:* ${clientData.correo || 'N/A'}\n` +
                               `🔑 *Contraseña:* ${pass}\n` +
                               `👤 *Perfil:* ${clientData.Nombre || 'N/A'}\n` +
                               `📅 *Vence:* ${venc}\n\n`;
                });
                message += `¡Disfruta tu servicio!`;
            } else if (type === 'payment') {
                const clientName = accounts[0].Nombre || 'Cliente';
                message = `¡Hola ${clientName}! 👋\n\n` +
                    `Te recordamos que tus siguientes servicios están próximos a vencer:\n\n`;
                accounts.forEach((clientData) => {
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    message += `• *${clientData.Streaming || 'N/A'}* - Vence: ${venc}\n`;
                });
                message += `\n` +
                    `Puedes renovar realizando tu transferencia aquí:\n` +
                    `*Nequi:* 3118587974\n` +
                    `*Daviplata:* 3107946794\n\n` +
                    `Una vez realizado, envíanos el comprobante por este medio. ¡Gracias!`;
            }
        }

        const chatId = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@c.us`;
        
        if (req.body.scheduledTime) {
            const { scheduleNewMessage } = require('./scheduledMessageService');
            const result = await scheduleNewMessage(client, chatId, message, req.body.scheduledTime);
            return res.json({ success: true, isScheduled: true, formattedTime: result.formattedTime, message: 'Mensaje programado con éxito' });
        }

        await client.sendMessage(chatId, message);

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
            nombre: name
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
let lastAiClassificationTime = 0;
const AI_CLASSIFICATION_INTERVAL = 45 * 1000; // run classification every 45 seconds

async function updateAiTicketsClassification() {
    try {
        const now = Date.now();
        if (now - lastAiClassificationTime < AI_CLASSIFICATION_INTERVAL) return;
        lastAiClassificationTime = now;

        // Build list of active tickets
        const activeTickets = [];
        for (const [userId, state] of userStates.entries()) {
            if (!state) continue;
            const stateStr = typeof state === 'object' ? state.state : state;
            const pendingStates = ['waiting_human', 'awaiting_payment_confirmation', 'waiting_admin_confirmation'];
            if (!pendingStates.includes(stateStr)) continue;

            const phone = userId.replace('@c.us', '');
            let lastMessage = typeof state === 'object' ? (state.lastMessage || "") : "";
            let lastMessageTime = typeof state === 'object' ? (state.lastMessageTime || null) : null;
            let summary = "";
            if (typeof state === 'object') {
                if (state.state === 'awaiting_payment_confirmation') {
                    summary = `💰 Pago Manual: ${state.bank || 'N/A'} - $${state.amount || 'N/A'}`;
                } else if (state.advisorReason) {
                    summary = `🚨 Motivo: "${state.advisorReason}"`;
                } else if (state.items && state.items.length > 0) {
                    const itemNames = state.items.map(it => it.platform?.name || it.platformName || '').filter(Boolean).join(', ');
                    summary = `🛒 Interés: ${itemNames}`;
                }
            }

            const timeDiff = lastMessageTime ? `${Math.round((now - lastMessageTime) / 60000)}m ago` : "unknown";

            activeTickets.push({
                phone,
                nombre: (typeof state === 'object' ? state.nombre : 'Cliente') || 'Cliente',
                lastMessage: lastMessage.substring(0, 200),
                summary,
                time: timeDiff
            });
        }

        if (activeTickets.length === 0) {
            probablyFinishedTickets.clear();
            aiTicketsSummaries.clear();
            return;
        }

        // Call Gemini to get both: probably resolved tickets AND short descriptive summaries of each ticket's problem
        const { callGemini } = require('./aiService');
        const prompt = `Analiza la siguiente lista de tickets de soporte técnico y ventas en formato JSON:
${JSON.stringify(activeTickets, null, 2)}

Realiza dos tareas:
1. Determina cuáles de ellos están **probablemente terminados o solucionados** y ya no requieren atención inmediata de un asesor (ej. agradecimientos rápidos, respuestas afirmativas simples o inactividad tras resolver).
2. Genera para **CADA ticket** un resumen descriptivo en español de 3 a 5 palabras explicando el motivo real o falla técnica reportada basándote en su "lastMessage" o "summary" (ej. "Pide código de Disney", "Netflix caída de hogar", "Problema de facturación", "Pregunta por catálogo"). Si el "summary" ya contiene un motivo manual claro (como Pago o Interés), consérvalo.

Devuelve **únicamente** un objeto JSON estructurado así (sin marcas markdown de bloque):
{
  "probablyFinished": ["573166568300"],
  "summaries": {
    "573166568300": "Falla Netflix Hogar",
    "573185160611": "Solicita código Disney"
  }
}`;

        const responseJson = await callGemini(prompt, "Eres un analista experto de soporte técnico que resume problemas en 3 a 5 palabras.", true);
        const parsed = JSON.parse(responseJson);
        
        if (parsed) {
            if (Array.isArray(parsed.probablyFinished)) {
                probablyFinishedTickets = new Set(parsed.probablyFinished.map(p => String(p)));
            }
            if (parsed.summaries && typeof parsed.summaries === 'object') {
                aiTicketsSummaries = new Map(Object.entries(parsed.summaries));
            }
            console.log(`[AI Classification] Actualizado caché de tickets en lote. Probablemente terminados: ${probablyFinishedTickets.size}. Resúmenes guardados: ${aiTicketsSummaries.size}`);
        }
    } catch (err) {
        console.error("[AI Classification] Error running AI batch classification:", err.message);
    }
}

app.get('/api/admin/tickets', async (req, res) => {
    try {
        // Run classification asynchronously in background
        updateAiTicketsClassification().catch(err => console.error("[AI Classification Async]", err));

        const ticketsPromises = Array.from(userStates.entries()).map(async ([userId, state]) => {
            if (!state) return null;
            const stateStr = typeof state === 'object' ? state.state : state;
            const pendingStates = ['waiting_human', 'awaiting_payment_confirmation', 'waiting_admin_confirmation', 'resolved'];
            if (!pendingStates.includes(stateStr)) return null;

            const phone = userId.replace('@c.us', '');
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
            let resolvedName = typeof state === 'object' ? state.nombre : "Cliente";

            try {
                const { getAccountsByPhone } = require('./apiService');
                accounts = await getAccountsByPhone(phone);
                if ((!resolvedName || resolvedName === "Cliente" || resolvedName === "Cliente WhatsApp") && accounts && accounts.length > 0) {
                    const firstAcc = accounts[0];
                    const first = (typeof (firstAcc.Nombre || firstAcc.nombre) === 'string') ? (firstAcc.Nombre || firstAcc.nombre) : "";
                    const last = (typeof (firstAcc.apellido || firstAcc.Apellido) === 'string') ? (firstAcc.apellido || firstAcc.Apellido) : "";
                    if (first && first.trim()) {
                        resolvedName = `${first} ${last}`.trim();
                    }
                }
            } catch (err) { }

            if (!resolvedName || resolvedName === "Cliente" || resolvedName === "Cliente WhatsApp") {
                try {
                    const { searchContactByPhone } = require('./googleContactsService');
                    const contactName = await searchContactByPhone(phone);
                    if (contactName) {
                        resolvedName = contactName;
                    }
                } catch (e) { }
            }

            if (!resolvedName || resolvedName === "Cliente" || resolvedName === "Cliente WhatsApp") {
                try {
                    if (client && client.info) {
                        const contact = await Promise.race([
                            client.getContactById(userId),
                            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000))
                        ]);
                        if (contact) {
                            resolvedName = contact.pushname || contact.name || "Cliente WhatsApp";
                        }
                    }
                } catch (e) { }
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
            if (!summary && aiTicketsSummaries.has(phone)) {
                summary = `🤖 AI: ${aiTicketsSummaries.get(phone)}`;
            }

            const { getQueuePosition } = require('./supportScheduleService');
            const queuePosition = getQueuePosition(userId, userStates);

            const isProbablyFinished = probablyFinishedTickets.has(phone);

            return {
                userId,
                phone,
                nombre: resolvedName,
                state: stateStr,
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
        res.json(resolvedTickets.filter(Boolean));
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
            updatedState = { state: currentState, agent: agent, waiting_human_mode: newMode };
        } else {
            updatedState = { ...currentState, agent: agent, waiting_human_mode: newMode };
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
        const currentState = userStates.get(userId);

        if (!currentState) {
            userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: mode });
            return res.json({ success: true, message: `Estado creado y modo configurado a ${mode}` });
        }

        let updatedState = {};
        if (typeof currentState === 'string') {
            updatedState = { state: currentState, waiting_human_mode: mode };
        } else {
            updatedState = { ...currentState, waiting_human_mode: mode };
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

app.post('/api/admin/tickets/resolve', async (req, res) => {
    try {
        const { phone, password, resolveAll } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        const cleanPhone = phone.replace('@c.us', '').replace(/\D/g, '');

        // Obtener correos asociados a este teléfono
        let targetEmails = [];
        try {
            const { getAccountsByPhone } = require('./apiService');
            const userAccs = await getAccountsByPhone(cleanPhone);
            targetEmails = userAccs.map(a => (a.correo || a.Correo || '').toLowerCase().trim()).filter(Boolean);
        } catch (e) {
            console.error('[Tickets Resolve] Error obteniendo cuentas para:', cleanPhone, e.message);
        }

        // Resolver el ticket actual
        const stateData = userStates.get(userId) || {};
        const agentName = stateData.agent || 'Bot / Sistema';
        const customerName = stateData.nombre || 'Cliente WhatsApp';

        // Log resolved ticket
        try {
            await pool.query(
                'INSERT INTO resolved_tickets_log (phone, customerName, agent) VALUES (?, ?, ?)',
                [cleanPhone, customerName, agentName]
            );
        } catch (logErr) {
            console.error('[Resolved Log] Error logging resolved ticket:', logErr.message);
        }

        userStates.set(userId, {
            ...(typeof stateData === 'object' ? stateData : { state: stateData }),
            state: 'resolved',
            resolvedAt: Date.now()
        });

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
                            const otherAgentName = otherStateData.agent || 'Bot / Sistema';
                            const otherCustomerName = otherStateData.nombre || 'Cliente WhatsApp';

                            try {
                                await pool.query(
                                    'INSERT INTO resolved_tickets_log (phone, customerName, agent) VALUES (?, ?, ?)',
                                    [otherPhone, otherCustomerName, otherAgentName]
                                );
                            } catch (logErr) {}

                            userStates.set(otherUserId, {
                                ...otherStateData,
                                state: 'resolved',
                                resolvedAt: Date.now()
                            });
                            resolvedOthersCount++;
                        }
                    } catch (e) {
                        console.error('[Tickets Resolve] Error al emparejar otro teléfono:', otherPhone, e.message);
                    }
                }
            }
        }

        let message = 'Ticket resuelto y bot reactivado';
        if (resolvedOthersCount > 0) {
            message += `. También se resolvieron automáticamente ${resolvedOthersCount} ticket(s) con la misma cuenta compartida.`;
        }

        res.json({ success: true, message });
    } catch (e) {
        res.status(500).json({ error: e.message });
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

app.get('/api/admin/tickets/metrics', async (req, res) => {
    try {
        const [summary] = await pool.query(`
            SELECT agent, COUNT(*) as count 
            FROM resolved_tickets_log 
            GROUP BY agent 
            ORDER BY count DESC
        `);
        
        const [recent] = await pool.query(`
            SELECT phone, customerName, agent, resolvedAt 
            FROM resolved_tickets_log 
            ORDER BY resolvedAt DESC 
            LIMIT 100
        `);

        res.json({ success: true, summary, recent });
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
        const { config, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config || typeof config !== 'object') return res.status(400).json({ success: false, message: 'Configuración inválida' });

        const { saveAvailabilityConfig } = require('./availabilityService');
        saveAvailabilityConfig(config);
        res.json({ success: true, message: 'Disponibilidad de stock actualizada' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to read human support schedule configuration
app.get('/api/admin/support-schedule', (req, res) => {
    try {
        const { getSupportScheduleConfig } = require('./supportScheduleService');
        const config = getSupportScheduleConfig();
        res.json(config);
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

app.post('/api/admin/gpt-accounts/save', (req, res) => {
    try {
        const { email, secret, service, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !secret) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { saveSecret } = require('./totpService');
        saveSecret(email, secret, service || 'ChatGPT');
        res.json({ success: true, message: 'Cuenta GPT guardada con éxito' });
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
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { loadSecrets } = require('./totpService');
        const secrets = loadSecrets();
        const key = email.toLowerCase().trim();
        if (secrets[key]) {
            delete secrets[key];
            const SECRETS_FILE = path.join(__dirname, 'tokens', 'gpt_secrets.json');
            fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
            res.json({ success: true, message: 'Cuenta GPT eliminada con éxito' });
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
        const { syncExcelToDb } = require('./scripts/sync_excel_to_db');
        const result = await syncExcelToDb();
        res.json({ success: true, ...result });
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
        const request = http.get('http://localhost:5000/sessions', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                try {
                    res.json(JSON.parse(data));
                } catch(e) {
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

app.get('/api/admin/chat-messages', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        if (!client || !client.info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        // 1. Intentar obtener mensajes de la base de datos
        const [rows] = await pool.query(
            `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 40`,
            [userId]
        );

        if (rows && rows.length > 0) {
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
            // Retornar en orden cronológico (más antiguos primero)
            formatted.reverse();
            return res.json(formatted);
        }

        // 2. Fallback a Puppeteer si la BD está vacía
        const chat = await client.getChatById(userId);
        const messages = await chat.fetchMessages({ limit: 40 });

        const formatted = messages.map(m => ({
            id: m.id ? m.id._serialized : null,
            body: m.body || "",
            fromMe: m.fromMe,
            timestamp: m.timestamp * 1000,
            type: m.type,
            hasMedia: m.hasMedia
        }));

        // Guardar en base de datos en segundo plano para poblar el historial
        for (const msg of messages) {
            saveMessage(msg).catch(err => console.error("Error guardando mensaje en fallback:", err.message));
        }

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/chat-messages/sync', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        if (!client || !client.info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }

        const chat = await client.getChatById(userId);
        const messages = await chat.fetchMessages({ limit: 50 });

        // Guardar/actualizar en base de datos de manera secuencial para no saturar
        for (const msg of messages) {
            try {
                await saveMessage(msg);
            } catch (err) {
                console.error("Error guardando mensaje en sincronización:", err.message);
            }
        }

        // Recuperar historial actualizado desde la base de datos
        const [rows] = await pool.query(
            `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 40`,
            [userId]
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

        const userId = phone.includes('@') ? phone : phone + '@c.us';
        if (!client || !client.info) {
            return res.status(503).json({ success: false, message: 'WhatsApp client is not ready' });
        }

        // Concatenar el emoji del asesor si está presente
        const prefix = emoji ? `${emoji.trim()} ` : "";
        const finalMessage = prefix + message;

        await client.sendMessage(userId, finalMessage);

        // Silenciar el bot para este usuario (modo advisor) ya que hay interacción manual
        const currentState = userStates.get(userId) || {};
        userStates.set(userId, {
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
            const qIdx = global.supportQueue.indexOf(userId);
            if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
        }

        res.json({ success: true, message: 'Mensaje enviado correctamente' });
    } catch (e) {
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
                role ENUM('admin', 'agent', 'supervisor') DEFAULT 'agent',
                status ENUM('active', 'inactive', 'busy') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            INSERT INTO agents (username, fullname, email, role) VALUES 
            ('estebanavila182', 'Esteban', 'estebanavila182@outlook.com', 'admin'),
            ('esclepiades', 'Esclepiades', 'esclepiades@hotmail.com', 'agent'),
            ('camilo', 'Camilo', 'camco08@hotmail.com', 'agent'),
            ('carolcubillos03', 'Carol Cubillos', 'carolcubillos03@outlook.com', 'agent')
            ON DUPLICATE KEY UPDATE 
                role = VALUES(role), 
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
                await pool.query("ALTER TABLE agent_schedules ADD COLUMN break_type ENUM('none', 'break_30', 'lunch_60') DEFAULT 'none'");
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
        const [rows] = await pool.query('SELECT id, username, fullname, email, role, status FROM agents ORDER BY fullname ASC');
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
        
        const [agents] = await pool.query('SELECT id, username, fullname, email, role FROM agents WHERE status = "active"');
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
        const { email, schedule, week_start } = req.body;
        const weekStartStr = week_start || 'default';
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });
        if (!Array.isArray(schedule)) return res.status(400).json({ success: false, message: 'El horario debe ser una lista de franjas' });

        const { pool } = require('./database');
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
            res.json({ success: true, message: 'Horario del asesor guardado correctamente' });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
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
- "credenciales": El usuario solicita las credenciales (correo/contraseña) de su cuenta actual, reporta explícitamente "la contraseña no corresponde", "clave incorrecta", o pide recordar su pin de acceso.
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
    "metadata": {
        "duration_months": number | null,
        "is2faScreen": boolean | null
    } | null 
}

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
   - Si pidió credenciales, dile que ya puedes entregárselas (y recuérdale que use el número 2).
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
        } catch (err) {}

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
                                } catch (e) {}
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


// ==========================================
// CLIENT OTP PORTAL SIGN-IN & 2FA REQUESTS
// ==========================================

const clientOtps = new Map(); // phone -> { code, expiresAt }

// POST Request Client OTP
app.post('/api/client/request-otp', express.json(), async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });

        const cleanPhone = phone.replace(/\D/g, '');
        const userJid = cleanPhone + '@c.us';

        const { pool } = require('./database');
        const [rows] = await pool.query('SELECT fullname FROM customers WHERE phone = ?', [cleanPhone]);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No encontramos ningún cliente registrado con ese número de teléfono' });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos

        clientOtps.set(cleanPhone, { code: otpCode, expiresAt });

        if (client && currentWhatsappStatus === 'CONNECTED') {
            const msg = `🔑 *CÓDIGO DE ACCESO (SHEERIT)* 🔑\n\nHola *${rows[0].fullname}*,\n\nTu código OTP para iniciar sesión en nuestro portal de clientes es:\n\n🔢 *${otpCode}*\n\n_Este código es confidencial y vencerá en 5 minutos._ 🤖`;
            await client.sendMessage(userJid, msg);
            console.log(`[OTP] Enviado código ${otpCode} a @${cleanPhone}`);
            return res.json({ success: true, message: 'Código OTP enviado con éxito a tu WhatsApp' });
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
        const otpData = clientOtps.get(cleanPhone);

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

        const { getAccountsByPhone } = require('./apiService');
        const userAccounts = await getAccountsByPhone(cleanPhone);

        const formattedAccounts = userAccounts.map(acc => {
            const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
            const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "N/A";
            
            return {
                id: acc.id || acc._rowNumber,
                platform: (acc.Streaming || "").toUpperCase(),
                email: acc.correo || "",
                password: acc.clave || "",
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

// POST Request 2FA Code from Website
app.post('/api/client/request-2fa', express.json(), async (req, res) => {
    try {
        const { phone, accountId } = req.body;
        if (!phone || !accountId) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const { getAccountsByPhone } = require('./apiService');
        const userAccounts = await getAccountsByPhone(cleanPhone);

        const targetAccount = userAccounts.find(a => (a.id || a._rowNumber) == accountId);
        if (!targetAccount) {
            return res.status(404).json({ success: false, message: 'Cuenta no encontrada o no vinculada a tu número' });
        }

        const userJid = cleanPhone + '@c.us';
        const mockMessage = {
            id: { _serialized: `web_request_${Date.now()}` },
            from: userJid,
            fromMe: false,
            body: `código de ${(targetAccount.Streaming || '').toUpperCase()}`,
            reply: async (text) => {
                console.log(`[Web OTP Request Reply]: ${text}`);
                if (client) await client.sendMessage(userJid, text);
                return text;
            }
        };

        // Ejecutar extractor automático
        await processAccountVerificationCode(mockMessage, userJid, targetAccount, cleanPhone, client, userStates);

        res.json({ success: true, message: 'Solicitud de código 2FA enviada. El bot buscará el código y te lo enviará por WhatsApp.' });
    } catch (e) {
        console.error('Error al solicitar 2FA desde web:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});



const server = http.createServer(app);
const port = process.env.PORT || 3000;

server.listen(port, () => {
    console.log(`Servidor Express corriendo en el puerto ${port}`);

    // Heartbeat cada 5 minutos (reducido para detectar cuelgues de Puppeteer)
    setInterval(async () => {
        try {
            if (!client) return;
            const state = await client.getState();
            console.log(`💓 Heartbeat: Proceso vivo. Estado del cliente: ${state}`);

            // Verificación de salud profunda: ¿Sigue respondiendo el navegador?
            if (state === 'CONNECTED') {
                // Intentamos obtener info básica del cliente para verificar que el canal IPC con Puppeteer sigue vivo
                const info = await Promise.race([
                    client.getContactById(client.info.wid._serialized),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
                ]);
                if (!info) throw new Error("Browser unresponsive (Deep check failed)");
            }
        } catch (err) {
            console.error('⚠️ Heartbeat: Error de salud detectado:', err.message);
            if (isCriticalBrowserError(err) || err.message.includes("Timeout") || err.message.includes("unresponsive")) {
                console.error('🔥 [ANTI-ZOMBIE] Detectado estado crítico o zombie de Puppeteer. Forzando reinicio para PM2...');
                process.exit(1);
            }
        }
    }, 5 * 60 * 1000);
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
        // executablePath: isMac ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer'
        ],
        timeout: 60000, // Aumentar a 60 segundos
        protocolTimeout: 120000, // Prevenir timeouts en descargas de multimedia
    },
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
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
            const count = await processPendingChats(client, userStates, processIncomingMessage);
            console.log(`✅ Escaneo inicial completado. Se procesaron/ignoraron ${count} chats pendientes adecuadamente.`);
        } catch (err) {
            console.error('Error en escaneo inicial de chats pendientes:', err);
        }
    }, 5000); // Pequeño delay de gracia
});

client.on('disconnected', (reason) => {
    console.error('❌ El cliente se desconectó. Razón:', reason);
    currentWhatsappStatus = 'DISCONNECTED';
    latestQrCode = null;
    latestPairingCode = null;
    broadcastSseEvent('status', { status: currentWhatsappStatus, reason: reason });
    // Si usas PM2, esto forzará un reinicio
    console.log('⚠️ Intentando forzar reinicio del proceso...');
    process.exit(1);
});

client.on('auth_failure', (msg) => {
    console.error('❌ FALLO DE AUTENTICACIÓN:', msg);
    currentWhatsappStatus = 'DISCONNECTED';
    latestQrCode = null;
    latestPairingCode = null;
    broadcastSseEvent('status', { status: currentWhatsappStatus, reason: 'auth_failure', message: msg });
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

client.on('auth_failure', msg => {
    // Fails if the session is not restored successfully
    console.error('FALLO DE AUTENTICACION', msg);
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado', reason);
});

// DETECTAR INTERVENCIÓN HUMANA

client.on('message_create', async (msg) => {
    // Ignorar si el mensaje es antiguo
    if (msg.timestamp < BOT_START_TIME) return;

    // Persistir mensaje en base de datos (ignorar grupos y broadcasts)
    const targetChatId = msg.fromMe ? msg.to : msg.from;
    if (targetChatId && !targetChatId.includes('@g.us') && !targetChatId.includes('status@broadcast')) {
        saveMessage(msg).catch(err => console.error("[DB Save Error] message_create:", err.message));
    }

    // DETECTAR INTERVENCIÓN HUMANA: Si el mensaje lo envío yo manualmente
    // a un chat que NO es un grupo y NO tiene el emoji del bot.
    if (msg.fromMe && !msg.to.includes('@g.us') && !msg.to.includes('@broadcast')) {
        let targetId = msg.to;

        // Traducción de LID a @c.us para consistencia en el estado (evita pisar charlas humanas)
        if (targetId && targetId.includes('@lid')) {
            try {
                const contact = await client.getContactById(targetId);
                if (contact && contact.id && contact.id.user) {
                    targetId = contact.id.user + '@c.us';
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
            let st = userStates.get(targetId);
            if (typeof st === 'object' && st.state === 'waiting_human') {
                // Ya estaba silenciado, renovamos el temporizador de mute absoluto (30 min extra)
                st.lastHumanInteraction = Date.now();
                st.waiting_human_mode = 'advisor';
                st.clientWaitingSince = null;
                userStates.set(targetId, st);
            } else {
                console.log(`[BOT MUTE] Detectada intervención manual para ${targetId}. Silenciando bot por 30 mins.`);
                userStates.set(targetId, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now(), waiting_human_mode: 'advisor', clientWaitingSince: null });
            }

            // Si el asesor intervino manualmente, lo sacamos de la cola de espera
            if (global.supportQueue) {
                const qIdx = global.supportQueue.indexOf(targetId);
                if (qIdx !== -1) global.supportQueue.splice(qIdx, 1);
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
        await message.reply(fallbackResult);
        return;
    }

    if (fallbackResult.needsEscalation) {
        const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
        const supportStatus = await isSupportOpen();
        
        // Registrar primero la espera humana para que el usuario sea contado en la cola
        userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

        if (!supportStatus.open) {
            const config = getSupportScheduleConfig();
            const queuePos = getQueuePosition(userId, userStates);
            let offlineMsg = config.offline_message || "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos.";
            if (queuePos) {
                offlineMsg += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}.\n⚠️ _(Nota: Dado que estamos fuera de nuestro horario de atención, tu turno no avanzará hasta que nuestros asesores inicien labores de nuevo)._`;
            }
            await message.reply(offlineMsg + " 🤖");
        } else {
            let replyText = fallbackResult.replyMessage || "";
            const queuePos = getQueuePosition(userId, userStates);
            if (queuePos) {
                if (!replyText.includes('turno') && !replyText.includes('cola')) {
                    replyText += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}. Te atenderemos lo antes posible. ¡Gracias por tu paciencia!`;
                }
            }
            if (replyText) {
                await message.reply(replyText);
            }
        }

        try {
            const chat = await client.getChatById(GROUP_ID);
            if (chat) {
                // Resolver número real para el reporte (LID fix)
                let contact;
                try {
                    contact = await message.getContact();
                } catch (e) {
                    contact = { number: userId.replace(/\D/g, '') };
                }
                const realPhone = contact.number || userId.replace(/\D/g, '');
                await chat.sendMessage(`🚨 *ESCALAMIENTO IA SOPORTE* de @${realPhone}\n\n${fallbackResult.escalationSummary || 'Revisión manual requerida.'}`);
            }
        } catch (e) { console.error('Error enviando escalamiento:', e); }
        globalLastPaymentUserId = userId;
    } else {
        if (fallbackResult.replyMessage) {
            await message.reply(fallbackResult.replyMessage);
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
                    return;
                }
            }
        }

        // B. Cuenta con token de Gmail configurado (Disney+, Max, Netflix 4K, YouTube, etc.)
        const tokenExists = fs.existsSync(path.join(__dirname, 'tokens', `token_${accountEmail}.json`));

        if (tokenExists) {
            const { findRecentCodes } = require('./gmailService');
            const codes = await findRecentCodes(accountEmail, 10);

            if (codes && codes.length > 0) {
                const latest = codes[0];
                let response = `🤖 *Código / Enlace de ${streamingName} Encontrado* 🚀\n\n`;
                if (latest.code) {
                    response += `🔢 Código: *${latest.code}*\n`;
                }
                if (latest.link) {
                    response += `🔗 Enlace de inicio de sesión:\n👉 ${latest.link}\n\n`;
                }
                response += `📝 ${latest.snippet}\n⏰ Recibido hace ${latest.time} min.\n\n_Recuerda que este código/enlace vence pronto._`;
                await message.reply(response);
                userStates.delete(userId);
                return;
            } else {
                await message.reply(`🤖 No encontré códigos recientes en ${accountEmail} para ${streamingName}. Por favor, asegúrate de haber seleccionado la opción de enviar el código en tu pantalla hace menos de 10 minutos y vuelve a escribir *código*.`);
                userStates.delete(userId);
                return;
            }
        }

        // C. Correo externo vinculado a una receta RPA — consulta directamente la BD
        if (accountEmail) {
            try {
                const { pool } = require('./database');
                const [subRows] = await pool.query(
                    `SELECT s.rpa_recipe_id, r.name as recipe_name, r.recipe_json
                     FROM subscriptions s
                     LEFT JOIN rpa_recipes r ON r.id = s.rpa_recipe_id
                     WHERE s.account_email = ? AND s.is_provider = 1 AND s.status = 'active'
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
            await message.reply(`🤖 ¡Hola! Para generar tu código de hogar, ingresa a este enlace:\n\n👉 https://sheerit.com.co/verificar?tel=${realPhone}`);
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
 * Procesa un lote de mensajes de un mismo usuario con bloqueo a nivel de usuario.
 */
async function processIncomingMessage(messages) {
    if (messages.length === 0) return;

    const firstMsg = messages[0];
    let userId = firstMsg.from;

    if (firstMsg.fromMe && firstMsg.to && firstMsg.to !== (client.info ? client.info.wid._serialized : '')) {
        userId = firstMsg.to;
    }

    const cleanUserId = userId.replace('@c.us', '').replace(/\D/g, '');
    if (cleanUserId === '573027892574') {
        console.log(`[Provider Bypass] Ignorando mensaje entrante del proveedor: ${userId}`);
        return;
    }

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

    const batchId = messages.map(m => m.id ? m.id._serialized : '').join(',');
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

    // --- PRIORIDAD JEFE (3133890800) ---
    if (isFromAdmin && !userId.includes('@g.us')) {
        const { detectAdminIntent } = require('./aiService');
        const combinedAdminBody = messages.map(m => m.body).join(' ');
        const adminAI = await detectAdminIntent(combinedAdminBody);

        console.log(`[Chief Mode] Intención detectada: ${adminAI.intent} para ${adminAI.target_user || adminAI.target}`);

        if (adminAI.intent === 'dame_cuenta' && (adminAI.target_platform || adminAI.target_user)) {
            const { handleAdminForceRetrieve } = require('./adminService');
            await handleAdminForceRetrieve(firstMsg, adminAI.target_platform || adminAI.target_user, client, adminAI.target_user);
            return;
        } else if (adminAI.intent === 'confirmar_pago') {
            const { handleAdminPaymentConfirmation } = require('./adminService');
            // Pasamos el texto original para que extraiga el número del cliente y los meses, y null para que no se auto-asigne el número del admin
            await handleAdminPaymentConfirmation(firstMsg, firstMsg.body, client, userStates, null);
            return;
        } else if (adminAI.intent === 'liberar_bot') {
            userStates.delete(userId);
            const isAdminPrivate = userId.replace('@c.us', '') === ADMIN_RAW_PHONE;
            if (isAdminPrivate) {
                await firstMsg.reply(`✅ Bot reactivado para ti, jefe.`);
            } else {
                // Lectura prematura del chat para llegar ayudando
                const { generateReactivationResponse } = require('./aiService');
                const chatHistory = await getChatHistoryText(firstMsg, 10); // Leer últimos 10 mensajes
                const reactivationMsg = await generateReactivationResponse(chatHistory);
                await firstMsg.reply(reactivationMsg);
            }
            return;
        }
    }

    const message = messages[messages.length - 1];
    const isMedia = messages.some(m => m.hasMedia);
    const combinedBody = messages.map(m => m.body || "").filter(b => b !== "").join("\n");
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

    let contact;
    try {
        if (message && typeof message.getContact === 'function' && message.id && message.id._serialized) {
            contact = await message.getContact();
            if (contact && contact.number) {
                const oldId = userId;
                realPhone = contact.number;

                if (userId.includes('@lid') || (isFromAdmin && !userId.includes('@g.us'))) {
                    userId = realPhone + '@c.us';

                    // MIGRACIÓN DE ESTADO: Si el ID cambió (de @lid a @c.us) y tenemos estado en el viejo, lo pasamos al nuevo
                    if (oldId !== userId && userStates.has(oldId)) {
                        const oldData = userStates.get(oldId);
                        const newData = userStates.get(userId) || {};

                        // Solo migramos si el nuevo está vacío o si el viejo tiene información más relevante (como items en carrito)
                        if (!newData.state || (oldData.items && oldData.items.length > 0)) {
                            userStates.set(userId, { ...oldData, ...newData });
                            console.log(`[LID Migration] Migrado estado de ${oldId} a ${userId} para preservar contexto.`);
                        }
                        userStates.delete(oldId);
                    }
                }
            }
        }
    } catch (err) {
        console.warn("No se pudo obtener contacto del mensaje:", err.message);
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

    let foundName = contact ? (contact.name || contact.pushname) : null;
    if (!foundName) {
        const { searchContactByPhone } = require('./googleContactsService');
        foundName = await searchContactByPhone(userId);

        // Si aún no hay nombre, buscar en la base de datos de Excel por el número
        if (!foundName) {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(realPhone);
            if (userAccounts && userAccounts.length > 0) {
                foundName = userAccounts[0].Nombre || userAccounts[0].nombre;
            }
        }
    }


    // 2. ESTADO ACTUAL
    let currentStateData = userStates.get(userId);
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
    if (!message.fromMe && foundName && !realPhone.includes(ADMIN_RAW_PHONE) && !userId.includes('@g.us')) {
        const { addNewContact } = require('./googleContactsService');
        // addNewContact ya tiene validación interna y caché local para evitar duplicados
        await addNewContact(foundName, realPhone);

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

    if (currentState === 'waiting_human') {
        const mode = (currentStateData && typeof currentStateData === 'object') ? (currentStateData.waiting_human_mode || 'bot') : 'bot';
        const cleanInput = (message.body || '').trim().toLowerCase();

        // 0. FORCED SILENCE RULE: If the advisor interacted in the last 10 minutes, keep the bot strictly muted
        const lastInteraction = (currentStateData && currentStateData.lastHumanInteraction) || 0;
        const timeSinceLastHumanMs = Date.now() - lastInteraction;
        const minutesSinceLastHuman = timeSinceLastHumanMs / (1000 * 60);

        if (minutesSinceLastHuman < 10) {
            console.log(`[BOT MUTE ACTIVE] Silenciando bot para @${userId} porque el asesor interactuó hace ${minutesSinceLastHuman.toFixed(1)} minutos (ventana de 10 min activa).`);
            return;
        }

        // 1. Evaluar de inmediato si es una intención resoluble para reactivar el bot (incluso si está en modo advisor/silenciado)
        let isSolvable = false;
        let mediaData = null;
        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (media && media.data && media.mimetype) {
                    mediaData = { data: media.data, mimeType: media.mimetype.split(';')[0] };
                }
            } catch (e) { }
        }

        try {
            const { detectInitialIntent } = require('./aiService');
            const hist = await getChatHistoryText(message, 15);
            const detection = await detectInitialIntent(message.body, hist, mediaData);

            const cleanBody = (message.body || "").trim();
            const solvableIntents = ["comprar", "pagar", "credenciales", "catalogo", "renovar"];
            const isMenuSelection = ['1', '2', '3', '4', '5'].includes(cleanBody);
            
            const wantsCodeKeywords = [
                'código', 'codigo', 'actualizar hogar', 'mi codigo', 'mi código',
                'enviar código', 'enviar codigo', 'el código', 'el codigo',
                'pide codigo', 'pide código', 'authenticator', 'token', 'verificacion', 'verificación'
            ];
            
            // Check if the message contains code request keywords
            let isCodeRequest = wantsCodeKeywords.some(kw => cleanBody.toLowerCase().includes(kw)) || cleanBody === '?';

            // Also check if Gemini's media description detects a Netflix/Disney code or home screen
            if (mediaData && detection) {
                const imgDesc = (detection.explanation || "").toLowerCase();
                const wantsImgCode = [
                    'hogar', 'dispositivo', 'código', 'codigo', 'netflix', 'sesión', 'sesion', 'tv', 'televisor'
                ].some(kw => imgDesc.includes(kw));

                if (wantsImgCode) {
                    isCodeRequest = true;
                    console.log(`[BOT MEDIA OCR DETECTED] La imagen del cliente parece solicitar código de Netflix/Disney. Activando reactivación.`);
                }
            }

            if (isMenuSelection || isCodeRequest || (detection && solvableIntents.includes(detection.intent))) {
                console.log(`[BOT MUTE REACTIVATE IMMEDIATE] Reactivando bot porque el mensaje de @${userId} es resoluble de inmediato (Menú/Código/Intención: ${detection ? detection.intent : 'desconocida'}). isCode=${isCodeRequest}`);
                userStates.delete(userId);
                currentState = undefined;
                isSolvable = true;
            }
        } catch (err) {
            console.error("Error en reactivación inmediata por intenciones:", err.message);
        }

        if (!isSolvable) {
            // Verificar si el modo advisor ha expirado por inactividad del asesor (más de 2 horas)
            let isAdvisorExpired = false;
            if (mode === 'advisor') {
                if (!currentStateData.clientWaitingSince) {
                    currentStateData.clientWaitingSince = Date.now();
                    userStates.set(userId, currentStateData);
                }

                const clientWaitingMs = Date.now() - currentStateData.clientWaitingSince;
                const minutesWaiting = clientWaitingMs / (1000 * 60);

                const lastInteraction = (currentStateData && currentStateData.lastHumanInteraction) || 0;
                const timeSinceLastHumanMs = Date.now() - lastInteraction;
                const minutesSinceLastHuman = timeSinceLastHumanMs / (1000 * 60);

                if (minutesSinceLastHuman > 120) {
                    console.log(`[BOT MUTE EXPIRE] El asesor no ha interactuado en ${minutesSinceLastHuman.toFixed(1)} minutos con @${userId}. Expirando modo advisor.`);
                    isAdvisorExpired = true;
                } else if (minutesWaiting > 30) {
                    // SI EL BOT NO PUEDE RESOLVERLO Y YA PASARON 30 MIN DE ESPERA DEL CLIENTE: Alertar al administrador y dar turno de cola
                    if (!global.supportQueue) global.supportQueue = [];
                    let turnIdx = global.supportQueue.indexOf(userId);
                    if (turnIdx === -1) {
                        global.supportQueue.push(userId);
                        turnIdx = global.supportQueue.length - 1;
                    }
                    const turnNumber = turnIdx + 1;

                    const lastWarning = (currentStateData && currentStateData.lastWarningTime) || 0;
                    if (Date.now() - lastWarning > 15 * 60 * 1000) {
                        await message.reply(`🤖 Hola, lamentamos la demora. Nuestro equipo de soporte ha estado muy ocupado, pero sigues en nuestra lista de espera.\n\n📍 *Tu turno actual es el #${turnNumber}*.\n\nUn asesor se comunicará contigo lo antes posible. ¡Agradecemos mucho tu paciencia! ⏳`);
                        
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                await groupChat.sendMessage(`⏳ *ALERTA DE INACTIVIDAD DE ASESOR* ⏳\n\nEl cliente *${foundName || 'Cliente'}* (@${realPhone}) lleva más de *30 minutos* esperando respuesta del asesor y requiere atención humana.\n\n📍 *Turno en cola:* #${turnNumber}\n\nPor favor, atiende este chat lo antes posible.`);
                            }
                        } catch (err) {
                            console.error("Error notificando al grupo sobre inactividad del asesor:", err.message);
                        }

                        userStates.set(userId, { 
                            ...currentStateData, 
                            lastWarningTime: Date.now() 
                        });
                    }
                    return; // Mantener silencio absoluto del bot de cara a resolver intenciones
                }
            } else {
                const stateAgeMs = Date.now() - (currentStateData.timestamp || Date.now());
                if (stateAgeMs > 2 * 60 * 60 * 1000) {
                    console.log(`[BOT MUTE EXPIRE] Estado de advisor muy antiguo sin timestamp de interacción. Expirando.`);
                    isAdvisorExpired = true;
                }
            }

            // Reactivación rápida explícita para ambos modos o si el modo advisor expiró
            if (cleanInput === 'menu' || cleanInput === 'menú' || cleanInput.includes('@bot') || isAdvisorExpired) {
                console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} (expirado o explícito).`);
                userStates.delete(userId);
                currentState = undefined;
            } else {
                // Silencio absoluto para consultas no resolubles en modo advisor / bot
                console.log(`[DEBUG] Usuario @${userId.replace('@c.us', '')} está en waiting_human (modo ${mode}). Manteniendo silencio absoluto.`);
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
    if (checkCobros === '@bot cobros automáticos' || checkCobros === '@bot cobros automaticos') {
        await handleAutoCobros(message, userId, userStates, pendingConfirmations);
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
        } else if (adminAI.intent === 'dame_cuenta') {
            const { handleAdminForceRetrieve } = require('./adminService');
            await handleAdminForceRetrieve(message, adminAI.target_platform || adminAI.target_user || message.body, client, adminAI.target_user);
            return;
        } else if (adminAI.intent === 'confirmar_pago' || isReplyConfirmation) {
            const { handleAdminPaymentConfirmation } = require('./adminService');
            let targetPhone = adminAI.target_user ? adminAI.target_user.replace(/\D/g, '') : null;

            // Fallback manual si la IA no detectó el número pero está en el texto
            if (!targetPhone) {
                const regex = /57\s*3\d{2}\s*\d{7}|3\d{9}/;
                const match = message.body.match(regex);
                if (match) targetPhone = match[0].replace(/\s+/g, '');
            }

            let targetId = targetPhone ? (targetPhone.includes('@') ? targetPhone : targetPhone + '@c.us') : null;

            // Prioridad: 1. Quoted Message, 2. Target Phone, 3. globalLastPaymentUserId
            if (isReplyConfirmation) {
                const quotedMsg = await message.getQuotedMessage();
                const phoneRegex = /(57\d{10})|(\d{10})/;
                const match = quotedMsg.body.match(phoneRegex);
                if (match) {
                    let num = match[0];
                    if (num.length === 10) num = '57' + num;
                    targetId = num + '@c.us';
                } else if (quotedMsg.from !== client.info.wid._serialized) {
                    // Si no hay número en el texto pero el mensaje citado es de un cliente (no del bot)
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
                            const userAccounts = await getAccountsByPhone(phoneNumber);
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
                await message.reply('❌ Formato: @bot autorizar [contacts/gmail] [codigo]');
            } else {
                const service = parts[1].toLowerCase();
                const code = parts[2];
                const { getOAuth2Client } = require('./googleAuthService');
                await message.reply(`⏳ Intentando autorizar servicio ${service} con el código proporcionado...`);
                try {
                    const auth = await getOAuth2Client(service, code);
                    if (auth) {
                        await message.reply(`✅ Servicio ${service} autorizado y token guardado correctamente.`);
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
        } else if ((command.startsWith('enviale credenciales') || command.startsWith('enviar credenciales') || command.startsWith('enviales credenciales')) && !command.includes('todos') && !command.includes('los de')) {
            const { handleSendBulkCredentials } = require('./adminService');
            const { getAccountsByPhone } = require('./apiService');
            await handleSendBulkCredentials(message, command, client, getAccountsByPhone, userStates);
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

    // --- GENERAL CODE INTERCEPTOR (Netflix, Disney+, Max, Amazon, GPT, etc.) ---
    const lowerBody = cleanBody.toLowerCase();

    const wantsCodeKeywords = [
        'código', 'codigo', 'actualizar hogar', 'mi codigo', 'mi código',
        'enviar código', 'enviar codigo', 'el código', 'el codigo',
        'pide codigo', 'pide código', 'authenticator', 'token', 'verificacion', 'verificación'
    ];
    const platformsSupported = ['netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'gpt', 'chatgpt', 'youtube', 'spotify'];
    const hasCodeKeyword = wantsCodeKeywords.some(kw => lowerBody.includes(kw));
    const hasPlatformKeyword = platformsSupported.some(p => lowerBody.includes(p));
    const isQuestionOrCode = lowerBody === '?' || lowerBody.includes('enviar') || wantsCodeKeywords.some(kw => lowerBody === kw);

    if (hasCodeKeyword || (isQuestionOrCode && hasPlatformKeyword) || isQuestionOrCode) {
        try {
            const { getAccountsByPhone } = require('./apiService');
            const userAccounts = await getAccountsByPhone(realPhone);

            if (userAccounts.length > 0) {
                let targetAccount = null;

                // 1. Intentar buscar coincidencia directa por plataforma
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
                if (m.hasMedia) {
                    const media = await m.downloadMedia();
                    if (media && media.data && media.mimetype) {
                        const cleanMime = media.mimetype.split(';')[0];
                        mediaData.push({ data: media.data, mimeType: cleanMime });
                    }
                }
            }
        } catch (err) {
            console.error("Error descargando multimedia del lote:", err.message);
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

                // Si el carrito está vacío, intentar auto-rellenarlo
                if (!stateData.items || stateData.items.length === 0) {
                    const { getAccountsByPhone } = require('./apiService');
                    let userAccounts = [];
                    try { userAccounts = await getAccountsByPhone(realPhone); } catch (e) { }

                    if (check.inferredPlatform) {
                        console.log(`[PAYMENT INTERCEPTOR] Auto-rellenando carrito vacío con: ${check.inferredPlatform}`);

                        // Intentar obtener el precio real de la plataforma en el catálogo
                        let catalogPrice = 0;
                        try {
                            const { getPlatforms } = require('./salesService');
                            const platforms = await getPlatforms();
                            const lowerInferred = check.inferredPlatform.toLowerCase().replace(/[^a-z0-9]/g, '');
                            const matchedPlatform = platforms.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(lowerInferred)) ||
                                platforms.find(p => lowerInferred.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
                            if (matchedPlatform) {
                                if (matchedPlatform.name.toLowerCase().includes('spotify')) {
                                    // Spotify tiene planes de 10000 (Individual) y 8000 (Owner)
                                    const matchedPlan = matchedPlatform.plans.find(p => p.price === check.amount);
                                    if (matchedPlan) {
                                        catalogPrice = matchedPlan.price;
                                    } else {
                                        const individualPlan = matchedPlatform.plans.find(p => p.name.toLowerCase().includes('individual'));
                                        catalogPrice = individualPlan ? individualPlan.price : 10000;
                                    }
                                } else if (matchedPlatform.plans && matchedPlatform.plans.length > 0) {
                                    catalogPrice = matchedPlatform.plans[0].price;
                                }
                            }
                        } catch (platErr) {
                            console.error("[PAYMENT INTERCEPTOR] Error buscando precio de plataforma en catálogo:", platErr.message);
                        }

                        stateData.items = [{ Streaming: check.inferredPlatform, platform: { name: check.inferredPlatform } }];
                        stateData.total = catalogPrice || check.amount;
                        stateData.isAutoFilled = true;
                        userStates.set(userId, stateData); // Persistir el auto-llenado
                    } else if (userAccounts.length === 1) {
                        const singleAcc = userAccounts[0];
                        stateData.items = [singleAcc];
                        stateData.total = check.amount;
                        stateData.isAutoFilled = true;
                        stateData.isImplicitFallback = true; // Flag para confirmación de precisión
                        userStates.set(userId, stateData); // Persistir el auto-llenado
                    }
                }

                // --- NUEVO: VALIDACIÓN AUTOMÁTICA GMAIL ---
                let leftoverAmount = 0;
                if (check.amount && check.amount > 0) {
                    const expectedTotal = stateData.total || 0;
                    leftoverAmount = (expectedTotal > 0 && check.amount > expectedTotal) ? (check.amount - expectedTotal) : 0;
                    try {
                        const isShortPayment = expectedTotal > 0 && check.amount < expectedTotal;

                        if (isShortPayment) {
                            console.log(`[PAYMENT AUTO-VALIDATE] ❌ Monto del comprobante ($${check.amount}) es menor al total esperado ($${expectedTotal}) para @${userId}. No se auto-validará.`);
                            
                            userStates.set(userId, {
                                ...stateData,
                                state: 'awaiting_payment_confirmation',
                                paymentMethod: check.bank || 'Transferencia',
                                checkAmount: check.amount
                            });
                            globalLastPaymentUserId = userId;
                            
                            const diff = expectedTotal - check.amount;
                            const replyText = `🤖 ¡Hola! He recibido tu comprobante por valor de *$${check.amount.toLocaleString('es-CO')}*.\n\n` +
                                `Sin embargo, el total de tu pedido es de *$${expectedTotal.toLocaleString('es-CO')}* COP. Aún hace falta un pago por el valor restante de *$${diff.toLocaleString('es-CO')}* COP. ⚠️\n\n` +
                                `Por favor realiza la transferencia del monto restante y envía el nuevo comprobante para poder completar tu pedido y entregar/activar tu servicio. ¡Muchas gracias! 😊`;
                            
                            await message.reply(replyText);
                            
                            try {
                                const groupChat = await client.getChatById(GROUP_ID);
                                if (groupChat) {
                                    let adminMsg = `🚨 *COMPROBANTE DETECTADO INCOMPLETO* (@${userId.replace('@c.us', '')})\n` +
                                        `⚠️ *PAGO INCOMPLETO* (Faltan $${diff})\n` +
                                        `Banco: ${check.bank || 'No identificado'}\n` +
                                        `Monto Recibido: $${check.amount}\n` +
                                        `Monto Esperado: $${expectedTotal}\n\n` +
                                        `Valida el pago y confirma usando:\n*confirmar ${userId.replace('@c.us', '')}*`;

                                    await groupChat.sendMessage(adminMsg);
                                    const mediaToForward = await message.downloadMedia();
                                    await groupChat.sendMessage(mediaToForward);
                                }
                            } catch (adminErr) {
                                console.error("Error notificando al grupo sobre pago incompleto:", adminErr.message);
                            }
                            return;
                        } else {
                            const match = await findMatchingPayment(check.amount, 60); // Ventana de 60 min
                            if (match) {
                                console.log(`[PAYMENT AUTO-VALIDATE] ✅ Match encontrado en Gmail para @${userId} ($${check.amount})`);

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
                                        if (groupChat) {
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
                const notaTexto = isAutoMethod
                    ? `Aunque ${check.bank || 'el medio de pago'} cuenta con validación automática, no logramos detectar la notificación de tu transferencia en nuestro sistema (a veces el banco tarda en notificar). Por esta razón, nuestro equipo validará tu comprobante de forma manual. Esto puede demorar un poco más. ⏳`
                    : `Como enviaste el comprobante por un medio manual (Nequi/Daviplata tradicional), nuestro equipo humano tendrá que verificarlo de forma manual. Esto puede demorar un poco más. ⏳`;

                const replyText = `🤖 He recibido tu comprobante de pago. ¡Muchas gracias! 🎉

⚠️ *Nota:* ${notaTexto}

💡 *Recomendación para la próxima:* Si realizas tus transferencias utilizando nuestro *QR Negocios* o la *Llave Bre-V / Bre-B*, el bot validará tu pago automáticamente y te entregará el servicio en segundos sin esperar por humanos. ⚡🤖

Un asesor ya está notificado y revisará tu transferencia lo más pronto posible. ¡Gracias por tu paciencia! 😊`;

                await message.reply(replyText);

                // Notificar al grupo administrativo
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        let adminMsg = `🚨 *COMPROBANTE DETECTADO* (@${userId.replace('@c.us', '')})\n` +
                            `Banco: ${check.bank || 'No identificado'}\n` +
                            `Monto: ${check.amount || 'No legible'}\n\n`;
                        
                        if (leftoverAmount > 0) {
                            adminMsg += `💰 *EXCEDENTE DETECTADO:* Sobran *$${leftoverAmount.toLocaleString('es-CO')}* COP.\n\n`;
                        }
                        
                        adminMsg += `Valida el pago y confirma usando:\n*confirmar ${userId.replace('@c.us', '')}*`;

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
                return; // Salir, ya procesamos el mensaje
            } else {
                // --- NUEVO: DETECCIÓN DE FALLO PREMATURO ---
                // Si mandó una imagen que NO es pago, revisamos si tiene cuentas activas
                const lowerBatch = batchText.toLowerCase();
                const errorKeywords = ['falla', 'error', 'funciona', 'caido', 'suspendid', 'problema', 'sale asi', 'sacó', 'mira lo que', 'no deja', 'qué pasó', 'que paso', 'bloquead', 'no sirve'];
                const hasErrorText = errorKeywords.some(k => lowerBatch.includes(k));

                if (hasErrorText) {
                    const { getAccountsByPhone } = require('./apiService');
                    const { getTodayInBogota, getJsDateFromExcel } = require('./apiService');
                    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
                    const accounts = await getAccountsByPhone(phoneNumber);

                    const activeAccountWithProblem = accounts.find(acc => {
                        const expDate = getJsDateFromExcel(acc.deben);
                        const today = getTodayInBogota();
                        return expDate && expDate > today; // Cuenta sigue vigente en el papel
                    });

                    if (activeAccountWithProblem) {
                        const expD = getJsDateFromExcel(activeAccountWithProblem.deben);
                        const dateStr = expD ? expD.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : activeAccountWithProblem.deben;
                        console.log(`[FAULT DETECTOR] 🚨 Posible fallo prematuro detectado para @${userId}`);
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                const adminMsg = `🚨 *POSIBLE FALLO PREMATURO* (@${userId.replace('@c.us', '')})\n` +
                                    `El cliente reporta un error pero su cuenta de *${activeAccountWithProblem.Streaming}* vence hasta el *${dateStr}*.\n\n` +
                                    `Favor revisar el chat de inmediato.`;
                                await groupChat.sendMessage(adminMsg);
                                const mediaToForward = await message.downloadMedia();
                                await groupChat.sendMessage(mediaToForward);
                            }
                        } catch (e) { }
                    }
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
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
    let userAccounts = [];
    try {
        userAccounts = await getAccountsByPhone(phoneNumber);
    } catch (e) {
        console.warn("[Context] Error fetching accounts for AI context:", e.message);
    }

    // 2. DETECCIÓN DE INTENCIÓN Y NOMBRE (Global para todos los estados)
    const hist = await getChatHistoryText(message, 25);
    const messageAgeMinutes = Math.floor((Date.now() / 1000 - message.timestamp) / 60);

    // Construimos el contexto del lote actual para que la IA entienda la ráfaga de mensajes
    const batchContext = messages.length > 1
        ? `\n[MENSAJES EN ESTA RÁFAGA RECIENTE]:\n${messages.map(m => `- ${m.body || '[Media]'}`).join('\n')}\n`
        : "";

    // Añadimos el contexto de antigüedad al historial para que la IA se disculpe si es necesario
    // --- COOLDOWN DE RESPUESTAS (Anti-Burst) ---
    const now = Date.now();
    const lastResp = lastResponseTimestamps.get(userId) || 0;
    if (!isFromAdmin && (now - lastResp < RESPONSE_COOLDOWN)) {
        console.log(`[Cooldown] Ignorando ráfaga para ${userId} (${now - lastResp}ms desde última respuesta)`);
        return;
    }
    lastResponseTimestamps.set(userId, now);

    const timedHist = `[ESTE MENSAJE LLEGÓ HACE ${messageAgeMinutes} MINUTOS]\n${hist}`;
    const detection = await detectInitialIntent(inputToUse, timedHist, (mediaData && mediaData.length > 0) ? mediaData[0] : null, userAccounts);

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
    }

    const isSingleDigit = /^\d+$/.test(inputToUse.trim());
    const statesExpectingNumbers = ['selecting_plans', 'adding_platform', 'awaiting_code_account_selection', 'awaiting_payment_renewal_confirmation'];
    const isMenuDigit = ['1', '2', '3', '4', '5'].includes(inputToUse.trim());
    let isForcedMenuBreakout = false;
    if (isMenuDigit && currentState && !statesExpectingNumbers.includes(currentState)) {
        isForcedMenuBreakout = true;
    }

    const isChangingTopic = detection.intent && 
                            !['desconocido', 'comprar', 'pagar', 'cierre', 'renovar', 'duda_contexto'].includes(detection.intent) &&
                            !(isSingleDigit && statesExpectingNumbers.includes(currentState));
    const isVeryFrustrated = detection.frustrationLevel >= 7;

    // NUEVO breakout específico para awaiting_churn_reason cuando el usuario no quiere cancelar
    let isChurnRefusal = false;
    if (currentState === 'awaiting_churn_reason') {
        const lowerBody = inputToUse.toLowerCase();
        const hasRefusalText = lowerBody.includes('no quiero cancelar') || lowerBody.includes('no cancel') || lowerBody.includes('no voy a cancelar') || lowerBody.includes('error') || lowerBody.includes('solo preguntaba') || lowerBody.includes('solo estoy preguntando') || lowerBody.includes('cuanto me saldria') || lowerBody.includes('cuánto me saldría');
        const isRefusalIntent = ['renovar', 'pagar', 'comprar'].includes(detection.intent);
        if (hasRefusalText || isRefusalIntent) {
            isChurnRefusal = true;
            console.log(`[Churn Breakout] El cliente rechaza la cancelación. Intent: ${detection.intent}, Texto: "${inputToUse}"`);
        }
    }

    if ((flowsRequiringBreakout.includes(currentState) && (isChangingTopic || isVeryFrustrated || isPivottingPlatform || isForcedMenuBreakout)) || isChurnRefusal) {
        console.log(`[Flow Breakout] Rompiendo flujo '${currentState}' para @${userId}. Razón: ${isChurnRefusal ? 'Rechazo de cancelación' : (isForcedMenuBreakout ? 'Fuerza de menú numérico' : (isPivottingPlatform ? 'Pivot plataforma' : (isChangingTopic ? 'Cambio de tema (' + detection.intent + ')' : 'Alta frustración')))}`);

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

            // 4.5 DETECCIÓN DE FRUSTRACIÓN / INSISTENCIA (Startup/Unread handle)
            const frustration = detection.frustrationLevel || 0;
            const unreads = message._unreadCount || 0;

            const solvableIntents = ["comprar", "pagar", "credenciales", "catalogo", "renovar"];
            if ((frustration >= 7 || unreads >= 10) && !solvableIntents.includes(detection.intent)) {
                console.log(`[Flow Recovery] 🚨 Detectada alta frustración (${frustration}) o insistencia (${unreads}) para @${userId}. Pasando a waiting_human.`);

                const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                const supportStatus = await isSupportOpen();

                userStates.set(userId, {
                    state: 'waiting_human',
                    nombre: foundName,
                    waitingCount: 1,
                    waiting_human_mode: 'bot'
                });

                if (!supportStatus.open) {
                    const config = getSupportScheduleConfig();
                    const queuePos = getQueuePosition(userId, userStates);
                    let offlineMsg = config.offline_message || "Hola, he detectado que necesitas soporte personalizado. En este momento estamos fuera de nuestro horario de atención humana y no hay asesores activos.";
                    if (queuePos) {
                        offlineMsg += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}.\n⚠️ _(Nota: Dado que estamos fuera de nuestro horario de atención, tu turno no avanzará hasta que nuestros asesores inicien labores de nuevo)._`;
                    }
                    await message.reply(offlineMsg + " 🤖");
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
                // Pero solo si el mensaje NO contiene palabras de compra explícitas (ej: "comprar", "nueva", "quiero una")
                const isExplicitPurchase = inputToUse.toLowerCase().includes('comprar') || inputToUse.toLowerCase().includes('nueva');

                if (userAccounts.length > 0 && !detection.detectedPlatform && !isExplicitPurchase) {
                    const durationMonths = getDurationMonths(detection, inputToUse);
                    await processCheckPrices(message, userId, userStates, null, detection.detectedPlatform, durationMonths);
                    return;
                }

                // Priorizamos la venta: Si ya tenemos algún nombre (venga de contactos o de la IA), seguimos adelante.
                if (!foundName) {
                    await message.reply(`🤖 ¡Hola! Con gusto te ayudo con tu compra. ¿Me podrías regalar tu nombre y apellido completo para registrarte oficialmente? 😊`);
                    userStates.set(userId, { ...existingState, state: 'awaiting_name_for_contact', nextFlow: 'comprar' });
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
                if (!foundName) {
                    const existingState = userStates.get(userId) || {};
                    await message.reply(`🤖 ¡Hola! Con gusto te ayudo. Para buscar tus cuentas de forma segura, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
                    userStates.set(userId, { ...existingState, state: 'awaiting_name_for_contact', nextFlow: 'credenciales' });
                    return;
                }
                const { processCheckCredentials } = require('./billingService');
                await processCheckCredentials(userId, client, message.body, "", userStates);
                return;
            } else if (detection.intent === 'catalogo') {
                await message.reply("🤖 ¡Claro! Puedes ver nuestro catálogo actualizado con todos los precios y realizar tu compra directamente en nuestra página web: https://sheerit.com.co/ 🌐\n\nSi tienes alguna duda específica sobre un servicio, ¡cuéntame!");
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
                    const userAccounts = await getAccountsByPhone(realPhone);

                    if (userAccounts.length > 0) {
                        const targetPlatformLower = platform.toLowerCase();
                        let targetAccount = userAccounts.find(c => {
                            const streamingName = (c.Streaming || "").toLowerCase();
                            if (targetPlatformLower.includes('hbo') || targetPlatformLower.includes('max')) {
                                return streamingName.includes('hbo') || streamingName.includes('max');
                            }
                            if (targetPlatformLower.includes('amazon') || targetPlatformLower.includes('prime')) {
                                return streamingName.includes('amazon') || streamingName.includes('prime');
                            }
                            return streamingName.includes(targetPlatformLower) || targetPlatformLower.includes(streamingName);
                        });

                        // Si no hay coincidencia directa pero solo tiene 1 cuenta, usar esa
                        if (!targetAccount && userAccounts.length === 1) {
                            targetAccount = userAccounts[0];
                        }

                        // Si tiene varias, presentar opciones
                        if (!targetAccount && userAccounts.length > 1) {
                            let msg = `🤖 Hola, detecté que enviaste una captura de pantalla solicitando un código para *${platform.toUpperCase()}*.\n\nVeo que tienes registradas múltiples cuentas activas. ¿De cuál de ellas necesitas el código de verificación?\n\n`;
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

                // Si no es un caso de 2FA/código, lo enviamos directamente a atención humana
                const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                const supportStatus = await isSupportOpen();
                
                userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

                if (!supportStatus.open) {
                    const config = getSupportScheduleConfig();
                    const queuePos = getQueuePosition(userId, userStates);
                    let offlineMsg = config.offline_message || "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos.";
                    if (queuePos) {
                        offlineMsg += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}.\n⚠️ _(Nota: Dado que estamos fuera de nuestro horario de atención, tu turno no avanzará hasta que nuestros asesores inicien labores de nuevo)._`;
                    }
                    await safeReply(message, offlineMsg + " 🤖", userId);
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

            // 6. FLUJO POR DEFECTO (Más sutil y conversacional)
            const historyForFallback = await getChatHistoryText(message);

            userAccounts = [];
            try { userAccounts = await getAccountsByPhone(userId.replace(/\D/g, '')); } catch (e) { }

            const fallback = await generateEmpatheticFallback(message.body || "", message.hasMedia, historyForFallback, (mediaData && mediaData.length > 0) ? mediaData[0] : null, userAccounts, userId, userStates);

            // Si la respuesta es genérica o es un saludo, ahí sí mandamos el menú
            const currentData = userStates.get(userId) || {};
            if (foundName) {
                userStates.set(userId, { ...currentData, state: 'main_menu', nombre: foundName });
                await safeReply(message, `🤖 ¡Hola de nuevo${!nameIsComplete ? '' : ', *' + foundName + '*'}! Qué gusto saludarte.\n\nEscoge una opción:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)`, userId);
            } else {
                const welcomeMsg = "🤖 ¡Hola! Soy el asistente virtual de *Sheerit*.\n\nPara poder ayudarte mejor, ¿cómo te llamas? O si lo prefieres, escoge una opción del menú:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)";
                await safeReply(message, welcomeMsg, userId);
                userStates.set(userId, { ...currentData, state: 'main_menu' });
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
            } else if (responseOption === '2') {
                await message.reply("🤖 Entendido. He pausado el registro automático para que un asesor de soporte revise tu comprobante y te entregue tu nuevo servicio manualmente. ¡Gracias por tu paciencia! 😊");
                userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        await groupChat.sendMessage(`🚨 *PAGO MANUAL REQUERIDO (NUEVO SERVICIO)* de @${userId.replace('@c.us', '')}\n` +
                            `Monto: $${currentStateData.amount}\n` +
                            `Banco: ${currentStateData.bank || 'Nequi'}\n` +
                            `Asunto: ${currentStateData.subject}\n` +
                            `El cliente indicó que el pago NO es para renovar su cuenta actual de ${(currentStateData.matchedAccount.Streaming || "Servicio").toUpperCase()}.`);
                    }
                } catch (e) { }
            } else {
                await message.reply("🤖 Por favor, responde únicamente con *1* (Sí, renovar) o *2* (No, servicio nuevo).");
            }
            break;
        case 'awaiting_code_account_selection':
            const selectionIdx = parseInt((message.body || "").trim()) - 1;
            const candidates = currentStateData.candidates || [];
            if (isNaN(selectionIdx) || selectionIdx < 0 || selectionIdx >= candidates.length) {
                await message.reply("🤖 Por favor, responde únicamente con el número de la opción que deseas (ej. 1 o 2).");
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

            if (emailMatch && phoneMatch) {
                const appleId = emailMatch[0].trim();
                const phoneNumber = phoneMatch[0].replace(/\s+/g, '');

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
                await message.reply("🤖 No pude identificar tu número de celular y/o tu correo (Apple ID).\n\nPor favor, envíamelos en un solo mensaje.\n*(Ejemplo: 3101234567, miusuario@icloud.com)*");
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
                        if (groupChat) {
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
                // addNewContact ya tiene validación interna y caché local
                await addNewContact(name, userId.replace('@c.us', ''));
            } catch (e) { }
            userStates.set(userId, { state: 'main_menu', nombre: name });
            await message.reply("🤖 ¡Un placer conocerte, *" + name + "*! Ya quedaste agendado. Ahora sí, ¿en qué te puedo ayudar hoy?\n\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)");
            break;
        case 'awaiting_churn_reason':
            const reason = (message.body || "").trim();
            const cState = userStates.get(userId) || {};
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
    if (messageQueues.has(userId)) {
        console.log(`[Stale Guard] 🛑 Abortando respuesta para @${userId.replace('@c.us', '')} porque hay nuevos mensajes en cola.`);
        return null;
    }
    return await message.reply(content);
}

/**
 * Event Listener principal
 */
client.on('message', async (message) => {
    // Manejo de mensajes antiguos
    if (message.timestamp < BOT_START_TIME) {
        if (message.from.includes('@g.us') || message.from.includes('status@broadcast')) return;
        const shouldProcess = await new Promise(resolve => {
            startupLock = startupLock.then(async () => {
                try {
                    const chat = await message.getChat();
                    const msgs = await chat.fetchMessages({ limit: 5 });
                    let isHuman = false;
                    for (const m of msgs) {
                        if (m.fromMe && !m.body.includes('🤖')) { isHuman = true; break; }
                    }
                    if (isHuman) {
                        userStates.set(message.from, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now(), waiting_human_mode: 'advisor' });
                        resolve(false);
                    } else {
                        await new Promise(r => setTimeout(r, 2500));
                        resolve(true);
                    }
                } catch (e) { resolve(false); }
            });
        });
        if (!shouldProcess) return;
    }

    // Ignorar propios
    if (message.fromMe) return;

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
        // Los mensajes de grupo se procesan instantáneamente (normalmente no hay ráfagas de imágenes para el bot aquí)
        if (message.from === GROUP_ID && message.body && message.body.toLowerCase().startsWith('@bot')) {
            await processIncomingMessage([message]);
        } else {
            let groupState = userStates.get(message.from);
            if (groupState && typeof groupState === 'object') groupState = groupState.state;
            if (message.from === GROUP_ID && groupState === 'awaiting_cobros_confirmation') {
                await processIncomingMessage([message]);
            } else {
                const b = message.body ? message.body.toLowerCase().trim() : '';
                if (message.from === GROUP_ID && (b.includes('liberar masivo') || b.startsWith('!bot') || b.startsWith('!liberar') || b.startsWith('liberar ') || b.startsWith('confirmar_cobros '))) {
                    // dejar pasar
                } else {
                    return;
                }
            }
        }
        return;
    }

    if (message.from.includes('status@broadcast')) return;
    if (globalBotSleep && message.from !== OPERATOR_NUMBER && message.from !== GROUP_ID) return;

    // --- MECANISMO DE BATCHING PARA MENSAJES INDIVIDUALES ---
    const userId = message.from;
    if (!messageQueues.has(userId)) {
        messageQueues.set(userId, { messages: [], timer: null });
    }

    const queue = messageQueues.get(userId);
    if (queue.timer) clearTimeout(queue.timer);

    queue.messages.push(message);

    queue.timer = setTimeout(async () => {
        const batch = [...queue.messages];
        messageQueues.delete(userId);
        console.log(`[Batch Processor] Procesando lote de ${batch.length} mensajes para @${userId.replace('@c.us', '')}`);
        await processIncomingMessage(batch);
    }, BATCH_INTERVAL);
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
                    const history = await getChatHistoryText(message);
                    let accounts = [];
                    try { accounts = await getAccountsByPhone(userId.replace(/\D/g, '')); } catch (e) { }
                    const fallback = await generateEmpatheticFallback(message.body || "", isMedia, history, singleMediaData, accounts);
                    if (fallback.replyMessage) {
                        await message.reply(fallback.replyMessage);
                    }
                    return;
                } else if (detection.intent === 'soporte') {
                    const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
                    const supportStatus = await isSupportOpen();
                    
                    userStates.set(userId, { state: 'waiting_human', waitingCount: 0, waiting_human_mode: 'bot' });

                    if (!supportStatus.open) {
                        const config = getSupportScheduleConfig();
                        const queuePos = getQueuePosition(userId, userStates);
                        let offlineMsg = config.offline_message || "Hola, nuestro horario de atención humana ha terminado. En este momento no hay asesores activos.";
                        if (queuePos) {
                            offlineMsg += `\n\n📌 *Tu turno en la cola de espera:* #${queuePos}.\n⚠️ _(Nota: Dado que estamos fuera de nuestro horario de atención, tu turno no avanzará hasta que nuestros asesores inicien labores de nuevo)._`;
                        }
                        await safeReply(message, offlineMsg + " 🤖", userId);
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

            // Si no es un número, usamos la IA para ver si tiene una duda o comentario
            const history = await getChatHistoryText(message);

            let accounts = [];
            try { accounts = await getAccountsByPhone(userId.replace(/\D/g, '')); } catch (e) { }

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


async function handleAwaitingPaymentMethod(message, userId, isMedia = false, singleMediaData = null, text = null) {
    const textToUse = text || message.body || '';
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

    if (message.hasMedia || body.includes("ya pagu") || body.includes("listo") || body.includes("claro que si") || body.includes("enviado") || body.includes("transferencia") || body.includes("comprobante")) {

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
                        return;
                    }

                    if (isAutoValidate) {
                        // ✅ Llave Bre-V correcta o QR del negocio: validar monto y proceder
                        const expectedTotal = stateData.total || 0;
                        const amountMatches = expectedTotal <= 0 || Math.abs(check.amount - expectedTotal) < 500;

                        if (!amountMatches) {
                            console.log(`[AUTO-VALIDATE] ❌ Monto ${check.amount} no coincide con esperado ${expectedTotal}.`);
                            await message.reply(
                                `🤖 Revisé tu comprobante: detecté un pago de *$${check.amount.toLocaleString('es-CO')}* a la llave correcta, ` +
                                `pero el total de tu pedido es *$${expectedTotal.toLocaleString('es-CO')}*. ` +
                                `Por favor verifica el monto y envía nuevamente el comprobante correcto. 😊`
                            );
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
                                checkAmount: check.amount
                            });
                            return;
                        }

                        const validationResult = await executePaymentValidation(
                            userId,
                            { ...stateData, total: check.amount || stateData.total, paymentMethod: `Auto-OCR Llave (${check.bank || 'Transferencia'})` },
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
    console.error('🔥 Promesa Rechazada sin manejo (El bot sigue vivo):', reason);
});

client.initialize().catch(err => console.error('Error al inicializar cliente:', err));

// Escáner Atiende Pendientes (cada 5 minutos)
setInterval(async () => {
    try {
        console.log('[Atiende Pendientes Scan] Iniciando escaneo automático de chats no leídos...');
        if (typeof processPendingChats === 'function') {
            await processPendingChats(client, userStates, processIncomingMessage);
        } else {
            console.warn('⚠️ [Atiende Pendientes Scan] La función processPendingChats no está disponible.');
        }
    } catch (err) {
        console.error('❌ [Atiende Pendientes Scan] Error durante el escaneo automático:', err.message);
        if (isCriticalBrowserError(err)) {
            console.error('🔥 [ANTI-ZOMBIE] Error crítico detectado en escaneo. Forzando reinicio para PM2...');
            process.exit(1);
        }
    }
}, 5 * 1000 * 60);

// Bloque de escaneo automático de pagos eliminado (redundante con validación push)
