const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { pool } = require('./database');
const schedule = require('node-schedule');

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
        // Si es Mac, usa tu Chrome. Si es Linux, usa el que trae Puppeteer (undefined)
        executablePath: isMac ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' })
});

// Generar QR para conexión
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('Conexión establecida correctamente');
});

// Map para manejar el estado de los usuarios
//Se usa la libreria llamada "node-schedule", cualquier duda o cambio, REVISAR LA DOCUMENTACION <3
// https://www.npmjs.com/package/node-schedule 
//se tiene que llamar la funcion de database y scheduledTask
const userStates = new Map();

// Manejar mensajes entrantes
// Admin/operator number to notify when a human intervention is required
const OPERATOR_NUMBER = (process.env.OPERATOR_NUMBER || '573107946794') + '@c.us';

// Storage for temporary confirmations (e.g., pending cobros)
const pendingConfirmations = new Map();

// URL para obtener plataformas
const PLATFORMS_URL = 'https://tusitio.com/data/platforms.json';

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

// Función para obtener grupo por nombre
async function getGroupByName(name) {
  const chats = await client.getChats();
  return chats.find(chat => chat.isGroup && chat.name === name);
}

client.on('message', async (message) => {
  const userId = message.from;
  const currentState = userStates.get(userId);

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
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) {}
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

  if (message.body && message.body.startsWith("Hola, estoy interesado en una suscripción de:")) {
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
        "6 - Consultar plataformas disponibles\n" +
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
    case 'awaiting_platform_selection':
      await handleAwaitingPlatformSelection(message, userId);
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
      await message.reply("Para comprar una cuenta, por favor ingresa a nuestra página sheerit.com.co y selecciona la cuenta o el combo que desees.");
      userStates.delete(userId);
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
        const grupo = await getGroupByName('Sheer-it general📽️📽️');
        if (grupo) {
          await grupo.sendMessage(`🚨 Nuevo caso para atención: Usuario ${userId} seleccionó "Otro" y necesita ayuda de un asesor.`);
        } else {
          console.error('Grupo no encontrado');
        }
      } catch (error) {
        console.error('Error enviando mensaje al grupo:', error);
      }
      await message.reply("Un asesor te atenderá lo más pronto posible.");
      userStates.delete(userId);
      break;
    case '6':
      await processConsultPlatforms(message, userId);
      break;
    default:
      await message.reply("Por favor, selecciona una opción válida del menú.");
      break;
  }
}

async function handleSubscriptionInterest(message, userId) {
  const mensaje = message.body;
  const indiceDosPuntos = mensaje.indexOf(":");
  const indiceCosto = mensaje.indexOf("Costo");
  const textoExtraido = mensaje.slice(indiceDosPuntos + 2, indiceCosto).trim();
  const elementos = textoExtraido.split(", ");

  const platforms = await getPlatforms();
  const platformMap = new Map(platforms.map(p => [p.name.toLowerCase(), p]));

  let selectedItems = [];
  let invalidElements = [];
  elementos.forEach(elem => {
    const trimmed = elem.trim();
    if (trimmed.includes(" - ")) {
      const [platName, planName] = trimmed.split(" - ").map(s => s.trim());
      const platform = platformMap.get(platName.toLowerCase());
      if (platform) {
        const plan = platform.plans.find(p => p.name.toLowerCase() === planName.toLowerCase());
        if (plan) {
          selectedItems.push({ platform, plan });
        } else {
          invalidElements.push(trimmed);
        }
      } else {
        invalidElements.push(trimmed);
      }
    } else {
      const platform = platformMap.get(trimmed.toLowerCase());
      if (platform) {
        selectedItems.push({ platform, plan: null }); // Sin plan especificado
      } else {
        invalidElements.push(trimmed);
      }
    }
  });

  if (invalidElements.length > 0 || selectedItems.some(s => s.plan === null)) {
    // Reportar al grupo para validación
    try {
      const grupo = await getGroupByName('Sheer-it general📽️📽️');
      if (grupo) {
        await grupo.sendMessage(`🚨 Nuevo caso de interés: Usuario ${userId} expresó interés en: ${mensaje}. Necesita validación.`);
      } else {
        console.error('Grupo no encontrado');
      }
    } catch (error) {
      console.error('Error enviando mensaje al grupo:', error);
    }
    await message.reply("Tu solicitud ha sido enviada a un asesor para validación. Te atenderán pronto.");
    userStates.delete(userId);
    return;
  }

  let responseText = "Has seleccionado:\n";
  let totalPrice = 0;
  selectedItems.forEach(s => {
    totalPrice += s.plan.price;
    responseText += `- ${s.platform.name} (${s.plan.name}): $${s.plan.price}\n`;
  });

  const numPlatforms = selectedItems.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    totalPrice -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  // Verificar si es anual o semestral
  const lowerMsg = mensaje.toLowerCase();
  if (lowerMsg.includes('anual')) {
    totalPrice = totalPrice * 12 * 0.85; // 15% descuento
  } else if (lowerMsg.includes('semestral')) {
    totalPrice = totalPrice * 6 * 0.93; // 7% descuento
  }

  responseText += `Total: $${Math.round(totalPrice)}`;

  await message.reply(responseText);
  //Mostrar opciones de pago y guardar estado
  let paymentOptions = "⭐Nequi\n⭐Transfiya\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
  userStates.set(userId, 'awaiting_payment_method');
}

