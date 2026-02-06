const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { pool } = require('./database');
const schedule = require('node-schedule');
const { parsePurchaseIntent, detectPaymentMethod } = require('./aiService');

// Crear servidor HTTP
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hola, mundo!\n');
});
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});

// Nota: usamos `./database.js` que expone `pool` (mysql2/promise pool)

// Configuración del cliente de WhatsApp
// Detectamos si estamos en Mac (darwin)
const isMac = process.platform === 'darwin';

const client = new Client({
  puppeteer: {
    // executablePath: isMac ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    // Comentamos la ruta local para forzar el uso del Chromium que descarga Puppeteer automáticamente
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  // Deshabilitar la marca automática de mensajes como vistos para evitar error de markedUnread
  markOnlineAvailable: false
});

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

// Manejar mensajes entrantes
// Admin/operator number to notify when a human intervention is required
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573107946794') + '@c.us';

// Group ID for reporting cases
const GROUP_ID = '120363102144405222@g.us';

// Storage for temporary confirmations (e.g., pending cobros)
const pendingConfirmations = new Map();

client.on('message_create', (msg) => {
  // message_create logs ALL messages, including those sent by the bot.
  // If this fires but 'message' doesn't, we know the connection works but the filter is strict.
  console.log('[DEBUG] Evento message_create disparado. De:', msg.from, 'Body:', msg.body);
});

client.on('change_state', state => {
  console.log('CAMBIO DE ESTADO:', state);
});

// URL para obtener plataformas
const PLATFORMS_URL = 'https://sheerit.com.co/data/platforms.json';

// Función para obtener plataformas
async function getPlatforms() {
  try {
    const response = await fetch(PLATFORMS_URL);
    if (!response.ok) throw new Error('Failed to fetch platforms');
    return await response.json();
  } catch (error) {
    console.error('Error fetching platforms:', error);
    return [];
  }
}

client.on('message', async (message) => {
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
    // Parse incoming list lines
    const payload = message.body.split(':')[1] || '';
    const lines = payload.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const records = [];
    for (let line of lines) {
      // Normalize tabs and multiple spaces, split by comma
      line = line.replace(/\t/g, ' ');
      const parts = line.split(',');
      const name = (parts[0] || '').trim();
      const rest = (parts.slice(1).join(',') || '').trim();
      // extract digits
      const digits = (rest.match(/\d+/g) || []).join('');
      if (name && digits) {
        // Ensure country code exists; if starts with '57' keep it, otherwise try to add 57
        let phone = digits;
        if (!phone.startsWith('57')) {
          // If number length is 10 (typical mobile) add 57
          if (phone.length === 10) phone = '57' + phone;
        }
        records.push({ name, phone });
      }
    }

    if (records.length === 0) {
      await message.reply('No pude parsear las líneas. Verifica el formato y vuelve a intentarlo.');
      return;
    }

    const names = records.map(r => r.name);
    const summary = records.length > 1
      ? `Al día de hoy tienes vencidas las cuentas de ${names.join(', ')}. ¿Deseas renovar?`
      : `Al día de hoy tienes vencida la cuenta de ${names[0]}. ¿Deseas renovar?`;

    // Save pending confirmation
    pendingConfirmations.set(userId, records);
    userStates.set(userId, 'awaiting_cobros_confirmation');
    await message.reply(`Recibí los siguientes cargos (tal cual los enviaste):\n\n${lines.join('\n')}\n\n${summary}\nResponde *SI* para confirmar o *NO* para cancelar.`);
    return;
  }

  // Admin/operator commands: liberar <phone>
  if (message.from === OPERATOR_NUMBER) {
    const body = (message.body || '').trim();
    if (body.toLowerCase().startsWith('liberar ')) {
      const phone = body.split(' ')[1].replace(/\D/g, '');
      const targetId = phone + '@c.us';
      if (userStates.has(targetId)) {
        userStates.delete(targetId);
        await client.sendMessage(targetId, 'Tu caso ha sido retomado por un agente humano. Un asesor te atenderá pronto.');
        await message.reply(`Se liberó la intervención para ${phone}`);
      } else {
        await message.reply(`No hay ninguna sesión en espera para ${phone}`);
      }
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
    await handleSubscriptionInterest(message, userId);
    return;
  }

  switch (currentState) {
    case undefined:
      userStates.set(userId, 'main_menu');
      await message.reply(
        "Aquí tienes las opciones disponibles:\n" +
        "1 - Comprar cuenta\n" +
        "2 - Revisar credenciales\n" +
        "3 - Pagar mis cuentas\n" +
        "4 - No puedo acceder a mi cuenta\n" +
        "5 - Otro\n" +
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
      await handleAwaitingCobrosConfirmation(message, userId);
      break;
    case 'awaiting_payment_confirmation':
      await handleAwaitingPaymentConfirmation(message, userId);
      break;
    case 'awaiting_purchase_platforms':
      await handleAwaitingPurchasePlatforms(message, userId);
      break;
    case 'selecting_plans':
      await handleSelectingPlans(message, userId);
      break;
    case 'adding_platform':
      await handleAddingPlatform(message, userId);
      break;
    case 'seleccionar_servicio':
      userStates.delete(userId);
      await message.reply("ERROR");
      break;
    default:
      let state = currentState;
      userStates.delete(userId);
      await message.reply(`Estabas en el estado: '${state}'. No comprendo tu selección. Vamos a empezar de nuevo.`);
      break;
  }
});

// Funciones de manejo de estados
async function handleMainMenuSelection(message, userId) {
  const userSelection = message.body.trim();
  switch (userSelection) {
    case '1':
      await startPurchaseProcess(message, userId);
      break;
    case '2':
      await processCheckCredentials(message, userId);
      break;
    case '3':
      await processCheckPrices(message, userId);
      break;
    case '4':
      userStates.set(userId, 'seleccionar_servicio');
      await message.reply("Tenemos una guia de articulos que te pueden ayudar a solucionar tu problema,\n\n sheerit.com.co/aiuda ");
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
      await message.reply("Un asesor te atenderá lo más pronto posible.");
      userStates.delete(userId);
      break;
    default:
      await message.reply("Por favor, selecciona una opción válida del menú.");
      break;
  }
}

async function handleSubscriptionInterest(message, userId) {
  const mensaje = message.body;

  // 1. Usar AI para parsear la intención
  const intent = await parsePurchaseIntent(mensaje);
  console.log("[DEBUG] AI Intent Result:", JSON.stringify(intent, null, 2));
  const { items, statedPrice, subscriptionType } = intent;

  if (!items || items.length === 0) {
    await message.reply("No pude entender qué servicios deseas. Por favor, intenta de nuevo especificando el nombre de la plataforma y el plan.");
    return;
  }

  // 2. Obtener plataformas del sistema
  const platforms = await getPlatforms();
  // Validar y mapear items
  let selectedItems = [];
  let invalidElements = [];

  items.forEach(item => {
    // Fuzzy match platform name
    const targetPlatform = item.platform.toLowerCase();
    const platform = platforms.find(p => p.name.toLowerCase().includes(targetPlatform)) ||
      platforms.find(p => targetPlatform.includes(p.name.toLowerCase()));

    if (platform) {
      // Fuzzy match plan name if provided
      let plan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase();
        plan = platform.plans.find(p => p.name.toLowerCase().includes(targetPlan));
      }
      // Default to first plan if not found or not specified (user validation later? or just pick first?)
      // Logic says: if user said "Netflix" without plan, we marked plan as null.
      // If we want to force plan selection, we can keep it null.
      selectedItems.push({ platform, plan, originalItem: item });
    } else {
      invalidElements.push(item.platform);
    }
  });

  if (invalidElements.length > 0) {
    // Si la AI alucinó plataformas que no existen o el usuario pidió algo raro
    await message.reply(`Lo siento, no manejamos las siguientes plataformas: ${invalidElements.join(', ')}.`);
    return;
  }

  // 3. Calcular precio real
  let calculatedTotal = 0;
  let responseText = "Entendido, buscas:\n";

  for (const s of selectedItems) {
    if (s.plan) {
      calculatedTotal += s.plan.price;
      responseText += `- ${s.platform.name} (${s.plan.name}): $${s.plan.price}\n`;
    } else {
      // Si no hay plan, asumimos el más barato o pedimos aclaración?
      // Simplificación: Tomamos el primer plan disponible como referencia
      const defaultPlan = s.platform.plans[0];
      calculatedTotal += defaultPlan.price;
      s.plan = defaultPlan; // Asignamos por defecto para proceder
      responseText += `- ${s.platform.name} (${defaultPlan.name}): $${defaultPlan.price} (Plan Básico asumido)\n`;
    }
  }

  // Descuento por combo
  const numPlatforms = selectedItems.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    calculatedTotal -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  // Ajuste por periodo
  let periodText = "/mes";
  if (subscriptionType === 'anual') {
    calculatedTotal = calculatedTotal * 12 * 0.85;
    periodText = "/año";
  } else if (subscriptionType === 'semestral') {
    calculatedTotal = calculatedTotal * 6 * 0.93;
    periodText = "/semestre";
  }

  calculatedTotal = Math.round(calculatedTotal);
  responseText += `\nTotal calculado: $${calculatedTotal}${periodText}`;

  // 4. Comparar con statedPrice
  // 4. Comparar con statedPrice
  if (statedPrice !== null && Math.abs(statedPrice - calculatedTotal) > 2000) {
    // Discrepancia significativa (> 2000 pesos)
    responseText += `\n\nNoté que mencionaste un precio de $${statedPrice}, pero según mis cálculos el total es $${calculatedTotal}. ¿Deseas continuar con el precio de $${calculatedTotal}?`;
  }

  await message.reply(responseText);

  // Guardar estado para pago
  // IMPORTANTE: Guardamos el calculatedTotal para saber cuánto cobrar
  userStates.set(userId, { state: 'awaiting_payment_method', total: calculatedTotal, items: selectedItems });

  let paymentOptions = "⭐Nequi\n⭐Llaves Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
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
      await message.reply("No entendí el método de pago. Por favor escribe uno de los siguientes: Nequi, Daviplata, Bancolombia, Banco Caja Social, Llave Bre-B.");
    }
  }
}

