const http = require('http');
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


// Crear servidor HTTP
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hola, mundo!\n');
});
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  
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
    console.error('Error al iniciar el servidor:', err);
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

/**
 * Determina si un nombre es incompleto (un solo nombre) o parece ser de negocio.
 */
function isNameIncomplete(name) {
    if (!name) return true;
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return true;
    
    const businessKeywords = ['store', 'shop', 'ventas', 'digital', 'oficial', 'asistente', 'bot', 'vende', 'pagos', 'comprobantes'];
    const lowerName = name.toLowerCase();
    return businessKeywords.some(kw => lowerName.includes(kw));
}

/**
 * Procesa un mensaje entrante siguiendo la lógica de estados del bot.
 * @param {Message} message 
 */
async function processIncomingMessage(message) {
  // El userId siempre debe ser el del CLIENTE, no necesariamente el del remitente
  // Si el mensaje es "mio" (del bot), el cliente es el destinatario (to)
  const userId = message.fromMe ? message.to : message.from;
  let currentStateData = userStates.get(userId);
  let currentState = currentStateData;

  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  // 1. IDENTIDAD Y RESOLUCIÓN DE NÚMERO (LID FIX)
  const contact = await message.getContact();
  const realPhone = contact.number || userId.replace(/\D/g, '');
  
  let foundName = contact.name || contact.pushname;
  if (!foundName) {
      const { searchContactByPhone } = require('./googleContactsService');
      foundName = await searchContactByPhone(userId);
  }

  // Sincronizar con Google Contacts si tenemos un nombre válido
  if (foundName && !isNameIncomplete(foundName)) {
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
      console.log(`[DEBUG] Usuario ${realPhone} (@${userId}) en modo waiting_human. Bot ignorando.`);
      return;
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
          await handleSendBulkCredentials(message, command, client, getAccountsByPhone);
          return;
      }
  }

  let cleanBody = message.body ? message.body.trim() : "";
  if (cleanBody.startsWith('"') && cleanBody.endsWith('"')) {
    cleanBody = cleanBody.slice(1, -1).trim();
  }

  if (cleanBody.toLowerCase().startsWith("hola, estoy interesado en")) {
    message.body = cleanBody;
    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
    return;
  }

  if (message.hasMedia && currentState !== 'awaiting_payment_confirmation' && currentState !== 'waiting_human') {
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

      const hist = await getChatHistoryText(message);
      const detection = await detectInitialIntent(message.body, hist);

      // 3. IDENTIDAD TERCERO: IA revisando historial
      if (!foundName && detection.userName) {
          foundName = detection.userName;
          console.log(`[AI Discovery] Nombre hallado en historial para @${userId.replace('@c.us', '')}: ${foundName}`);
      }

      const nameIncomplete = isNameIncomplete(foundName);

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

      // 5. MANEJO DE INTENCIONES
      if (detection.intent === 'comprar') {
          if (nameIncomplete) {
              const greeting = foundName ? `¡Hola ${foundName}! Veo que te tengo como ${foundName}.` : "¡Hola! Con gusto te ayudo con tu compra.";
              await message.reply(`🤖 ${greeting} Para proceder con tu registro oficial y evitar duplicados, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
              userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'comprar' });
              return;
          }
          userStates.set(userId, { state: 'awaiting_purchase_platforms', nombre: foundName });
          await message.reply(`🤖 ¡Perfecto ${foundName}! Con gusto te ayudo con tu compra.`);
          await startPurchaseProcess(message, userId, userStates);
          return;
      } else if (detection.intent === 'credenciales') {
          if (nameIncomplete) {
              const greeting = foundName ? `¡Hola ${foundName}!` : "¡Hola! Con gusto te ayudo.";
              await message.reply(`🤖 ${greeting} Para buscar tus cuentas de forma segura, ¿me podrías confirmar tu nombre y apellido completo? 😊`);
              userStates.set(userId, { state: 'awaiting_name_for_contact', nextFlow: 'credenciales' });
              return;
          }
          await message.reply(`🤖 Entendido ${foundName}, te ayudaré a revisar tus credenciales de inmediato.`);
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
        await message.reply(`🤖 ¡Hola de nuevo${nameIncomplete ? '' : ', *' + foundName + '*' }! Qué gusto saludarte.\n\nEscoge una opción:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)`);
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
          const contact = await message.getContact();
          const realPhone = contact.number || userId.replace(/\D/g, '');
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
