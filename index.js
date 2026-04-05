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
const { pool } = require('./database');
const schedule = require('node-schedule');
const { detectPaymentMethod, generateCredentialsResponse, generateEmpatheticFallback, detectInitialIntent } = require('./aiService');
const { getAccountsByPhone } = require('./apiService');
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
const { handleBatchUnanswered, showAdminFunctions } = require('./adminService');
const { searchContactByPhone, addNewContact } = require('./googleContactsService');


// Crear servidor HTTP
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hola, mundo!\n');
});
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
  
  // Heartbeat cada 30 minutos
  setInterval(() => {
    const state = client ? client.getState() : 'UNINITIALIZED';
    console.log(`💓 Heartbeat: Proceso vivo. Estado del cliente: ${state}`);
  }, 30 * 60 * 1000);
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
  console.log('Conexión establecida correctamente');
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

// Map para manejar el estado de los usuarios
//Se usa la libreria llamada "node-schedule", cualquier duda o cambio, REVISAR LA DOCUMENTACION <3
// https://www.npmjs.com/package/node-schedule 
//se tiene que llamar la funcion de database y scheduledTask
const userStates = new Map();
let globalBotSleep = false;

// Manejar mensajes entrantes
// Admin/operator number to notify when a human intervention is required
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573107946794') + '@c.us';

// Group ID for reporting cases
const GROUP_ID = '120363102144405222@g.us';

// Storage for temporary confirmations (e.g., pending cobros)
const pendingConfirmations = new Map();

client.on('message_create', async (msg) => {
  // Ignorar si el mensaje es antiguo
  if (msg.timestamp < BOT_START_TIME) return;

  // DETECTAR INTERVENCIÓN HUMANA: Si el mensaje lo envío yo manualmente
  // a un chat que NO es un grupo y NO tiene el emoji del bot.
  if (msg.fromMe && !msg.to.includes('@g.us') && !msg.to.includes('@broadcast')) {
    const targetId = msg.to;
    
    // Comando directo en el chat para reactivar el bot
    if (msg.body.trim().toLowerCase() === '@bot') {
       userStates.delete(targetId);
       console.log(`[BOT UNMUTE] Reactivado manualmente en el chat ${targetId}.`);
       await client.sendMessage(targetId, '🤖 *HOLA DE NUEVO*: Un asesor me ha pedido retomar la atención automática. ¿En qué te puedo ayudar?');
       return;
    }

    // Si el mensaje NO contiene el emoji 🤖, asumimos que fue enviado manualmente.
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
               await chat.sendMessage(`🚨 *ESCALAMIENTO IA SOPORTE* de @${phoneNumber}\n\n${fallbackResult.escalationSummary || 'Revisión manual requerida.'}`);
            }
         } catch(e) { console.error('Error enviando escalamiento:', e); }
         userStates.set(userId, 'waiting_human');
    }
}


/**
 * Procesa un mensaje entrante siguiendo la lógica de estados del bot.
 * @param {Message} message 
 */
