process.env.TZ = 'America/Bogota'; // Forzamos la zona horaria de Colombia a nivel global

const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// Sobrescribir consola para añadir timestamps con la hora local correcta
const originalLog = console.log;
console.log = function() {
    const now = new Date();
    const timestamp = `[${now.toLocaleString('es-CO')}]`;
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
const { checkNewPayments, findMatchingPayment } = require('./gmailService');

// --- CONSTANTES Y ESTADOS GLOBALES ---
const userStates = new Map();
const pendingConfirmations = new Map();
const GROUP_ID = '120363102144405222@g.us';
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573107946794') + '@c.us';
let globalBotSleep = false;
const messageQueues = new Map(); // Cola para agrupar mensajes por usuario
const BATCH_INTERVAL = 5000; // 5 segundos para agrupar mensajes

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
  executeTestMode
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
           processIncomingMessage([msg]).catch(err => console.error('Error en reactivación por mención:', err));
       }, 1000);
       return;
    }

    // Si el mensaje NO contiene el emoji 🤖 ni @bot, asumimos que fue enviado manualmente.
    if (!msg.body.includes('🤖')) {
      let st = userStates.get(targetId);
      if (typeof st === 'object' && st.state === 'waiting_human') {
          // Ya estaba silenciado, renovamos el temporizador de mute absoluto (30 min extra)
          st.lastHumanInteraction = Date.now();
          userStates.set(targetId, st);
      } else {
          console.log(`[BOT MUTE] Detectada intervención manual para ${targetId}. Silenciando bot por 30 mins.`);
          userStates.set(targetId, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now() });
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
         userStates.set(userId, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now() });
    }
}

// Eliminamos isNameIncomplete anterior para delegar a la IA


/**
 * Procesa un lote de mensajes de un mismo usuario.
 * @param {Message[]} messages 
 */
