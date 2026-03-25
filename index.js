const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { pool } = require('./database');
const schedule = require('node-schedule');
const { detectPaymentMethod, generateCredentialsResponse } = require('./aiService');
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


// Crear servidor HTTP
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hola, mundo!\n');
});
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
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
    ]
  },
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  markOnlineAvailable: false,
  takeoverOnConflict: true, // Intenta retomar la sesión si hay conflicto
  takeoverTimeoutMs: 10000
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

client.on('message', async (message) => {
  // Ignorar mensajes antiguos (los que se enviaron antes de que el bot arrancara)
  // Esto evita que responda a todos los no leídos de golpe.
  if (message.timestamp < BOT_START_TIME) {
    // console.log('[DEBUG] Ignorando mensaje antiguo de:', message.from);
    return;
  }

  // Ignorar si el mensaje fue enviado por el propio bot (para evitar bucles)
  if (message.fromMe) {
    return;
  }

  // Ignorar mensajes de grupos y estados
  if (message.from.includes('@g.us')) {
      // Interceptar comandos en el grupo personal
      if (message.from === GROUP_ID && message.body && message.body.toLowerCase().startsWith('@bot')) {
          const command = message.body.toLowerCase().replace('@bot', '').trim();
          if (command === 'duermete') {
              globalBotSleep = true;
              await message.reply('😴 Modo dormido activado. No responderé a los clientes automáticamente hasta que me despiertes con *@bot despiertate*.');
              return;
          } else if (command === 'despiertate') {
              globalBotSleep = false;
              await message.reply('😃 ¡He despertado! Vuelvo a atender a los clientes.');
              return;
          } else if (command === 'funciones' || command === 'ayuda') {
              await message.reply('🤖 *Mis funciones internas:*\n\n' +
                '1. *Flujo de Ventas*: Atiendo a clientes, detecto intención de compra, calculo precios y ofrezco medios de pago mediante IA.\n' +
                '2. *Consulta de Credenciales*: Busco en la base de datos a través de la API externa para entregar accesos a los clientes.\n' +
                '3. *Cobranza Automática*: Genero notificaciones masivas de cobros al enviarme lista de deudores.\n' +
                '4. *Modo Humano*: El comando `liberar <numero>` por parte de un operador desactiva la atención automática a un usuario.\n' +
                '5. *Dormir/Despertar*: Con los comandos `@bot duermete` y `@bot despiertate` en este grupo puedo pausar/reanudar mis respuestas a todos los usuarios.'
              );
              return;
          }
      }
      return; // Ignorar otros mensajes en grupos
  }
  
  if (message.from.includes('status@broadcast')) {
    return;
  }

  // Ignorar si el bot está dormido globalmente
  if (globalBotSleep && message.from !== OPERATOR_NUMBER) {
      console.log(`[DEBUG] Bot en modo dormido. Ignorando mensaje de: ${message.from}`);
      return;
  }

  if (message.from.includes('@lid')) {
    return; // Ignorar identificadores de WhatsApp nativos si no son números normales
  }

  console.log('[DEBUG] Mensaje recibido de:', message.from, 'Contenido:', message.body);

  const userId = message.from;
  let currentStateData = userStates.get(userId);
  let currentState = currentStateData;

  // Si el estado es un objeto (nuevo formato), extraemos el string 'state' 
  // para que el switch funcione.
  if (currentStateData && typeof currentStateData === 'object') {
    currentState = currentStateData.state;
  }

  // Primero, verifica si el mensaje corresponde al inicio de una suscripción

  // --- Cobros parser: mensaje especial ---
  if (message.body && message.body.toLowerCase().startsWith('@bot porfa haz los cobros para hoy de:')) {
    await handleCobrosParser(message, userId, userStates, pendingConfirmations);
    return;
  }

  // --- Cobros automáticos: mensaje especial ---
  if (message.body && message.body.toLowerCase().trim() === '@bot cobros automáticos') {
    await handleAutoCobros(message, userId, userStates, pendingConfirmations);
    return;
  }

  // Comandos de operador/administrador
  if (message.from === OPERATOR_NUMBER) {
    const body = (message.body || '').trim().toLowerCase();
    
    // Comando para liberar el bot (quitar modo humano)
    if (body.startsWith('!bot') || body.startsWith('!liberar') || body.startsWith('liberar ')) {
      let targetPhone = body.replace('!bot', '').replace('!liberar', '').replace('liberar', '').trim().replace(/\D/g, '');
      
      // Si no especificó número, intentamos usar el del chat actual si es privado
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
    // allow operator to confirm pending charges on behalf of user: confirmar_cobros <phone>
    if (body.toLowerCase().startsWith('confirmar_cobros ')) {
      const phone = body.split(' ')[1].replace(/\D/g, '');
      const targetId = phone + '@c.us';
      // attempt to find pending confirmation saved under that user's id
      // (this is best-effort; usually the requester triggers confirmation)
      if (pendingConfirmations.has(targetId)) {
        const records = pendingConfirmations.get(targetId);
        // save to file and send individual messages
        const fs = require('fs');
        const path = require('path');
        const file = path.join(__dirname, 'pending_charges.json');
        let existing = [];
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
        const timestamp = new Date().toISOString();
        const entry = { requester: targetId, records, timestamp };
        existing.push(entry);
        fs.writeFileSync(file, JSON.stringify(existing, null, 2));
        // send messages to each number
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

  // Clean message body: remove starting/ending quotes if present, trim
  let cleanBody = message.body ? message.body.trim() : "";
  if (cleanBody.startsWith('"') && cleanBody.endsWith('"')) {
    cleanBody = cleanBody.slice(1, -1).trim();
  }

  if (cleanBody.toLowerCase().startsWith("hola, estoy interesado en")) {
    console.log(`[DEBUG] Triggered purchase flow with: "${cleanBody}"`);
    // Mutate body directly to preserve prototypes (message.reply function)
    message.body = cleanBody;
    await handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID);
    return;
  }

  switch (currentState) {
    case undefined:
      userStates.set(userId, 'main_menu');
      await message.reply(
        "🤖 *Hola! Soy el asistente de Sheerit.*\n\n" +
        "Aquí tienes las opciones disponibles:\n" +
        "1 - Comprar cuenta\n" +
        "2 - Revisar credenciales\n" +
        "3 - Pagar mis cuentas\n" +
        "4 - No puedo acceder a mi cuenta\n" +
        "5 - Otro\n\n" +
        "Por favor, responde *SOLO* con el número de la opción que deseas."
      );
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
      // El bot está en modo silencioso por intervención humana.
      // Se puede reactivar si el operador manda 'liberar <numero>' o si el usuario
      // explícitamente pide volver al menú? Por ahora, silencio total.
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
    case 'seleccionar_servicio':
      userStates.delete(userId);
      await message.reply("🤖 ERROR");
      break;
    default:
      let state = currentState;
      userStates.delete(userId);
      await message.reply(`🤖 Estabas en el estado: '${state}'. No comprendo tu selección. Vamos a empezar de nuevo.`);
      break;
  }
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
      userStates.set(userId, 'seleccionar_servicio');
      await message.reply("🤖 Tenemos una guia de articulos que te pueden ayudar a solucionar tu problema,\n\n sheerit.com.co/aiuda ");
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
    // Save last selected method to allow switching
    const state = userStates.get(userId);
    userStates.set(userId, { ...state, state: 'awaiting_payment_confirmation' });
  } else {
    // Fallback manual check
    let foundKey = Object.keys(paymentDetails).find(key => text.toLowerCase().includes(key));
    if (foundKey) {
      await message.reply(paymentDetails[foundKey]);
      const state = userStates.get(userId);
      userStates.set(userId, { ...state, state: 'awaiting_payment_confirmation' });
    } else {
      await message.reply("🤖 No entendí el método de pago. Por favor escribe uno de los siguientes: Nequi, Daviplata, Bancolombia, Banco Caja Social, Llave Bre-B.");
    }
  }
}

async function handleAwaitingPaymentConfirmation(message, userId) {
  // Check if user is trying to switch payment method
  const newMethodCheck = await detectPaymentMethod(message.body);
  console.log(`[DEBUG] Payment switch check for '${message.body}': ${newMethodCheck}`);

  if (newMethodCheck) {
    await message.reply("🤖 Entendido, cambiamos el método de pago.");
    await processPaymentSelection(message, userId, message.body);
    return;
  }

  if (message.hasMedia || body.includes("ya pague") || body.includes("listo") || body.includes("claro que si")) {
    // Si envían imagen o confirman por texto, informamos al grupo y silenciamos bot
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        const type = message.hasMedia ? "📸 Comprobante" : "✅ Confirmación de pago";
        await chat.sendMessage(`🚨 ${type} recibido de @${userId.replace('@c.us', '')}. Por favor revisar.`);
      }
    } catch (error) {
      console.error('Error enviando notificación de pago al grupo:', error);
    }

    if (message.hasMedia) {
      await message.reply("🤖 Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
    } else {
      await message.reply("🤖 Perfecto, estaré atento al comprobante. Si ya lo enviaste, un asesor te responderá pronto.");
    }
    
    userStates.set(userId, 'waiting_human');
  } else {
    await message.reply("🤖 Por favor, envía el comprobante de la transacción.");
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