async function processIncomingMessage(message) {
  const userId = message.from;
  let currentStateData = userStates.get(userId);
  let currentState = currentStateData;

  // Importar utilidades necesarias
  const { getChatHistoryText } = require('./salesService');

  console.log('[DEBUG] Procesando mensaje de:', userId, 'Contenido:', message.body);

  // VERIFICAR SI EL NÚMERO ESTÁ GUARDADO (SOLO CHATS DIRECTOS Y NO BOTS)
  if (!message.fromMe && !message.from.includes('@g.us') && !message.from.includes('status@broadcast')) {
      try {
          const contact = await message.getContact();
          if (!contact.isMyContact && !contact.name && currentState !== 'awaiting_name_for_contact' && currentState !== 'waiting_human') {
              userStates.set(userId, 'awaiting_name_for_contact');
              await message.reply("🤖 ¡Hola! Bienvenido a Sheerit. Veo que aún no nos conocemos, ¿me regalas tu nombre y apellido para guardarte en mis contactos antes de empezar? (Escribe tu nombre abajo)");
              return;
          }
      } catch (err) {
          console.error('[DEBUG] Error validando estado de contacto:', err);
      }
  }

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
  if (message.from === GROUP_ID && message.body && message.body.toLowerCase().startsWith('@bot')) {
      const bodyLower = message.body.toLowerCase();
      const command = bodyLower.replace('@bot', '').trim();

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
      } else if (command === '' || command === 'funciones' || command === 'ayuda') {
          await showAdminFunctions(message);
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
      
      if (detection.intent === 'comprar') {
        userStates.set(userId, { state: 'awaiting_purchase_platforms' });
        await message.reply("🤖 ¡Hola! Claro que sí, con gusto te ayudo con tu compra.");
        await startPurchaseProcess(message, userId, userStates);
        return;
      } else if (detection.intent === 'credenciales') {
        await message.reply("🤖 Entendido, te ayudaré a revisar tus credenciales de inmediato.");
        await processCheckCredentials(message, userId);
        return;
      } else if (detection.intent === 'pagar') {
        await message.reply("🤖 ¡Claro! Vamos a revisar tus cuentas para el pago.");
        await processCheckPrices(message, userId, userStates);
        return;
      }

      // Si no detectamos intención clara, buscamos contacto antes de preguntar nombre
      const foundName = await searchContactByPhone(userId);
      if (foundName) {
        console.log(`[Silent Detection] Usuario ${userId} identificado como: ${foundName}`);
        userStates.set(userId, { state: 'main_menu', nombre: foundName });
        await message.reply(`🤖 ¡Hola de nuevo, *${foundName}*! Qué gusto saludarte.\n\nEscoge una opción:\n1 - Comprar cuenta nueva\n2 - Revisar mis credenciales\n3 - Pagar o renovar mis cuentas\n4 - Soporte Técnico\n5 - Hablar con un asesor (Otro)`);
      } else {
        await message.reply("🤖 ¡Hola! Soy el asistente virtual de *Sheerit*. No te tengo agendado aún. ¿Me podrías decir tu nombre y apellido para saludarte correctamente? 😊");
        userStates.set(userId, 'awaiting_name_for_contact');
      }
      break;
    case 'main_menu':
      await handleMainMenuSelection(message, userId);
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
          await chat.sendMessage(`🚨 Nuevo caso para atención: Usuario ${userId.replace('@c.us', '')} seleccionó "Otro" y necesita ayuda de un asesor.`);
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
      await message.reply("🤖 Por favor, selecciona una opción válida del menú.");
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
    // Si envían imagen o confirman por texto, informamos al grupo y silenciamos bot
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        const type = message.hasMedia ? "📸 Comprobante" : "✅ Confirmación de pago u observación";
        await chat.sendMessage(`🚨 ${type} recibido de @${userId.replace('@c.us', '')}. Por favor revisar.`);
      }
    } catch (error) {
      console.error('Error enviando notificación de pago al grupo:', error);
    }

    if (message.hasMedia) {
      await message.reply("🤖 Hemos recibido tu comprobante. Una persona validará el pago en un momento para pasarte tus accesos.");
    } else {
      await message.reply("🤖 Estaré atento. Si ya lo enviaste, un humano te responderá pronto para entregarte tu cuenta.");
    }

    // Registrar venta en Excel (Automation)
    const userState = userStates.get(userId);
    if (userState && typeof userState === 'object') {
       // Intentamos detectar el método de pago del mensaje actual o previo si no está en el objeto
       const paymentMethod = await detectPaymentMethod(message.body) || userState.paymentMethod || "Confirmado por usuario";
       // No bloqueamos el flujo principal si el registro falla (async sin await para velocidad o con catch)
       recordNewSale(userId, userState, paymentMethod).catch(e => console.error("Error silencioso en registro de venta:", e.message));
    }
    
    userStates.set(userId, 'waiting_human');
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