async function handleAwaitingPaymentConfirmation(message, userId) {
  // Check if user is trying to switch payment method
  const newMethodCheck = await detectPaymentMethod(message.body);
  console.log(`[DEBUG] Payment switch check for '${message.body}': ${newMethodCheck}`);

  if (newMethodCheck) {
    await message.reply("Entendido, cambiamos el método de pago.");
    await processPaymentSelection(message, userId, message.body);
    return;
  }

  if (message.hasMedia) {
    // Si envían imagen, asumimos pago exitoso.
    await message.reply("Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
    userStates.delete(userId);
  } else {
    // Check for text confirmation like "ya pague" using simple regex or AI if critical
    const body = message.body.toLowerCase();
    if (body.includes("ya pague") || body.includes("listo") || body.includes("claro que si")) {
      await message.reply("Perfecto, estaré atento al comprobante. Si ya lo enviaste, un asesor te responderá pronto.");
      userStates.delete(userId); // O mantener en estado 'waiting_for_credential'
    } else {
      await message.reply("Por favor, envía el comprobante de la transacción.");
    }
  }
}

async function handleAwaitingCobrosConfirmation(message, userId) {
  try {
    const body = (message.body || '').trim().toLowerCase();
    if (body === 'si' || body === 'sí') {
      const records = pendingConfirmations.get(userId) || [];
      if (records.length === 0) {
        await message.reply('No hay cobros pendientes para confirmar.');
        userStates.delete(userId);
        return;
      }
      // persist to pending_charges.json
      const fs = require('fs');
      const path = require('path');
      const file = path.join(__dirname, 'pending_charges.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
      const entry = { requester: userId, records, timestamp: new Date().toISOString() };
      existing.push(entry);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2));

      // send individual messages to each phone
      for (const r of records) {
        const dest = r.phone + '@c.us';
        await client.sendMessage(dest, `Se enviará un cobro para *${r.name}* solicitado por ${userId}. Por favor, responde si el pago fue realizado.`);
      }

      await message.reply('He guardado los cobros y he notificado a cada número individualmente.');
      pendingConfirmations.delete(userId);
      userStates.delete(userId);
    } else if (body === 'no') {
      pendingConfirmations.delete(userId);
      userStates.delete(userId);
      await message.reply('Operación cancelada. No se enviaron cobros.');
    } else {
      await message.reply('Por favor responde *SI* para confirmar o *NO* para cancelar.');
    }
  } catch (error) {
    console.error("Error en confirmación de cobros:", error);
    await message.reply("⚠️ Ocurrió un error procesando tu solicitud. Por favor contacta al administrador.");
    // Opcional: Reiniciar estado del usuario para que no se quede trabado
    userStates.delete(userId);
  }
}

