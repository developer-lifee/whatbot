const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
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

// Conexión a la base de datos
async function connectToDatabase() {
  const connection = await mysql.createConnection({
    host: 'mysql.freehostia.com',
    user: 'estavi0_sheerit',
    password: '26o6ssCOA^',
    database: 'estavi0_sheerit'
  });
  return connection;
}

// Configuración del cliente de WhatsApp
const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }) // Asegura que la ruta es persistente en Render
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
client.on('message', async (message) => {
  const userId = message.from;
  const currentState = userStates.get(userId);

    // Primero, verifica si el mensaje corresponde al inicio de una suscripción

  if (message.body.startsWith("Hola, estoy interesado en una suscripción de:")) {
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
    case 'awaiting_payment_confirmation':
      await handleAwaitingPaymentConfirmation(message, userId);
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
  const indiceDosPuntos = mensaje.indexOf(":");
  const indiceCosto = mensaje.indexOf("Costo");
  const textoExtraido = mensaje.slice(indiceDosPuntos + 2, indiceCosto).trim();
  const elementos = textoExtraido.split(", ");
   // Accede a todos los elementos individuales
  let responseText = "Has seleccionado suscripción para:\n";
  elementos.forEach((elemento, index) => {
    responseText += `${index + 1}. ${elemento}\n`;
  });

  await message.reply(responseText);
  //Mostar opciones de pago y guardar estado
  let paymentOptions = "⭐Nequi\n⭐Transfiya\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
  userStates.set(userId, 'awaiting_payment_method');
}

async function handleAwaitingPaymentMethod(message, userId) {
        // Asumiendo que el usuario selecciona el método de pago correctamente
  const paymentDetails = {
    'nequi': "3107946794",
    'daviplata': "3107946794",
    'bancolombia': "23127094942\nBancolombia - ahorros\nLuisa Fernanda Daza Munar\nCC 1116542241",
    'banco caja social': "24111572331\nESTEBAN AVILA\ncc: 1032936324",
    'transfiya': "3118587974"
  };
  let foundKey = Object.keys(paymentDetails).find(key => message.body.toLowerCase().includes(key));
  if (foundKey) {
    await message.reply(paymentDetails[foundKey]);
    userStates.set(userId, 'awaiting_payment_confirmation');
  } else {
    await message.reply("Por favor, selecciona un método de pago de la lista proporcionada.");
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
  let connection;
  try {
    connection = await connectToDatabase();
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); // Elimina todos los caracteres que no son dígitos

    // Consulta SQL con normalización
    const [clients] = await connection.query(
        'SELECT clienteID, nombre FROM datos_de_cliente WHERE REPLACE(REPLACE(REPLACE(numero, " ", ""), "-", ""), ".", "") = ?',
        [phoneNumber]
    );
    if (clients.length > 0) {
      let replyMessage = "Estas son tus cuentas actuales:\n";
      for (const client of clients) {
         // Obtener los perfiles y el pin de perfil usando el clienteID.
        const [profiles] = await connection.query('SELECT idCuenta, pinPerfil FROM perfil WHERE clienteID = ?', [client.clienteID]);
        for (const profile of profiles) {
             // Obtener los detalles de la cuenta usando idCuenta.
          const [accounts] = await connection.query(`
            SELECT c.correo, c.clave, c.fechaCuenta, lm.nombre_cuenta
            FROM datosCuenta c
            JOIN lista_maestra lm ON c.id_streaming = lm.id_streaming
            WHERE c.idCuenta = ?
          `, [profile.idCuenta]);
          for (const account of accounts) {
            replyMessage += `
${account.nombre_cuenta.toUpperCase()}

CORREO: ${account.correo}
CONTRASEÑA: ${account.clave}
PERFIL: ${client.nombre}-${profile.pinPerfil}

EL SERVICIO VENCERÁ EL DÍA: ${new Date(account.fechaCuenta).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}
`;
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
  } finally {
    if (connection) {
      await connection.end();
    }
  }
  userStates.delete(userId);
}

client.initialize();
