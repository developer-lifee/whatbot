const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
// Sobrescribir consola para añadir timestamps
const originalLog = console.log;
console.log = function() {
    const now = new Date();
    const timestamp = `[${now.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}]`;
    originalLog.apply(console, [timestamp, ...arguments]);
};
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Funciones auxiliares de estabilidad
function isCriticalBrowserError(err) {
    if (!err || !err.message) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('detached frame') || 
           msg.includes('execution context was destroyed') || 
           msg.includes('navigation failed') ||
           msg.includes('connection closed');
}
const { pool } = require('./database');
const { initDailyAutomation } = require('./scheduledTasks');
const { detectPaymentMethod, generateCredentialsResponse, generateEmpatheticFallback, detectInitialIntent, isPaymentReceipt } = require('./aiService');
const { getAccountsByPhone } = require('./apiService');
const { searchContactByPhone, addNewContact } = require('./googleContactsService');
const { getChatHistoryText } = require('./salesService');
const { checkNewPayments } = require('./gmailService');

// --- CONSTANTES Y ESTADOS GLOBALES ---
const userStates = new Map();
const pendingConfirmations = new Map();
const GROUP_ID = '120363102144405222@g.us';
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573107946794') + '@c.us';
let globalBotSleep = false;

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
  getNetflixMatchReport
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
        const oldOperador = (netflixAcct.Operador || "").toString();
        let newOperadorRecord = oldOperador;
        
        // Only append IP if it's not already recorded
        if (!oldOperador.includes(clientIp)) {
            newOperadorRecord = oldOperador ? `${oldOperador} | IP: ${clientIp}` : `IP: ${clientIp}`;
            await updateExcelData(netflixAcct._rowNumber, { "Operador": newOperadorRecord });
            console.log(`[NETFLIX API] Saved IP ${clientIp} for @${phone} (Row ${netflixAcct._rowNumber})`);
        } else {
            console.log(`[NETFLIX API] IP ${clientIp} was already recorded for @${phone}`);
        }
    }
    
    res.json({ success: true, message: `Código de Hogar enviado para la cuenta: ${netflixAcct.correo}`, account: netflixAcct.correo, ip: clientIp });
  } catch(e) {
    console.error("[NETFLIX API Error]:", e);
    res.status(500).json({ error: e.message });
  }
});