async function processIncomingMessage(messages) {
  if (!messages || messages.length === 0) return;
  const message = messages[messages.length - 1]; // Usamos el último como referencia para responder
  const isMedia = messages.some(m => m.hasMedia);
  const combinedBody = messages.map(m => m.body || "").filter(b => b !== "").join("\n");
  // 1. IDENTIDAD Y RESOLUCIÓN DE NÚMERO (LID FIX)
  const userId = message.fromMe ? message.to : message.from;
  
  // --- MUTE ABSOLUTO PROVEEDOR ---
  if (userId.includes('3027892534')) {
      return; // El bot no se mete en la conversación con el proveedor
  }

  // --- INTERCEPTOR ESPECIAL ADMINISTRADOR (3133890800) ---
  if (userId.includes('3133890800')) {
      const cleanBody = (message.body || "").trim().toLowerCase();
      
      // Si no es un comando directo de @bot, ofrecer sugerencias inteligentes
      if (!cleanBody.startsWith("@bot") && !message.fromMe && !message.hasMedia) {
          console.log(`[Admin Proactivo] Detectado mensaje de admin: ${cleanBody}`);
          await handleAdminSuggestions(message);
          // Podemos elegir si retornar aquí o dejar que procese otros comandos
          if (cleanBody === 'pruebas') {
              await executeTestMode(message, client);
              return;
          }
      }
  }
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
  } catch (err) {}

  // Sincronizar con Google Contacts si tenemos un nombre válido
  if (!message.fromMe && foundName && !realPhone.includes('3133890800')) {
      const { addNewContact } = require('./googleContactsService');
      // addNewContact ya tiene validación interna y caché local para evitar duplicados
      await addNewContact(foundName, realPhone);
  }

  // --- IDENTIFICADOR DE ESTADO INICIAL ---
  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  if (currentState === 'waiting_human') {
      // Reactivación rápida
      const cleanInput = (message.body || '').trim().toLowerCase();
      if (cleanInput === 'menu' || cleanInput === 'menú' || cleanInput.includes('@bot')) {
          console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} por intención explícita: ${cleanInput}`);
          userStates.delete(userId);
          currentState = undefined;

      } else {
          let sData = typeof currentStateData === 'object' ? currentStateData : { state: 'waiting_human', lastHumanInteraction: 0 };
          const lastHumanMsg = sData.lastHumanInteraction || 0;
          const timeSinceLastHuman = Date.now() - lastHumanMsg;
          
          // Si el asesor (humano) envió un mensaje en la última hora, asumimos que
          // están en una conversación activa. El bot guarda SILENCIO ABSOLUTO.
          if (timeSinceLastHuman < 1000 * 60 * 60 * 1) {
              console.log(`[DEBUG] Mute activo para @${userId.replace('@c.us', '')} - Conversación humana reciente.`);
              return;
          }

          // Si pasó más de media hora sin que el admin responda, el bot usará la IA 
          // SOLAMENTE para capturar si el cliente está enviando un comprobante de pago o quiere comprar algo nuevo.
          // Si es soporte o charla, seguirá en silencio sin molestar.
          let mediaData = null;
          if (message.hasMedia) {
              try {
                  const media = await message.downloadMedia();
                  if (media && media.data && media.mimetype) {
                      mediaData = { data: media.data, mimeType: media.mimetype.split(';')[0] };
                  }
              } catch (e) {}
          }

          const { detectInitialIntent } = require('./aiService');
          const hist = await getChatHistoryText(message, 6); // Historial más largo para capturar contexto humano
          const detection = await detectInitialIntent(message.body, hist, mediaData);
          
          if (["comprar", "pagar"].includes(detection.intent)) {
              console.log(`[DEBUG] Reactivando bot desde waiting_human para @${userId} por detección de IA: ${detection.intent}`);
              userStates.delete(userId);
              currentState = undefined;
              // Continúa el flujo para vender/procesar pago
          } else {
              // Silencio absoluto, ya no enviamos sondeos como "seguimos con alta demanda".
              return;
          }
      }
  }

  console.log('[DEBUG] Procesando mensaje de:', userId, 'Contenido:', message.body);


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
  const adminState = realPhone.includes('3133890800') ? userStates.get(userId) : null;
  const isAwaitingAdminConfirm = adminState && adminState.state === 'awaiting_admin_broadcast_confirmation';
  const isAwaitingAdminSuggestion = adminState && adminState.state === 'awaiting_admin_suggestion_selection';
  
  // Permitimos consultas en grupos si empiezan con @bot y vienen del admin, 
  // O si el admin está en medio de una confirmación o selección (sin necesidad de @bot)
  if (realPhone.includes('3133890800') && message.body && (message.body.toLowerCase().startsWith('@bot ') || isAwaitingAdminConfirm || isAwaitingAdminSuggestion)) {
      // Resolución de texto de consulta
      let queryText = message.body.toLowerCase().startsWith('@bot ') ? message.body.substring(5).trim() : message.body.trim();
      const isAffirmative = ['si', 'sí', 'dale', 'ok', 'yes', 'proceder', 'confirmar'].includes(queryText.toLowerCase());

      if (queryText.length > 0) {
          const { processAdminQuery } = require('./adminQueries');
          
          // --- CASO 1: Respuesta afirmativa ("si", "dale") ---
          if (isAffirmative && (isAwaitingAdminConfirm || isAwaitingAdminSuggestion)) {
              if (isAwaitingAdminSuggestion) {
                  // Si hay una sola opción, la tomamos. Si hay varias, "si" es ambiguo (dejamos que falle o pida clarificación)
                  if (adminState.payload && adminState.payload.options && adminState.payload.options.length === 1) {
                      const selectedPlatform = adminState.payload.options[0];
                      const { fetchRawData } = require('./apiService');
                      const rawData = await fetchRawData();
                      const resultDirect = await processAdminQuery(message, selectedPlatform, userStates, client, adminState.originalFilters, rawData);
                      if (resultDirect && resultDirect.filteredData) await handleAdminResultLogic(resultDirect.filteredData, userId, userStates, message, isAwaitingAdminConfirm, adminState);
                      return;
                  }
              }
              // Si es para confirmar broadcast (o si el flujo de arriba cayó aquí), procesamos como confirmación
              const result = await processAdminQuery(message, queryText, userStates, client);
              if (result && result.filteredData) await handleAdminResultLogic(result.filteredData, userId, userStates, message, isAwaitingAdminConfirm, adminState);
              return;
          }

          // --- CASO 2: Selección directa de plataforma en estado de sugerencia ---
          if (isAwaitingAdminSuggestion && !isAffirmative && !message.body.toLowerCase().startsWith('@bot ')) {
              const { fetchRawData } = require('./apiService');
              const rawData = await fetchRawData();
              const resultDirect = await processAdminQuery(message, queryText, userStates, client, adminState.originalFilters, rawData);
              if (resultDirect && resultDirect.filteredData) await handleAdminResultLogic(resultDirect.filteredData, userId, userStates, message, isAwaitingAdminConfirm, adminState);
              return;
          }

          // --- CASO 3: Consulta general ---
          const result = await processAdminQuery(message, queryText, userStates, client);
          if (result && result.filteredData) {
              await handleAdminResultLogic(result.filteredData, userId, userStates, message, isAwaitingAdminConfirm, adminState);
          }
          return;
      }
  }

  /**
   * Procesa el resultado de un comando administrativo (Dashboard)
   */
  async function handleAdminResultLogic(data, userId, userStates, message, isAwaitingAdminConfirm, adminState) {
      console.log(`[Admin Dashboard DEBUG] handleAdminResultLogic: status=${data.status}, isAwaitingConfirm=${!!isAwaitingAdminConfirm}, hasState=${!!adminState}, state=${adminState ? adminState.state : 'none'}`);
      
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
              try {
                  await client.sendMessage(userId, `🚀 *Iniciando envío masivo...* (${payload.count} destinatarios)`);
              } catch(e) { console.error('Error enviando mensaje inicio masivo:', e.message); }
              
              let exitosos = 0;
              for (const r of payload.recipients) {
                  const telRaw = (r.tel || '').toString().replace(/\D/g, '');
                  const targetUser = `57${telRaw.startsWith('57') ? telRaw.substring(2) : telRaw}@c.us`;

                  // Lógica selectiva de campos
                  const only = payload.only_fields || []; 
                  const showAll = only.length === 0;
                  
                  const isClave = r.is_owner || showAll || only.includes('clave') || only.includes('password') || only.includes('contraseña');
                  const isPinPerfil = !r.is_owner && (showAll || only.includes('pin perfil') || (only.includes('pin') && only.includes('perfil')));
                  const isPinOnly = !isPinPerfil && !r.is_owner && only.includes('pin');
                  const isPerfilOnly = !isPinPerfil && !r.is_owner && only.includes('perfil');


                  const pinPerfilLine = (r.pin_perfil && isPinPerfil) ? `\n📍 *Pin Perfil:* ${r.pin_perfil}` : "";
                  const pinLine = (r.pin_perfil && isPinOnly) ? `\n📌 *Pin:* ${r.pin_perfil}` : "";
                  const perfilLine = (r.pin_perfil && isPerfilOnly) ? `\n👤 *Perfil:* ${r.pin_perfil}` : "";
                  const claveLine = isClave ? `\n🔑 *Clave:* ${payload.new_password}` : "";

                  let title = "ACTUALIZACIÓN DE CREDENCIALES";
                  if (!showAll && only.length === 1) {
                      if (isPinPerfil) title = "ACTUALIZACIÓN DE PIN PERFIL";
                      if (isClave) title = "ACTUALIZACIÓN DE CLAVE";
                  }

                  let msg = payload.custom_message 
                    ? `🚨 *NOTIFICACIÓN DE SHEERIT*\n\n${payload.custom_message}\n\n📧 *Cuenta:* ${payload.target_account}${claveLine}${pinPerfilLine}${pinLine}${perfilLine}`
                    : `🚨 *${title}*\n\nHola 👋, te contactamos de Sheerit para informarte que los datos de acceso de tu cuenta de *${payload.platform}* han sido actualizados.\n\n📧 *Cuenta:* ${payload.target_account}${claveLine}${pinPerfilLine}${pinLine}${perfilLine}\n\nSi tienes inconvenientes, acude a nuestro soporte o escribe "ayuda". ¡Gracias por confiar en nosotros!`;
                  try {
                      await client.sendMessage(targetUser, msg);
                      exitosos++;
                      await new Promise(res => setTimeout(res, 500));
                  } catch(e) { console.error(`[Admin Broadcast] Error enviando a ${targetUser}:`, e.message); }
              }
              try {
                  await client.sendMessage(userId, `✅ *Envío completado exitosamente.*\n- Total: ${payload.count}\n- Enviados: ${exitosos}`);
              } catch(e) { console.error('Error enviando mensaje completado:', e.message); }
              userStates.delete(userId);
          } else {
              try {
                  await client.sendMessage(userId, "❌ No tengo ninguna acción pendiente para confirmar.");
              } catch(e) { console.error('Error respondiendo acción pendiente:', e.message); }
          }
      } else if (data.status === 'error') {
          try {
              await client.sendMessage(userId, `❌ ${data.message || 'Error procesando la consulta'}`);
          } catch(e) { console.error('Error respondiendo error:', e.message); }
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

  let cleanBody = combinedBody;
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

  if (isMedia) {
    // --- MANEJO DE MULTIMEDIA (LOTE) ---
    const history = await getChatHistoryText(message);
    let mediaData = []; // Ahora es un arreglo para soportar múltiples imágenes
    
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
    } catch(err) {
      console.error("Error descargando multimedia del lote:", err.message);
    }

    // --- INTERCEPTOR GLOBAL DE PAGOS ---
    if (mediaData.length > 0) {
      // Tomamos la primera imagen para el interceptor de pagos (normalmente el usuario manda el recibo solo)
      const check = await isPaymentReceipt(mediaData[0], history);
      if (check.isReceipt) {
          console.log(`[PAYMENT INTERCEPTOR] ✅ Comprobante detectado (${check.bank || 'Banco'}) para @${userId}`);
          
          const existing = userStates.get(userId);
          const stateData = typeof existing === 'object' ? { ...existing } : { nombre: foundName };
          
          // --- NUEVO: VALIDACIÓN AUTOMÁTICA GMAIL ---
          if (check.amount && check.amount > 0) {
              const match = await findMatchingPayment(check.amount, 60); // Ventana de 60 min
              if (match) {
                  console.log(`[PAYMENT AUTO-VALIDATE] ✅ Match encontrado en Gmail para @${userId} ($${check.amount})`);
                  
                  // Ejecutar validación automática
                  const validationResult = await executePaymentValidation(userId, { ...stateData, paymentMethod: `Gmail Match (${check.bank || 'Bre-B'})` }, client, userStates, null);
                  
                  if (validationResult.success) {
                      // Notificar al grupo administrativo del éxito automático
                      try {
                          const groupChat = await client.getChatById(GROUP_ID);
                          if (groupChat) {
                              await groupChat.sendMessage(`✅ *PAGO AUTO-VALIDADO* (@${userId.replace('@c.us', '')})\n` +
                                             `Monto: $${check.amount}\n` +
                                             `Banco: ${check.bank || 'Bre-B'}\n` +
                                             `ID Gmail: ${match.id}\n\n` +
                                             `El bot ya entregó el servicio automáticamente.`);
                          }
                      } catch(e) {}
                      return;
                  }
              }
          }

          // Si no hubo match automático, seguimos con el flujo manual
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

    await processFallbackWithEscalation(message, userId, isMedia, mediaData.length > 0 ? mediaData : null, history);
    return;
  }

  // Si no hay media, o no fue interceptado como pago, evaluamos el texto combinado
  const inputToUse = combinedBody || message.body || "";

  switch (currentState) {
    case undefined:
      const cleanInput = inputToUse.trim();
      if (['1', '2', '3', '4', '5'].includes(cleanInput)) {
         userStates.set(userId, { state: 'main_menu' });
         await handleMainMenuSelection(message, userId);
         return;
      }

      const hist = await getChatHistoryText(message, 25);
      const detection = await detectInitialIntent(inputToUse, hist);

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
      if ((frustration >= 7 || unreads >= 10) && !solvableIntents.includes(detection.intent)) {
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
      if (detection.intent === 'cancelar') {
          console.log(`[Cierre] Intent 'cancelar' detectado para ${userId}. Enviando despedida de churn.`);
          await message.reply("🤖 Oh, entiendo perfectamente. Lamento mucho que hoy no podamos continuar con tu servicio. 😔\n\nEn Sheerit siempre buscamos mejorar: ¿podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho a ser mejores. ¡Igual aquí tienes tu casa para cuando decidas volver! 👋");
          userStates.delete(userId);
          return;
      }
      
      if (detection.intent === 'cierre') {
          console.log(`[Cierre] Intent 'cierre' detectado para ${userId}. Fin de charla natural.`);
          // Si el usuario simplemente dice gracias, listo, ok, no necesitamos contestar ni asustarlo con la cancelación.
          return;
      }
      
       if (detection.intent === 'comprar') {
           // Priorizamos la venta: Si ya tenemos algún nombre (venga de contactos o de la IA), seguimos adelante.
           if (!foundName) {
               await message.reply(`🤖 ¡Hola! Con gusto te ayudo con tu compra. ¿Me podrías regalar tu nombre y apellido completo para registrarte oficialmente? 😊`);
               userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'comprar' });
               return;
           }

           // OPTIMIZACIÓN: Si el usuario ya especificó qué quiere desde el saludo (ej. "Hola, Netflix")
           // Saltamos el menú de selección de plataformas y vamos directo a la cotización detallada.
           if (detection.detectedPlatform) {
               console.log(`[Flow Optimization] Saltando menú de plataformas para @${userId}. Plataforma detectada: ${detection.detectedPlatform}`);
               userStates.set(userId, { state: 'awaiting_purchase_platforms', nombre: foundName });
               await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
               return;
           }

           // Flujo estándar con menú
           userStates.set(userId, { state: 'awaiting_purchase_platforms', nombre: foundName });
           await message.reply(`🤖 ¡Perfecto ${foundName}! Con gusto te ayudo con tu compra.`);
           await startPurchaseProcess(message, userId, userStates);
           return;
       } else if (detection.intent === 'credenciales') {
          if (!foundName) {
              await message.reply(`🤖 ¡Hola! Con gusto te ayudo. Para buscar tus cuentas de forma segura, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
              userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'credenciales' });
              return;
          }
          await message.reply(`🤖 Entendido ${foundName}, te ayudaré a revisar tus credenciales de inmediato.`);
          await processCheckCredentials(message, userId);
          return;
      } else if (detection.intent === 'pagar') {
          await processCheckPrices(message, userId, userStates, detection.detectedPlatform);
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
          // addNewContact ya tiene validación interna y caché local
          await addNewContact(name, userId.replace('@c.us', ''));
      } catch(e) {}
      userStates.set(userId, { state: 'main_menu', nombre: name });
      await message.reply("🤖 ¡Un placer conocerte, *" + name + "*! Ya quedaste agendado. Ahora sí, ¿en qué te puedo ayudar hoy?\n\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)");
      break;
    default:
      const historyText = await getChatHistoryText(message);
      await processFallbackWithEscalation(message, userId, isMedia, mediaData.length > 0 ? mediaData : null, historyText);
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
                   userStates.set(message.from, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now() });
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

  if (message.from.includes('status@broadcast') || message.from.includes('@lid')) return;
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
          await message.reply("🤖 *Soporte Técnico Sheerit*\n\nPor favor describe tu problema detalladamente o envíame una captura de pantalla del error que estás experimentando. Te guiaré paso a paso para solucionarlo.\n\n⚠️ *Nota:* Nuestra atención es **exclusivamente por chat**, no atendemos llamadas.\n\nSi el problema es complejo, escribe *5* en cualquier momento para hablar con un asesor humano.");

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
      await message.reply("🤖 Un asesor te atenderá lo más pronto posible. He silenciado mis respuestas automáticas de charla general para que puedas hablar con un humano, pero si necesitas revisar tus cuentas o comprar algo, ¡puedes seguir usando el menú!");
      userStates.set(userId, { state: 'waiting_human', waitingCount: 0 }); // No seteamos lastHumanInteraction para que no sea un mute absoluto
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
              userStates.set(userId, { state: 'waiting_human', waitingCount: 0, lastHumanInteraction: Date.now() });
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
    'transfiya': "*LLAVE*\n3118587974",
    'llaves bre-v': "*LLAVE*\n3118587974",
    'llave bre-b': "*LLAVE*\n3118587974"
  };
  
  const lowerText = text.toLowerCase();
  const isQrRequest = lowerText.includes('qr') || lowerText.includes('código') || lowerText.includes('codigo');

  if (isQrRequest) {
    const { MessageMedia } = require('whatsapp-web.js');
    const qrPath = path.join(__dirname, 'uploads', 'qr_pago.jpg');
    if (fs.existsSync(qrPath)) {
        try {
            const media = MessageMedia.fromFilePath(qrPath);
            await message.reply(media, undefined, { caption: "🤖 Aquí tienes nuestro *QR de Negocios* oficial para realizar tu pago fácilmente. 😊" });
        } catch(e) {
            console.error("Error enviando QR:", e.message);
            await message.reply("🤖 No pude enviar la imagen del QR en este momento, pero puedes usar los datos de texto abajo.");
        }
    } else {
        await message.reply("🤖 Aún no tengo configurada la imagen del QR oficial, pero puedes usar estos datos para transferir:");
    }
  }

  if (method && paymentDetails[method]) {
    await message.reply(paymentDetails[method]);
    const state = userStates.get(userId);
    userStates.set(userId, typeof state === 'string' ? { state: 'awaiting_payment_confirmation' } : { ...state, state: 'awaiting_payment_confirmation' });
  } else {
    // Fallback manual check
    let foundKey = Object.keys(paymentDetails).find(key => text.toLowerCase().includes(key));
    if (foundKey) {
      await message.reply(paymentDetails[foundKey]);
      const state = userStates.get(userId);
      userStates.set(userId, typeof state === 'string' ? { state: 'awaiting_payment_confirmation' } : { ...state, state: 'awaiting_payment_confirmation' });
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
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); 
    let userAccounts = await getAccountsByPhone(phoneNumber);

    // BÚSQUEDA CRUZADA: Si no hay por teléfono, buscamos por nombre
    if (userAccounts.length === 0) {
        const state = userStates.get(userId);
        const nameToSearch = state ? state.nombre : null;
        
        if (nameToSearch) {
            console.log(`[Cross-Lookup] Buscando cuentas por nombre para "${nameToSearch}"...`);
            const { fetchCustomersData } = require('./apiService');
            const allClients = await fetchCustomersData();
            userAccounts = allClients.filter(c => {
               const normalizedExcelName = (c.Nombre || "").toLowerCase().trim();
               const normalizedSearchName = nameToSearch.toLowerCase().trim();
               return normalizedExcelName.includes(normalizedSearchName) || normalizedSearchName.includes(normalizedExcelName);
            });

            if (userAccounts.length > 0) {
               const targetNum = userAccounts[0].numero || "otro número";
               await message.reply(`🤖 No encontré servicios vinculados a este número, pero veo que tienes cuentas registradas bajo el nombre de *${userAccounts[0].Nombre}* (asociadas al número ${targetNum}). Aquí tienes el detalle:`);
            }
        }
    }

    if (userAccounts.length === 0) {
        await message.reply("🤖 No encontré servicios activos vinculados a este número ni al nombre que tengo registrado. Si compraste desde otro número, por favor dímelo para ayudarte a buscar.");
        userStates.delete(userId);
        return;
    }

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