async function handleAwaitingPaymentConfirmation(message, userId) {
  if (message.hasMedia) {
    // Si envían imagen, asumimos pago exitoso.
    await message.reply("Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
    userStates.delete(userId);
  } else {
    // Check for text confirmation like "ya pague" using simple regex or AI if critical
    const body = message.body.toLowerCase();
    if (body.includes("ya pague") || body.includes("listo") || body.includes("claro que si")) {
      await message.reply("Perfecto, estaré atento al comprobante. Si ya lo enviaste, un asesor te responderá pronto.");
      userStates.delete(userId); // O mantener en estado 'waiting_for_credential'
    } else {
      await message.reply("Por favor, envía el comprobante de la transacción.");
    }
  }
}

async function processCheckCredentials(message, userId) {
  try {
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); // Elimina todos los caracteres que no son dígitos

    // Consulta SQL con normalización usando el pool
    const [clients] = await pool.query(
      'SELECT clienteID, nombre FROM datos_de_cliente WHERE REPLACE(REPLACE(REPLACE(numero, " ", ""), "-", ""), ".", "") = ?',
      [phoneNumber]
    );
    if (clients.length > 0) {
      let replyMessage = "Estas son tus cuentas actuales:\n";
      for (const client of clients) {
        // Obtener los perfiles y el pin de perfil usando el clienteID.
        const [profiles] = await pool.query('SELECT idCuenta, pinPerfil FROM perfil WHERE clienteID = ?', [client.clienteID]);
        for (const profile of profiles) {
          // Obtener los detalles de la cuenta usando idCuenta.
          const [accounts] = await pool.query(`
            SELECT c.correo, c.clave, c.fechaCuenta, lm.nombre_cuenta
            FROM datosCuenta c
            JOIN lista_maestra lm ON c.id_streaming = lm.id_streaming
            WHERE c.idCuenta = ?
          `, [profile.idCuenta]);
          for (const account of accounts) {
            replyMessage += `\n${account.nombre_cuenta.toUpperCase()}\n\nCORREO: ${account.correo}\nCONTRASEÑA: ${account.clave}\nPERFIL: ${client.nombre}-${profile.pinPerfil}\n\nEL SERVICIO VENCERÁ EL DÍA: ${new Date(account.fechaCuenta).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
          }
        }
      }
      await message.reply(replyMessage);
    } else {
      await message.reply(`No se encontraron cuentas asociadas al número ${phoneNumber}.`);
    }
  } catch (error) {
    console.error('Error al buscar en la base de datos:', error);
    await message.reply("Hubo un error al procesar tu solicitud. Por favor, inténtalo de nuevo más tarde.");
  }
  userStates.delete(userId);
}

async function startPurchaseProcess(message, userId) {
  const platforms = await getPlatforms();
  if (platforms.length === 0) {
    await message.reply("No se pudieron cargar las plataformas. Inténtalo más tarde.");
    userStates.delete(userId);
    return;
  }
  let reply = "Plataformas disponibles para compra:\n";
  platforms.forEach((p) => {
    reply += `• ${p.name} - Precio base: $${p.plans[0].price}\n`;
  });

  reply += '\nResponde con los nombres de las plataformas que deseas, separados por coma (ej. Netflix, Disney+).';
  await message.reply(reply);
  userStates.set(userId, 'awaiting_purchase_platforms');
}

async function handleAwaitingPurchasePlatforms(message, userId) {
  const mensaje = message.body;

  // Usar AI para extraer intención
  const intent = await parsePurchaseIntent(mensaje);
  console.log("[DEBUG] Purchase Option 1 Intent:", JSON.stringify(intent, null, 2));
  const { items, subscriptionType } = intent;

  if (!items || items.length === 0) {
    await message.reply("No pude identificar las plataformas. Por favor intenta escribiendo los nombres claros, por ejemplo: Netflix, Disney.");
    return;
  }

  const platforms = await getPlatforms();
  const platformMap = new Map(platforms.map(p => [p.name.toLowerCase(), p]));

  let selectedItems = [];
  let invalidElements = [];

  // Mapear items retornados por AI a plataformas reales
  items.forEach(item => {
    // Fuzzy match platform name
    const targetPlatform = item.platform.toLowerCase();
    const platform = platforms.find(p => p.name.toLowerCase().includes(targetPlatform)) ||
      platforms.find(p => targetPlatform.includes(p.name.toLowerCase()));

    if (platform) {
      let chosenPlan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase();
        chosenPlan = platform.plans.find(p => p.name.toLowerCase().includes(targetPlan));
      }
      selectedItems.push({ platform, chosenPlan });
    } else {
      invalidElements.push(item.platform);
    }
  });

  if (invalidElements.length > 0) {
    // Reportar al grupo para validación si hay alucinaciones o plataformas no soportadas
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        await chat.sendMessage(`🚨 Nuevo caso de compra (Opt 1): Usuario ${userId.replace('@c.us', '')} pidió: ${mensaje}. IA identificó inválidos: ${invalidElements.join(', ')}.`);
      }
    } catch (error) {
      console.error('Error enviando mensaje al grupo:', error);
    }
    await message.reply(`Lo siento, no manejamos las siguientes plataformas: ${invalidElements.join(', ')}. Contactaremos a un asesor.`);
    userStates.delete(userId);
    return;
  }

  // Iniciar selección de planes si hace falta alguno
  // Guardamos subscriptionType en el estado para el cálculo final
  userStates.set(userId, { state: 'selecting_plans', selected: selectedItems, currentIndex: 0, subscriptionType: subscriptionType || 'mensual' });

  // Si ya todos tienen plan (porque el usuario fue específico), showPlanSelection detectará que puede avanzar o verificar
  await showPlanSelection(message, userId);
}

async function showPlanSelection(message, userId) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'selecting_plans') return;

  const { selected, currentIndex } = state;

  // Si ya recorrimos todos los items
  if (currentIndex >= selected.length) {
    await calculateAndShowPrice(message, userId);
    return;
  }

  const current = selected[currentIndex];
  // Si ya tiene plan asignado (por la IA), saltamos al siguiente
  if (current.chosenPlan) {
    state.currentIndex++;
    await showPlanSelection(message, userId); // Recursivo / Iterativo
    return;
  }

  const platform = current.platform;

  // AUTO-SELECT: Si la plataforma solo tiene 1 plan, lo seleccionamos automáticamente
  if (platform.plans.length === 1) {
    selected[currentIndex].chosenPlan = platform.plans[0];
    state.currentIndex++;
    // Recursivo para procesar el siguiente item
    await showPlanSelection(message, userId);
    return;
  }

  let reply = `Selecciona el plan para ${platform.name}:\n`;
  platform.plans.forEach((plan, idx) => {
    reply += `${idx + 1}. ${plan.name} - $${plan.price}\n  ${plan.characteristics.join('\n  ')}\n`;
  });
  reply += `\nResponde con el número del plan, o 'agregar' para añadir otra plataforma.`;

  await message.reply(reply);
}

async function handleSelectingPlans(message, userId) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'selecting_plans') return;

  const { selected, currentIndex } = state;
  const body = message.body.trim().toLowerCase();

  if (body === 'agregar') {
    // Save current index to return to it later
    userStates.set(userId, { state: 'adding_platform', selected, subscriptionType: state.subscriptionType, returnIndex: currentIndex });
    await showAvailablePlatforms(message, userId);
    return;
  }

  const selection = parseInt(body) - 1;
  const current = selected[currentIndex];

  // Defensive check
  if (!current || !current.platform) {
    console.error("[ERROR] Current item is undefined in handleSelectingPlans. Resetting index.");
    state.currentIndex = 0;
    await showPlanSelection(message, userId);
    return;
  }

  if (isNaN(selection) || selection < 0 || selection >= current.platform.plans.length) {
    await message.reply('No te entendí. Por favor dime el número del plan (ej: 1) o escribe "agregar" si quieres algo más.');
    return;
  }

  selected[currentIndex].chosenPlan = current.platform.plans[selection];
  state.currentIndex++;

  if (state.currentIndex >= selected.length) {
    await calculateAndShowPrice(message, userId);
  } else {
    await showPlanSelection(message, userId);
  }
}

async function showAvailablePlatforms(message, userId) {
  const platforms = await getPlatforms();
  const state = userStates.get(userId);
  const selectedIds = state.selected.map(s => s.platform.id);
  const available = platforms.filter(p => !selectedIds.includes(p.id));

  if (available.length === 0) {
    await message.reply('No hay más plataformas disponibles para agregar.');
    // Restore index
    const nextIndex = state.returnIndex !== undefined ? state.returnIndex : state.selected.length - 1;
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
    await showPlanSelection(message, userId);
    return;
  }

  let reply = 'Plataformas disponibles para agregar:\n';
  available.forEach((p) => {
    reply += `• ${p.name}\n`;
  });
  reply += '\nResponde con el nombre de la plataforma para agregar, o "volver" para continuar con la selección actual.';

  await message.reply(reply);
}

async function handleAddingPlatform(message, userId) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'adding_platform') return;

  const body = message.body.trim().toLowerCase();

  if (body === 'volver') {
    const nextIndex = state.returnIndex !== undefined ? state.returnIndex : 0;
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
    await showPlanSelection(message, userId);
    return;
  }

  const platforms = await getPlatforms();
  const selectedIds = state.selected.map(s => s.platform.id);
  const available = platforms.filter(p => !selectedIds.includes(p.id));

  const selection = parseInt(body) - 1;

  if (isNaN(selection) || selection < 0 || selection >= available.length) {
    await message.reply('Selección inválida. Responde con el número o "volver".');
    return;
  }

  state.selected.push({ platform: available[selection], chosenPlan: null });

  // Restore index to continue where we left off (or process the new item if queue was empty)
  const nextIndex = state.returnIndex !== undefined ? state.returnIndex : state.selected.length - 1;
  userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
  await showPlanSelection(message, userId);
}

async function calculateAndShowPrice(message, userId) {
  const state = userStates.get(userId);
  const selected = state.selected;
  const subscriptionType = state.subscriptionType || 'mensual'; // Recuperar tipo de suscripción

  let totalPrice = 0;
  let responseText = 'Has seleccionado:\n';
  let hasErrors = false;

  selected.forEach(s => {
    const plan = s.chosenPlan;
    if (!plan) {
      // Should not happen if logic is correct, but prevents crash
      hasErrors = true;
      return;
    }
    totalPrice += plan.price;
    responseText += `- ${s.platform.name} (${plan.name}): $${plan.price}\n`;
  });

  if (hasErrors) {
    // Recovery mode: filter out invalid items or restart selection?
    // For now, let's just restart selection for those missing items
    const firstMissingIndex = selected.findIndex(s => !s.chosenPlan);
    if (firstMissingIndex !== -1) {
      console.log("Found missing plan at index", firstMissingIndex, "restarting selection loop.");
      userStates.set(userId, { state: 'selecting_plans', selected: selected, currentIndex: firstMissingIndex, subscriptionType });
      await showPlanSelection(message, userId);
      return;
    }
  }

  const numPlatforms = selected.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    totalPrice -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  // Ajuste por periodo (Lógica copiada de handleSubscriptionInterest)
  let periodText = "/mes";
  if (subscriptionType === 'anual') {
    totalPrice = totalPrice * 12 * 0.85;
    periodText = "/año";
  } else if (subscriptionType === 'semestral') {
    totalPrice = totalPrice * 6 * 0.93;
    periodText = "/semestre";
  }

  totalPrice = Math.round(totalPrice);
  responseText += `\nTotal (${subscriptionType}): $${totalPrice}${periodText}`;

  await message.reply(responseText);

  let paymentOptions = "⭐Nequi\n⭐Llave Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
  // Pasamos el total calculado al siguiente estado
  userStates.set(userId, { state: 'awaiting_payment_method', total: totalPrice, items: selected });
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