// Admin Dashboard Endpoints
app.get('/api/admin/clients', async (req, res) => {
    try {
        const { fetchCustomersData } = require('./apiService');
        const clients = await fetchCustomersData();
        res.json(clients);
    } catch(e) {
        res.status(500).json({ error: e.message });
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

        // Guardar estado en memoria o base de datos.
        // Simulando customers_temp con un objeto en memoria (si el bot se reinicia, se pierde, pero para el prototipo es funcional)
        // Lo correcto sería guardarlo en customers_temp de MySQL si la tabla existe. 
        // Ya que whatbot usa MySQL para `getExpiredAccounts` y no sabemos si `customers_temp` existe, guarderemos en global scope o lo probamos en mysql.
        // Por seguridad lo guardamos en un local map:
        global.pendingSales = global.pendingSales || new Map();
        global.pendingSales.set(orderId, {
            ...customer,
            numbersStr: numbers.join(','),
            platformName: platform.name
        });

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
    } catch(e) {
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
            global.pendingSales = global.pendingSales || new Map();
            const customerData = global.pendingSales.get(orderId);
            
            if (customerData) {
                console.log(`Venta aprobada vía Webhook para orden ${orderId}`);
                
                // Usando recordNewSale de whatbot
                const { recordNewSale } = require('./salesRegistryService');
                const userState = {
                    items: [{ platform: { name: customerData.platformName } }],
                    subscriptionType: 'mensual', // Podemos obtenerla de la vista si se pasó
                    nombre: `${customerData.firstName} ${customerData.lastName}`
                };

                const phoneId = customerData.whatsapp.includes('@') ? customerData.whatsapp : `${customerData.whatsapp}@c.us`;
                
                const results = await recordNewSale(phoneId, userState, "Bold Pagos");
                console.log("Resultados guardado en Excel via Bold:", results);
                
                // Enviar confirmación por WhatsApp
                let successMsg = `¡Hola ${customerData.firstName}! 👋\n\nHemos recibido tu pago exitosamente y tu pedido ya está registrado en nuestro sistema.\nEn breve te asignaremos tus servicios.`;
                await client.sendMessage(phoneId, successMsg);

                global.pendingSales.delete(orderId);
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
        const { fetchCustomersData } = require('./apiService');
        const clients = await fetchCustomersData();
        const now = new Date();
        
        const stats = {
            totalClients: clients.length,
            byPlatform: {},
            byStatus: { active: 0, expired: 0, warning: 0 },
            expirations: { next7Days: 0, next15Days: 0, next30Days: 0 },
            revenueEstimate: 0
        };

        clients.forEach(c => {
            // Platform Stats
            const plat = (c.Streaming || 'Otros').split(' ')[0] || 'Otros';
            stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;

            // Date processing
            if (c['Fecha Vencimiento']) {
                const venc = new Date(c['Fecha Vencimiento']);
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
        });

        res.json(stats);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/actions/send-info', async (req, res) => {
    try {
        const { phone, type, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const { getAccountsByPhone } = require('./apiService');
        const accounts = await getAccountsByPhone(phone);
        if (!accounts || accounts.length === 0) return res.status(404).json({ success: false, message: 'Client not found' });

        const clientData = accounts[0];
        let message = "";

        if (type === 'credentials') {
            message = `*Tus Credenciales de Sheer IT*\n\n` +
                      `🍿 *Servicio:* ${clientData.Streaming}\n` +
                      `📧 *Usuario:* ${clientData.correo}\n` +
                      `🔑 *Contraseña:* ${clientData['pin perfil'] || 'N/A'}\n` +
                      `👤 *Perfil:* ${clientData.Nombre}\n\n` +
                      `📅 *Vence:* ${clientData['Fecha Vencimiento']}\n\n` +
                      `¡Disfruta tu servicio!`;
        } else if (type === 'payment') {
            message = `¡Hola ${clientData.Nombre}! 👋\n\n` +
                      `Te recordamos que tu suscripción de *${clientData.Streaming}* está próxima a vencer (${clientData['Fecha Vencimiento']}).\n\n` +
                      `Puedes renovar realizando tu transferencia aquí:\n` +
                      `*Nequi/Daviplata:* 3133866170\n\n` +
                      `Una vez realizado, envíanos el comprobante por este medio. ¡Gracias!`;
        }

        const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        
        res.json({ success: true, message: 'Message sent via WhatsApp' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/sales/create', async (req, res) => {
    try {
        const { phone, name, items, duration, total, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const { recordNewSale } = require('./salesRegistryService');
        
        // Map duration to subscriptionType
        let subscriptionType = 'mensual';
        if (duration === '6') subscriptionType = 'semestral';
        if (duration === '12') subscriptionType = 'anual';

        // Prepare dummy state for recordNewSale
        const userState = {
            items: items.map(it => ({ platform: { name: it.platformName } })),
            subscriptionType,
            nombre: name
        };

        const phoneId = phone.includes('@') ? phone : `${phone}@c.us`;
        const results = await recordNewSale(phoneId, userState, "Web Admin");

        res.json({ success: true, results });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/match', async (req, res) => {
    try {
        const isp = req.query.isp || '';
        const { getNetflixMatchReport } = require('./adminService');
        const matchData = await getNetflixMatchReport(isp);
        res.json(matchData);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Legacy PHP logic migration: Support Management
app.get('/api/support', (req, res) => {
    try {
        const supportData = fs.readFileSync(path.join(__dirname, 'support.json'), 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(supportData);
    } catch(e) {
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
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/support/upload', upload.single('image'), (req, res) => {
    try {
        const password = req.body.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (req.file) {
             const publicUrl = `http://localhost:3000/uploads/${req.file.filename}`; // Replace localhost in Prod
             res.json({ success: true, url: publicUrl }); 
        } else {
             res.json({ success: false, message: 'No se envió ninguna imagen' });
        }
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

const server = http.createServer(app);
const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Servidor Express corriendo en el puerto ${port}`);
  
  // Heartbeat cada 5 minutos (reducido para detectar cuelgues de Puppeteer)
  setInterval(async () => {
    try {
      const state = client ? await client.getState() : 'UNINITIALIZED';
      console.log(`💓 Heartbeat: Proceso vivo. Estado del cliente: ${state}`);
    } catch (err) {
      console.error('⚠️ Heartbeat: Error al obtener el estado del cliente:', err.message);
      if (isCriticalBrowserError(err)) {
          console.error('🔥 [ANTI-ZOMBIE] Detectado error crítico de Puppeteer. Forzando reinicio para PM2...');
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
  },
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  markOnlineAvailable: false,
  takeoverOnConflict: true, 
  takeoverTimeoutMs: 15000 
});

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
});

client.on('ready', () => {
  console.log('✅ Conexión establecida correctamente. ¡Bot listo!');
  
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
  // Si usas PM2, esto forzará un reinicio
  console.log('⚠️ Intentando forzar reinicio del proceso...');
  process.exit(1);
});

client.on('auth_failure', (msg) => {
  console.error('❌ FALLO DE AUTENTICACIÓN:', msg);
  process.exit(1);
});

// Manejo de llamadas automáticas
client.on('call', async (call) => {
  console.log(`[CALL] ✨ Llamada entrante de ${call.from}. Rechazando y enviando aviso.`);
  try {
    await call.reject();
    await client.sendMessage(call.from, "🤖 *AVISO DE SOPORTE*: Hola, gracias por contactar a Sheerit. Te informamos que nuestro soporte y atención es **exclusivamente por CHAT**.\n\nPor favor, deja tu mensaje aquí y un asesor te atenderá lo antes posible. ¡Gracias por tu comprensión! 😊");
  } catch(e) {
    console.error('Error al rechazar llamada:', e);
  }
});

// Implement incoming_call para compatibilidad con diferentes versiones
client.on('incoming_call', async (call) => {
  console.log(`[INCOMING_CALL] ✨ Llamada entrante de ${call.from}. Rechazando y enviando aviso.`);
  try {
    await call.reject();
    await client.sendMessage(call.from, "🤖 *AVISO DE SOPORTE*: Hola, gracias por contactar a Sheerit. Te informamos que nuestro soporte y atención es **exclusivamente por CHAT**.\n\nPor favor, deja tu mensaje aquí y un asesor te atenderá lo antes posible. ¡Gracias por tu comprensión! 😊");
  } catch(e) {
    console.error('Error al rechazar llamada (incoming_call):', e);
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

  // DETECTAR INTERVENCIÓN HUMANA: Si el mensaje lo envío yo manualmente
  // a un chat que NO es un grupo y NO tiene el emoji del bot.
  if (msg.fromMe && !msg.to.includes('@g.us') && !msg.to.includes('@broadcast') && !msg.to.includes('@lid')) {
    const targetId = msg.to;
    
    // Comando o mención en el chat para reactivar el bot
    if (msg.body.toLowerCase().includes('@bot')) {
       userStates.delete(targetId);
       console.log(`[BOT UNMUTE] Reactivado por mención en el chat ${targetId}.`);
       
       // Suministramos el mensaje al procesador para que la IA lea el contexto y responda
       // Usamos un pequeño delay para que WhatsApp registre el mensaje enviado antes de responder
       setTimeout(() => {
           processIncomingMessage(msg).catch(err => console.error('Error en reactivación por mención:', err));
       }, 1000);
       return;
    }

    // Si el mensaje NO contiene el emoji 🤖 ni @bot, asumimos que fue enviado manualmente.
    if (!msg.body.includes('🤖')) {
      if (userStates.get(targetId) !== 'waiting_human') {
        console.log(`[BOT MUTE] Detectada intervención manual para ${targetId}. Pasando a estado 'waiting_human'.`);
        userStates.set(targetId, 'waiting_human');
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
    try { userAccounts = await getAccountsByPhone(phoneNumber); } catch(e){}
    
    // Si isMedia y no hay texto, body podría estar vacío, igual se pasa.
    const fallbackResult = await generateEmpatheticFallback(message.body || "", isMedia, historyText, mediaData, userAccounts);
    
    // Puede que devuelva solo string si algo falló gravemente, por precaución validamos
    if (typeof fallbackResult === 'string') {
        await message.reply(fallbackResult);
        return;
    }

    if (fallbackResult.replyMessage) {
        await message.reply(fallbackResult.replyMessage);
    }
    
    if (fallbackResult.needsEscalation) {
         try {
            const chat = await client.getChatById(GROUP_ID);
            if (chat) {
               // Resolver número real para el reporte (LID fix)
               const contact = await message.getContact();
               const realPhone = contact.number || userId.replace(/\D/g, '');
               await chat.sendMessage(`🚨 *ESCALAMIENTO IA SOPORTE* de @${realPhone}\n\n${fallbackResult.escalationSummary || 'Revisión manual requerida.'}`);
            }
         } catch(e) { console.error('Error enviando escalamiento:', e); }
         userStates.set(userId, 'waiting_human');
    }
}

// Eliminamos isNameIncomplete anterior para delegar a la IA


/**
 * Procesa un mensaje entrante siguiendo la lógica de estados del bot.
 * @param {Message} message 
 */
async function processIncomingMessage(message) {
  // 1. IDENTIDAD Y RESOLUCIÓN DE NÚMERO (LID FIX)
  const userId = message.fromMe ? message.to : message.from;
  let contact;
  try {
      contact = await message.getContact();
  } catch (err) {
      console.warn("No se pudo obtener contacto del mensaje:", err.message);
      contact = { number: userId.replace(/\D/g, '') }; // fallback básico
  }

  const realPhone = contact.number || userId.replace(/\D/g, '');
  
  let foundName = contact.name || contact.pushname;
  if (!foundName) {
      const { searchContactByPhone } = require('./googleContactsService');
      foundName = await searchContactByPhone(userId);
  }

  // 2. ESTADO ACTUAL
  let currentStateData = userStates.get(userId);
  let currentState = undefined;
  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  // --- FILTRO DE MENSAJES PROPIOS (ADMIN) ---
  const cleanBodyText = message.body ? message.body.trim() : "";
  const isAdminCommand = cleanBodyText.toLowerCase().startsWith("@bot ");

  if (message.fromMe) {
      // Excepción: Permitir comandos de @bot para el admin dashboard
      if (isAdminCommand) {
          console.log(`[Admin] Comando detectado de la propia cuenta: ${cleanBodyText}`);
      } else {
          if (currentState !== 'waiting_human') {
              console.log(`[BOT MUTE] Detectada intervención manual para ${userId}. Silenciando bot.`);
              userStates.set(userId, { state: 'waiting_human', nombre: foundName, waitingCount: 0 });
          }
          return;
      }
  }

  // --- ANTI-AUTO-CONTESTAR (Loop Protection) ---
  // Si el mensaje contiene el emoji del bot (🤖), es una respuesta automática.
  // Ignoramos COMPLETAMENTE para no entrar en bucles de autocontestación.
  if (message.body && message.body.includes('🤖')) {
      console.log(`[Auto] Ignorando mensaje automático (🤖) para @${userId.replace('@c.us', '')}`);
      return;
  }

  // Ignorar stickers, reacciones, y estados
  if (message.type === 'sticker' || message.type === 'reaction' || message.isStatus) {
      console.log(`[Ignorado] Mensaje tipo ${message.type} de ${userId}.`);
      return;
  }
  
  // Ignorar mensajes que son exclusivamente emojis
  const cleanBodyText = message.body ? message.body.trim() : "";
  const emojiRegex = /^[\p{Emoji}\s]+$/u;
  if (cleanBodyText && emojiRegex.test(cleanBodyText)) {
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
  } catch (err) {}

  // Sincronizar con Google Contacts si tenemos un nombre válido y no es un mensaje del bot
  if (!message.fromMe && foundName) {
      const { addNewContact, searchContactByPhone } = require('./googleContactsService');
      // Solo intentar agregar si no lo encontramos por el número real
      const existingInGoogle = await searchContactByPhone(realPhone);
      if (!existingInGoogle) {
          console.log(`[Google Contacts] Intentando guardar nuevo contacto: ${foundName} (${realPhone})`);
          await addNewContact(foundName, realPhone);
      }
  }

  // --- IDENTIFICADOR DE ESTADO INICIAL ---
  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  if (currentState === 'waiting_human') {
      // Reactivación inteligente (waiting human temporal)
      const cleanInput = (message.body || '').trim().toLowerCase();
      
      // Si el cliente envía una frase rápida o menú, lo reactivamos
      if (['1', '2', '3', '4', '5'].includes(cleanInput) || cleanInput === 'menu' || cleanInput === 'menú' || cleanInput === 'hola') {
          console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} por intención explícita.`);
          userStates.delete(userId);
          currentState = undefined;
      } else {
           // Evaluar intención mediante IA para ver si el bot puede solucionarlo
           // Aumentamos historial a 25 para no perder contexto de días anteriores
           const hist = await getChatHistoryText(message, 25);
           
           let mediaData = null;
           if (message.hasMedia) {
               try {
                   const media = await message.downloadMedia();
                   if (media && media.data && media.mimetype) {
                       const cleanMime = media.mimetype.split(';')[0];
                       mediaData = { data: media.data, mimeType: cleanMime };
                   }
               } catch (e) {
                   console.error("[DEBUG] Error descargando media en silence mode:", e.message);
               }
           }

           const detection = await detectInitialIntent(message.body, hist, mediaData);
           
           if (["comprar", "pagar", "credenciales"].includes(detection.intent)) {
              console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} por detección de IA: ${detection.intent}`);
              userStates.delete(userId);
              currentState = undefined;
              // Continuamos el flujo...
          } else if (detection.intent === 'cierre') {
              console.log(`[DEBUG] Cierre detectado para @${userId} en waiting_human. Bot ignorando.`);
              return;
          } else {
              let sData = typeof currentStateData === 'object' ? currentStateData : { state: 'waiting_human' };
              let wCount = (sData.waitingCount || 0) + 1;
              sData.waitingCount = wCount;
              userStates.set(userId, sData);
              
              if (wCount === 2) {
                  // Sonda proactiva: En lugar de solo decir "espera", preguntamos qué necesita para ver si podemos ayudar ante la duda.
                  await message.reply("🤖 Hola, sigo con mucha demanda de chats, pero no quiero que esperes de más. Mientras llega un asesor, ¿puedes resumirme si necesitas una *contraseña*, *ver precios* o *confirmar un pago*? Quizás yo mismo pueda ayudarte ahora.");
              } else if (wCount >= 4 && wCount % 3 === 0) {
                  await message.reply("🤖 Seguimos con alto volumen de chats, pero tu caso ya está en la cola para revisión manual.");
              }
              console.log(`[DEBUG] Usuario ${realPhone} (@${userId}) insiste en waiting_human (Count: ${wCount}).`);
              return;
          }
      }
  }

  console.log('[DEBUG] Procesando mensaje de:', userId, 'Contenido:', message.body);

  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  // --- Cobros parser: mensaje especial ---
  if (message.body && message.body.toLowerCase().startsWith('@bot porfa haz los cobros para hoy de:')) {
    await handleCobrosParser(message, userId, userStates, pendingConfirmations);
    return;
  }

  // --- Cobros automáticos: mensaje especial ---
  const checkCobros = message.body ? message.body.toLowerCase().trim() : '';
  if (checkCobros === '@bot cobros automáticos' || checkCobros === '@bot cobros automaticos') {
    await handleAutoCobros(message, userId, userStates, pendingConfirmations);
    return;
  }

  // --- Admin Data Queries (Dashboard Conversacional) ---
  // Permitimos consultas en grupos si empiezan con @bot y vienen del admin
  if (userId.includes('3133890800') && message.body && message.body.toLowerCase().startsWith('@bot ')) {
      const query = message.body.substring(5).trim();
      if (query.length > 0) {
          const { processAdminQuery } = require('./adminQueries');
          await processAdminQuery(message, query, userStates, client);
          return;
      }
  }

  // Comandos de operador/administrador
  if (message.from === OPERATOR_NUMBER || message.from === GROUP_ID) {
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
  const isBotCommand = message.from === GROUP_ID && message.body && message.body.toLowerCase().startsWith('@bot');
  const isReplyConfirmation = message.from === GROUP_ID && message.hasQuotedMsg && (
      ['si', 'ya', 'listo', 'confirmado', 'vale', 'ok', 'claro'].includes(message.body.toLowerCase().trim()) ||
      message.body.toLowerCase().includes('confirmar') ||
      message.body.toLowerCase().includes('si me llego')
  );

  if (isBotCommand || isReplyConfirmation) {
      let command = "";
      let overridePhone = null;

      if (isBotCommand) {
          command = message.body.toLowerCase().replace('@bot', '').trim();
      }

      if (isReplyConfirmation) {
          const quotedMsg = await message.getQuotedMessage();
          const phoneRegex = /57\d{10}/;
          const match = quotedMsg.body.match(phoneRegex);
          if (match) {
              overridePhone = match[0];
              command = "confirmar " + overridePhone;
              console.log(`[Admin] Detectada confirmación por respuesta para @${overridePhone}`);
          }
      }

      if (command === 'duermete') {
          globalBotSleep = true;
          await message.reply('😴 Modo dormido activado. No responderé a los clientes automáticamente hasta que me despiertes con *@bot despiertate*.');
          return;
      } else if (command === 'despiertate') {
          globalBotSleep = false;
          await message.reply('😃 ¡He despertado! Vuelvo a atender a los clientes.');
          return;
      } else if (command.includes('contesta') || command.includes('atiende pendientes')) {
          await handleBatchUnanswered(message, client, userStates, processIncomingMessage);
          return;
      } else if (command.includes('confirmar') || command.includes('si me llego') || command.includes('si la recibi')) {
          await handleAdminPaymentConfirmation(message, command, client, userStates, overridePhone);
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
      } else if (command.startsWith('enviale credenciales') || command.startsWith('enviar credenciales')) {
          const { handleSendBulkCredentials } = require('./adminService');
          const { getAccountsByPhone } = require('./apiService');
          await handleSendBulkCredentials(message, command, client, getAccountsByPhone, userStates);
          return;
      }
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
          }
      }
  }

  let cleanBody = message.body ? message.body.trim() : "";
  if (cleanBody.startsWith('"') && cleanBody.endsWith('"')) {
    cleanBody = cleanBody.slice(1, -1).trim();
  }

  const netflixKeywords = ['código de netflix', 'codigo de netflix', 'actualizar hogar', 'mi codigo', 'mi código'];
  if (netflixKeywords.some(kw => cleanBody.toLowerCase().includes(kw))) {
      try {
          const { getAccountsByPhone } = require('./apiService');
          const userAccounts = await getAccountsByPhone(realPhone);
          const netflixAcct = userAccounts.find(c => {
              const streamingName = (c.Streaming || "").toLowerCase();
              return streamingName.includes('netflix') && !streamingName.includes('extra');
          });
          if (netflixAcct) {
              await message.reply(`🤖 ¡Hola! Para generar tu código de hogar de forma segura, ingresa a este enlace:\n\n👉 https://sheerit.com.co/verificar?tel=${realPhone}`);
          } else {
              await message.reply(`🤖 No encontré una cuenta de Netflix principal activa a este número para asociar el hogar.`);
          }
      } catch(e) {
          console.error("Error en validación netflix intercept:", e);
      }
      return;
  }

  if (cleanBody.toLowerCase().startsWith("hola, estoy interesado en")) {
    message.body = cleanBody;
    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
    return;
  }

  // Permitimos procesar media en waiting_human para que el interceptor de pagos pueda sacarlo de ese estado.
  if (message.hasMedia && currentState !== 'awaiting_payment_confirmation') {
    const history = await getChatHistoryText(message);
    let mediaData = null;
    try {
      const media = await message.downloadMedia();
      if (media && media.data && media.mimetype) {
         const cleanMime = media.mimetype.split(';')[0];
         mediaData = { data: media.data, mimeType: cleanMime };
      }
    } catch(err) {}

    // --- INTERCEPTOR GLOBAL DE PAGOS ---
    if (mediaData) {
      const check = await isPaymentReceipt(mediaData, history);
      if (check.isReceipt) {
          console.log(`[PAYMENT INTERCEPTOR] ✅ Comprobante detectado (${check.bank || 'Banco'}) para @${userId}`);
          
          const existing = userStates.get(userId);
          const stateData = typeof existing === 'object' ? { ...existing } : { nombre: foundName };
          
          // Revisamos si en el carrito (items) hay un servicio de Netflix
          let hasNetflix = false;
          if (stateData.items && Array.isArray(stateData.items)) {
              hasNetflix = stateData.items.some(item => {
                  const name = item.Streaming || (item.platform ? item.platform.name : "") || item.name || "";
                  return name.toLowerCase().includes('netflix');
              });
          }

          if (hasNetflix) {
              await message.reply("🤖 ¡Gracias! He recibido tu comprobante de pago. 🎉\n\nListo, me confirmas por favor localidad o municipio donde se va a usar y operador de internet\n\nEj. suba-movistar");
              
              userStates.set(userId, { 
                  ...stateData, 
                  state: 'awaiting_netflix_operator_post_payment',
                  paymentMethod: check.bank || 'Transferencia',
                  checkAmount: check.amount
              });
              
              // No notificamos al administrador todavía para no sobrecargar el chat; lo haremos cuando responda.
              return;
          }

          userStates.set(userId, { 
              ...stateData, 
              state: 'awaiting_payment_confirmation',
              paymentMethod: check.bank || 'Transferencia'
          });

          await message.reply("🤖 ¡Gracias! He recibido tu comprobante de pago. 🎉\nUn asesor lo validará manualmente en un momento para entregarte tu cuenta. ¡Gracias por tu paciencia! 😊");

          // Notificar al grupo administrativo
          try {
              const groupChat = await client.getChatById(GROUP_ID);
              if (groupChat) {
                  let adminMsg = `🚨 *COMPROBANTE DETECTADO* (@${userId.replace('@c.us', '')})\n` +
                                 `Banco: ${check.bank || 'No identificado'}\n` +
                                 `Monto: ${check.amount || 'No legible'}\n\n` +
                                 `Valida el pago y confirma usando:\n*confirmar ${userId.replace('@c.us', '')}*`;
                  
                  await groupChat.sendMessage(adminMsg);
                  const mediaToForward = await message.downloadMedia();
                  await groupChat.sendMessage(mediaToForward);
              }
          } catch (adminErr) {
              console.error("Error notificando al grupo sobre pago interceptado:", adminErr.message);
          }
          return; // Salir, ya procesamos el mensaje
      }
    }

    await processFallbackWithEscalation(message, userId, true, mediaData, history);
    return;
  }

  switch (currentState) {
    case undefined:
      const cleanInput = (message.body || '').trim();
      if (['1', '2', '3', '4', '5'].includes(cleanInput)) {
         userStates.set(userId, { state: 'main_menu' });
         await handleMainMenuSelection(message, userId);
         return;
      }

      const hist = await getChatHistoryText(message, 25);
      const detection = await detectInitialIntent(message.body, hist);

      // 3. IDENTIDAD TERCERO: IA revisando historial
      if (!foundName && detection.userName) {
          foundName = detection.userName;
          console.log(`[AI Discovery] Nombre hallado en historial para @${userId.replace('@c.us', '')}: ${foundName}`);
      }

      // Determinar si el nombre es completo según la IA o si ya lo teníamos validado
      const nameIsComplete = detection.isNameComplete || false;

      // 4. RECUPERACIÓN DE ESTADO (Stateless Recovery)
      if (detection.recoveredState) {
          console.log(`[Flow Recovery] Recuperando estado: ${detection.recoveredState} para @${userId.replace('@c.us', '')}`);
          const metadata = detection.metadata || {};
          userStates.set(userId, { state: detection.recoveredState, nombre: foundName, ...metadata });
          
          if (detection.recoveredState === 'waiting_human') {
              console.log(`[Flow Recovery] 🤫 Silenciando bot para @${userId.replace('@c.us', '')} por intervención humana detectada en historial.`);
              return; // Silencio absoluto si un humano estaba hablando
          }

          if (detection.recoveredState === 'awaiting_payment_method') {
              await message.reply(`🤖 ¡Hola${foundName ? ' ' + foundName : ''}! Veo que estábamos en proceso de pago. ¿Por cuál medio deseas realizar la transferencia? (Nequi, Daviplata, Bancolombia, etc.)`);
              return;
          }
      }

      // 4.5 DETECCIÓN DE FRUSTRACIÓN / INSISTENCIA (Startup/Unread handle)
      const frustration = detection.frustrationLevel || 0;
      const unreads = message._unreadCount || 0;
      
      const solvableIntents = ["comprar", "pagar", "credenciales"];
      if ((frustration >= 7 || unreads >= 3) && !solvableIntents.includes(detection.intent)) {
          console.log(`[Flow Recovery] 🚨 Detectada alta frustración (${frustration}) o insistencia (${unreads}) para @${userId}. Pasando a waiting_human.`);
          
          // Inicializamos el contador en 1 para que no se autopise con el bucle de "seguimos ocupados"
          userStates.set(userId, { 
              state: 'waiting_human', 
              nombre: foundName, 
              waitingCount: 1 
          });
          await message.reply("🤖 Hola, he visto tus mensajes. Noté que has estado esperando un momento; nuestros asesores están con alta demanda pero ya tienen tu caso en cola para atenderte manualmente a la brevedad. ¡Gracias por tu paciencia! 😊");
          return;
      }

      // 5. MANEJO DE INTENCIONES
      if (detection.intent === 'cierre') {
          console.log(`[Cierre] Intent 'cierre' detectado para ${userId}. Silenciando respuesta.`);
          userStates.delete(userId);
          return;
      }
      
      if (detection.intent === 'comprar') {
          if (!nameIsComplete) {
              const greeting = foundName ? `¡Hola ${foundName}! Veo que te tengo como ${foundName}.` : "¡Hola! Con gusto te ayudo con tu compra.";
              await message.reply(`🤖 ${greeting} Para proceder con tu registro oficial y evitar duplicados, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
              userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'comprar' });
              return;
          }
          userStates.set(userId, { state: 'awaiting_purchase_platforms', nombre: foundName });
          await message.reply(`🤖 ¡Perfecto${foundName ? ' ' + foundName : ''}! Con gusto te ayudo con tu compra.`);
          await startPurchaseProcess(message, userId, userStates);
          return;
      } else if (detection.intent === 'credenciales') {
          if (!nameIsComplete) {
              const greeting = foundName ? `¡Hola ${foundName}!` : "¡Hola! Con gusto te ayudo.";
              await message.reply(`🤖 ${greeting} Para buscar tus cuentas de forma segura, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
              userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'credenciales' });
              return;
          }
          await message.reply(`🤖 Entendido${foundName ? ' ' + foundName : ''}, te ayudaré a revisar tus credenciales de inmediato.`);
          await processCheckCredentials(message, userId);
          return;
      } else if (detection.intent === 'pagar') {
          await message.reply(`🤖 ¡Claro${foundName ? ' ' + foundName : ''}! Vamos a revisar tus cuentas para el pago.`);
          await processCheckPrices(message, userId, userStates);
          return;
      }

      // 6. FLUJO POR DEFECTO (Si no hay intención clara, no forzamos nombre completo aún)
      if (foundName) {
        userStates.set(userId, { state: 'main_menu', nombre: foundName });
        await message.reply(`🤖 ¡Hola de nuevo${!nameIsComplete ? '' : ', *' + foundName + '*' }! Qué gusto saludarte.\n\nEscoge una opción:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)`);
      } else {
        await message.reply("🤖 ¡Hola! Soy el asistente virtual de *Sheerit*.\n\nEscoge una opción para ayudarte:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)");
        userStates.set(userId, { state: 'main_menu' });
      }
      break;
    case 'main_menu':
      await handleMainMenuSelection(message, userId);
      break;
    case 'awaiting_netflix_operator_post_payment':
      const ispInfo = (message.body || "").trim();
      const st = userStates.get(userId) || {};
      
      userStates.set(userId, { ...st, state: 'awaiting_payment_confirmation', netflixIsp: ispInfo });

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
      await handleAwaitingPaymentMethod(message, userId);
      break;
    case 'awaiting_cobros_confirmation':
      await handleAwaitingCobrosConfirmation(message, userId, userStates, pendingConfirmations, client);
      break;
    case 'awaiting_payment_confirmation':
      await handleAwaitingPaymentConfirmation(message, userId);
      break;
    case 'waiting_human':
      console.log(`[DEBUG] Usuario ${userId} en modo waiting_human. Bot ignorando.`);
      break;
    case 'awaiting_purchase_platforms':
      await handleAwaitingPurchasePlatforms(message, userId, userStates, client, GROUP_ID);
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
          await addNewContact(name, userId.replace('@c.us', ''));
      } catch(e) {}
      userStates.set(userId, { state: 'main_menu', nombre: name });
      await message.reply("🤖 ¡Un placer conocerte, *" + name + "*! Ya quedaste agendado. Ahora sí, ¿en qué te puedo ayudar hoy?\n\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)");
      break;
    default:
      const historyText = await getChatHistoryText(message);
      await processFallbackWithEscalation(message, userId, false, null, historyText);
      break;
  }
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
                   userStates.set(message.from, 'waiting_human');
                   resolve(false);
                } else {
                   await new Promise(r => setTimeout(r, 2500));
                   resolve(true);
                }
             } catch(e) { resolve(false); }
         });
    });
    if (!shouldProcess) return;
  }

  // Ignorar propios
  if (message.fromMe) return;

  // Filtros de grupo
  if (message.from.includes('@g.us')) {
      if (message.from === GROUP_ID && message.body && message.body.toLowerCase().startsWith('@bot')) {
          // Dejar pasar a processIncomingMessage
      } else {
          let groupState = userStates.get(message.from);
          if (groupState && typeof groupState === 'object') groupState = groupState.state;
          if (message.from === GROUP_ID && groupState === 'awaiting_cobros_confirmation') {
              // dejar pasar
          } else {
              const b = message.body ? message.body.toLowerCase().trim() : '';
              if (message.from === GROUP_ID && (b.includes('liberar masivo') || b.startsWith('!bot') || b.startsWith('!liberar') || b.startsWith('liberar ') || b.startsWith('confirmar_cobros '))) {
                 // dejar pasar
              } else {
                 return;
              }
          }
      }
  }

  if (message.from.includes('status@broadcast') || message.from.includes('@lid')) return;
  if (globalBotSleep && message.from !== OPERATOR_NUMBER && message.from !== GROUP_ID) return;

  await processIncomingMessage(message);
});


// Funciones de manejo de estados
async function handleMainMenuSelection(message, userId) {
  const userSelection = message.body.trim();
  switch (userSelection) {
    case '1':
      await startPurchaseProcess(message, userId, userStates);
      break;
    case '2':
      await processCheckCredentials(message, userId);
      break;
    case '3':
      await processCheckPrices(message, userId, userStates);
      break;
    case '4':
      await message.reply("🤖 *Soporte Técnico Sheerit*\n\nPor favor describe tu problema detalladamente o envíame una captura de pantalla del error que estás experimentando. Te guiaré paso a paso para solucionarlo. Si el problema es complejo, escribe *5* en cualquier momento para hablar con un asesor humano.");
      break;
    case '5':
      // Reportar al grupo para atención humana
      try {
        const chat = await client.getChatById(GROUP_ID);
        if (chat) {
          let realPhone = userId.replace(/\D/g, '');
          try {
              const contact = await message.getContact();
              if (contact && contact.number) realPhone = contact.number;
          } catch(e) {
              console.warn("[Menu] No se pudo obtener el contacto para notificar grupo:", e.message);
          }
          await chat.sendMessage(`🚨 Nuevo caso para atención: Usuario @${realPhone} seleccionó "Otro" y necesita ayuda de un asesor.`);
        } else {
          console.error('Grupo no encontrado con ID:', GROUP_ID);
        }
      } catch (error) {
        console.error('Error enviando mensaje al grupo:', error);
      }
      await message.reply("🤖 Un asesor te atenderá lo más pronto posible. He silenciado mis respuestas automáticas para que puedas hablar con un humano.");
      userStates.set(userId, 'waiting_human');
      break;
    default:
      // Si no es un número, usamos la IA para ver si tiene una duda o comentario
      const history = await getChatHistoryText(message);
      const fallback = await generateEmpatheticFallback(message.body, false, history);
      
      if (fallback.replyMessage && !fallback.replyMessage.includes("Por favor, selecciona una opción válida")) {
          await message.reply(fallback.replyMessage);
          
          if (fallback.needsEscalation) {
              const chat = await client.getChatById(GROUP_ID);
              if (chat) {
                  const contact = await message.getContact();
                  const realPhone = contact.number || userId.replace(/\D/g, '');
                  await chat.sendMessage(`🚨 *ESCALACIÓN DESDE EL MENÚ* (@${realPhone})\nResumen: ${fallback.escalationSummary}`);
              }
              userStates.set(userId, 'waiting_human');
          }
      } else {
          await message.reply("🤖 Por favor, selecciona una opción válida del menú (1-5), o escribe tu duda para ayudarte.");
      }
      break;
  }
}


async function handleAwaitingPaymentMethod(message, userId) {
  await processPaymentSelection(message, userId, message.body);
}

async function processPaymentSelection(message, userId, text) {
  // Usar AI para detectar método de pago
  const method = await detectPaymentMethod(text);

  const paymentDetails = {
    'nequi': "3118587974",
    'daviplata': "3107946794",
    'bancolombia': "46772753713\nBancolombia - ahorros\nNumero de cuenta: 46772753713\nCC1032936324",
    'banco caja social': "24111572331\nESTEBAN AVILA\ncc: 1032936324",
    'transfiya': "*LLAVE*\n3118587974", // Legacy support
    'llaves bre-v': "*LLAVE*\n3118587974",
    'llave bre-b': "*LLAVE*\n3118587974"
  };

  if (method && paymentDetails[method]) {
    await message.reply(paymentDetails[method]);
    const state = userStates.get(userId);
    userStates.set(userId, typeof state === 'string' ? 'awaiting_payment_confirmation' : { ...state, state: 'awaiting_payment_confirmation' });
  } else {
    // Fallback manual check
    let foundKey = Object.keys(paymentDetails).find(key => text.toLowerCase().includes(key));
    if (foundKey) {
      await message.reply(paymentDetails[foundKey]);
      const state = userStates.get(userId);
      userStates.set(userId, typeof state === 'string' ? 'awaiting_payment_confirmation' : { ...state, state: 'awaiting_payment_confirmation' });
    } else {
      // Usar la IA en vez del mensaje genérico terco (esto responde precios exactos gracias a aiService)
      const { getChatHistoryText } = require('./salesService');
      const historyText = await getChatHistoryText(message);
      await processFallbackWithEscalation(message, userId, false, null, historyText);
    }
  }
}

async function handleAwaitingPaymentConfirmation(message, userId) {
  const body = (message.body || '').toLowerCase().trim();

  // Check if user is trying to switch payment method
  const newMethodCheck = await detectPaymentMethod(message.body);
  console.log(`[DEBUG] Payment switch check for '${message.body}': ${newMethodCheck}`);

  if (newMethodCheck) {
    await message.reply("🤖 Entendido, cambiamos el método de pago.");
    await processPaymentSelection(message, userId, message.body);
    return;
  }

  if (message.hasMedia || body.includes("ya pagu") || body.includes("listo") || body.includes("claro que si") || body.includes("enviado") || body.includes("transferencia") || body.includes("comprobante")) {
    // Si envían imagen o confirman por texto, informamos al grupo y esperamos validación humana
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        const type = message.hasMedia ? "📸 Comprobante" : "✅ Confirmación de pago u observación";
        const contact = await message.getContact();
        const realPhone = contact.number || userId.replace(/\D/g, '');
        await chat.sendMessage(`🚨 ${type} recibido de @${realPhone}. Por favor revisar.\n\nPara validar, responde: *@bot confirmar ${realPhone}* o *si me llegó ${realPhone}*`);
      }
    } catch (error) {
      console.error('Error enviando notificación de pago al grupo:', error);
    }

    if (message.hasMedia) {
      await message.reply("🤖 Hemos recibido tu comprobante. Un asesor validará el pago en un momento para entregarte tus accesos.");
    } else {
      await message.reply("🤖 Hemos recibido tu confirmación. Un asesor validará que el dinero esté en la cuenta para procesar tu pedido.");
    }

    // No registramos todavía. Guardamos el estado para que el admin lo confirme manualmente.
    const existing = userStates.get(userId);
    const newState = typeof existing === 'object' ? { ...existing, state: 'waiting_admin_confirmation' } : { state: 'waiting_admin_confirmation' };
    userStates.set(userId, newState);
  } else {
    // En vez de repetir robóticamente, usamos IA para responder dudas si el usuario pregunta algo
    const { getChatHistoryText } = require('./salesService');
    const historyText = await getChatHistoryText(message);
    await processFallbackWithEscalation(message, userId, false, null, historyText);
  }
}