async function handleAwaitingPaymentMethod(message, userId) {
        // Asumiendo que el usuario selecciona el método de pago correctamente
  const paymentDetails = {
    'nequi': "3118587974",
    'daviplata': "3107946794",
    'bancolombia': "46772753713\nBancolombia - ahorros\nNumero de cuenta: 46772753713\nCC1032936324",
    'banco caja social': "24111572331\nESTEBAN AVILA\ncc: 1032936324",
    'llaves BRE-V': "3118587974"
  };
  let foundKey = Object.keys(paymentDetails).find(key => message.body.toLowerCase().includes(key));
  if (foundKey) {
    await message.reply(paymentDetails[foundKey]);
    userStates.set(userId, 'awaiting_payment_confirmation');
  } else {
    await message.reply("Por favor, selecciona un método de pago de la lista proporcionada.");
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
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) {}
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
    const media = await message.downloadMedia();
    await message.reply("Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
    userStates.delete(userId);
  } else {
    await message.reply("Por favor, envía el comprobante de la transacción.");
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

async function processConsultPlatforms(message, userId) {
  const platforms = await getPlatforms();
  if (platforms.length === 0) {
    await message.reply("No se pudieron cargar las plataformas. Inténtalo más tarde.");
    userStates.delete(userId);
    return;
  }
  let reply = "Plataformas disponibles:\n";
  platforms.forEach((p, index) => {
    reply += `${index + 1}. ${p.name} - Precio base: $${p.price}\n`;
  });
  reply += "\nResponde con el número de la plataforma para ver detalles.";
  await message.reply(reply);
  userStates.set(userId, 'awaiting_platform_selection');
}

async function handleAwaitingPlatformSelection(message, userId) {
  const platforms = await getPlatforms();
  const selection = parseInt(message.body.trim()) - 1;
  if (isNaN(selection) || selection < 0 || selection >= platforms.length) {
    await message.reply("Selección inválida. Responde con el número de la plataforma.");
    return;
  }
  const platform = platforms[selection];
  let reply = `${platform.name}\n\nCaracterísticas:\n${platform.characteristics.join('\n')}\n\nPlanes:\n`;
  platform.plans.forEach(plan => {
    reply += `- ${plan.name}: $${plan.price}\n  ${plan.characteristics.join('\n  ')}\n`;
  });
  await message.reply(reply);
  userStates.delete(userId);
}

async function showPlanSelection(message, userId) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'selecting_plans') return;

  const { selected, currentIndex } = state;

  if (currentIndex >= selected.length) {
    await calculateAndShowPrice(message, userId);
    return;
  }

  const current = selected[currentIndex];
  const platform = current.platform;

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
    userStates.set(userId, { state: 'adding_platform', selected });
    await showAvailablePlatforms(message, userId);
    return;
  }

  const selection = parseInt(body) - 1;
  const current = selected[currentIndex];

  if (isNaN(selection) || selection < 0 || selection >= current.platform.plans.length) {
    await message.reply('Selección inválida. Responde con el número del plan o "agregar".');
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
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: state.selected.length - 1 });
    await showPlanSelection(message, userId);
    return;
  }

  let reply = 'Plataformas disponibles para agregar:\n';
  available.forEach((p, idx) => {
    reply += `${idx + 1}. ${p.name}\n`;
  });
  reply += '\nResponde con el número de la plataforma para agregar, o "volver" para continuar con la selección actual.';

  await message.reply(reply);
}

async function handleAddingPlatform(message, userId) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'adding_platform') return;

  const body = message.body.trim().toLowerCase();

  if (body === 'volver') {
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: 0 });
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
  userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: state.selected.length - 1 });
  await showPlanSelection(message, userId);
}

async function calculateAndShowPrice(message, userId) {
  const state = userStates.get(userId);
  const selected = state.selected;

  let totalPrice = 0;
  let responseText = 'Has seleccionado:\n';

  selected.forEach(s => {
    const plan = s.chosenPlan;
    totalPrice += plan.price;
    responseText += `- ${s.platform.name} (${plan.name}): $${plan.price}\n`;
  });

  const numPlatforms = selected.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    totalPrice -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  responseText += `Total: $${totalPrice}`;

  await message.reply(responseText);

  let paymentOptions = "⭐Nequi\n⭐Transfiya\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
  userStates.set(userId, 'awaiting_payment_method');
}

// --- AL FINAL DEL ARCHIVO index.js ---

// Esto evita que el bot se cierre si hay un error de código imprevisto
process.on('uncaughtException', (err) => {
    console.error('🔥 Error No Capturado (El bot sigue vivo):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Promesa Rechazada sin manejo (El bot sigue vivo):', reason);
});

client.initialize();