async function processCheckCredentials(message, userId) {
  try {
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); // Elimina todos los caracteres que no son dígitos

    // Conectar a la API de Azure a través de nuestro apiService (con retries)
    const userAccounts = await getAccountsByPhone(phoneNumber);

    // Generar la respuesta usando IA para un tono humano
    const aiResponse = await generateCredentialsResponse(userAccounts);
    await message.reply(aiResponse);

  } catch (error) {
    console.error('Error al buscar en la base de datos de Azure:', error);
    await message.reply("🤖 Hubo un error al procesar tu solicitud. Por favor, inténtalo de nuevo más tarde.");
  }
  userStates.delete(userId);
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

/* 
// Escáner de Pagos Gmail (DESACTIVADO TEMPORALMENTE - ERROR DE SCOPES)
setInterval(async () => {
    try {
        const newPayments = await checkNewPayments();
        if (newPayments.length === 0) return;

        console.log(`[GMAIL AUTOMATION] Procesando ${newPayments.length} pagos detectados...`);

        for (const payment of newPayments) {
            let matches = [];
            
            // Buscar usuarios en estado de pago con el mismo monto
            for (const [uid, ustate] of userStates.entries()) {
                const isWaiting = ['awaiting_payment_confirmation', 'awaiting_payment_method', 'waiting_human'].includes(ustate.state);
                if (isWaiting && ustate.total && Math.abs(ustate.total - payment.amount) < 10) {
                    matches.push({ id: uid, state: ustate });
                }
            }

            if (matches.length === 1) {
                const target = matches[0];
                console.log(`[GMAIL AUTOMATION] ✅ Coincidencia única hallada para $${payment.amount}: @${target.id}`);
                
                // Confirmación Automática
                const results = await recordNewSale(target.id, target.state, "Bre-B (Auto-detect)");
                
                let userMsg = "🤖 ¡BUENAS NOTICIAS! He detectado tu pago vía *Bre-B* automáticamente. 🎉\n\n";
                let hasFamily = false;

                for (const res of results) {
                    if (res.status === 'success') {
                        userMsg += `- *${res.name}*: Cuenta asignada con éxito. ✅\n`;
                    } else if (res.status === 'manual_invitation_required') {
                        userMsg += `- *${res.name}*: Pago recibido. Un asesor te enviará la invitación manual en un momento. ⚠️\n`;
                        hasFamily = true;
                    } else {
                        userMsg += `- *${res.name}*: Pago recibido, pero nos quedamos sin cupos. Un asesor te dará una solución ahora mismo. ❌\n`;
                    }
                }
                
                await client.sendMessage(target.id, userMsg);
                
                // Notificar al grupo de administración
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        await groupChat.sendMessage(`🤖 [AUTO] Pago detectado de $${payment.amount} para @${target.id.replace('@c.us', '')}.\nVenta procesada automáticamente.`);
                    }
                } catch(e){}

                // Resetear estado del usuario
                userStates.set(target.id, { state: 'main_menu', nombre: target.state.nombre });

            } else if (matches.length > 1) {
                console.warn(`[GMAIL AUTOMATION] ⚠️ Múltiples coincidencias para $${payment.amount}. Notificando admin.`);
                try {
                    const groupChat = await client.getChatById(GROUP_ID);
                    if (groupChat) {
                        const phones = matches.map(m => `@${m.id.replace('@c.us', '')}`).join(', ');
                        await groupChat.sendMessage(`⚠️ [AUTO] He detectado un pago de $${payment.amount} pero tengo ${matches.length} clientes esperando ese valor: ${phones}.\n\nPor favor confirma manualmente.`);
                    }
                } catch(e){}
            } else {
                console.log(`[GMAIL AUTOMATION] ℹ️ Pago de $${payment.amount} detectado pero no coincide con ningún cliente activo.`);
            }
        }
    } catch (err) {
        if (!err.message.includes('insufficient authentication scopes')) {
            console.error('❌ [GMAIL AUTOMATION] Error:', err.message);
        }
    }
}, 2 * 1000 * 60);
*/
