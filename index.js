const http = require('http');

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hola, mundo!\n');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Servidor corriendo en el puerto ${port}`);
});

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const schedule = require('node-schedule');

async function connectToDatabase() {
  const connection = await mysql.createConnection({
    host: 'mysql.freehostia.com',
    user: 'estavi0_sheerit',
    password: '26o6ssCOA^',
    database: 'estavi0_sheerit'
  });
  return connection;
}

const client = new Client({
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }) // Asegura que la ruta es persistente en Render
});

//Genera el QR 
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Conexión establecida correctamente');
});


//Se usa la libreria llamada "node-schedule", cualquier duda o cambio, REVISAR LA DOCUMENTACION <3
// https://www.npmjs.com/package/node-schedule

// Función para enviar mensajes recordando cuentas vencidas
async function sendMessage(to, message) {
    const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
    await client.sendMessage(chatId, message);
}

// Tarea programada para verificar y notificar sobre cuentas vencidas
const job = schedule.scheduleJob('0 0 * * *', function() { // Se ejecuta todos los días a media noche
    console.log('Verificando cuentas vencidas...');
    const today = new Date().toISOString().slice(0, 10); // Formato AAAA-MM-DD, tener presente si se cambia el formato en la base de datos
    const query = 'SELECT correo, streaming FROM datoscuenta WHERE fechaCuenta = ?';
    
    dbConnection.query(query, [today], (error, results) => {
        if (error) {
            return console.error('Error al buscar cuentas vencidas:', error);
        }
        results.forEach((account) => {
            const message = `Recordatorio: La cuenta ${account.streaming} asociada al correo ${account.correo} vence hoy.`;
            const phoneNumber = '573133890800';
            sendMessage(phoneNumber, message);
        });
    });
});
const userStates = new Map();

client.on('message', async (message) => {
    const userId = message.from;
    const currentState = userStates.get(userId);

    // Procesar respuesta basada en el estado actual
    switch (currentState) {
        case undefined:
            // No hay estado registrado, enviar menú inicial
            userStates.set(userId, 'main_menu'); // Establecer el estado inicial
            await message.reply(
                "Aquí tienes las opciones disponibles:\n" +
                "1 - Comprar cuenta\n" +
                "2 - Revisar credenciales\n" +
                "3 - Precio de mis cuentas\n" +
                "4 - No puedo acceder a mi cuenta\n" +
                "5 - Otro\n" +
                "Por favor, responde *SOLO* con el número de la opción que deseas."
            );
            break;
        case 'main_menu':
            // Procesar la selección del menú principal
            await handleMainMenuSelection(message, userId);
            break;
        case 'seleccionar_servicio':
            // Manejar la selección del servicio si el estado es 'seleccionar_servicio'
            userStates.delete(userId); // Limpiar el estado después de manejar
            await message.reply("ERROR");
            break;
        default:
            // Estado desconocido o no manejado, limpiar estado y reiniciar
            userStates.delete(userId);
            await message.reply("No comprendo tu selección. Vamos a empezar de nuevo.");
            break;
    }
});

async function handleMainMenuSelection(message, userId) {
    const userSelection = message.body.trim();
    switch (userSelection) {
        case '1':
            // Procesar la compra de cuenta
            await message.reply("para comprar una cuenta, por favor ingresa a nuestra pagina sheerit.lafaena.co y selecciona la cuenta o el combo que desees");
            userStates.delete(userId); // Limpiar el estado después de manejar
            break;
        case '2':
            // Revisar credenciales
            await processCheckCredentials(message, userId);
            break;
        case '3':
            // Informar sobre precios
            await processCheckPrices(message, userId);
            break;
        case '4':
            // Problemas para acceder, mostrar opciones de servicio
            userStates.set(userId, 'seleccionar_servicio');
            await message.reply("Selecciona el servicio al que no puedes acceder...");
            break;
        case '5':
            // Consulta diferente
            await message.reply("Un asesor te atenderá lo más pronto posible.");
            userStates.delete(userId); // Limpiar el estado después de manejar
            break;
        default:
            // Selección no válida
            await message.reply("Por favor, selecciona una opción válida del menú.");
            break;
    }
}

client.on('message', async (message) => {
    const userId = message.from;
    const currentState = userStates.get(userId);

    if (message.body.startsWith("Hola, estoy interesado en una suscripción de:")) {
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

        // Mostrar opciones de pago después de listar suscripciones
        let paymentOptions = "⭐Nequi\n⭐Transfiya\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
        await message.reply(paymentOptions);
        userStates.set(userId, 'awaiting_payment_method');
        return;  // Finaliza la ejecución para evitar entrar en otras condiciones
    }

    // Procesar respuesta basada en el estado actual
    switch (currentState) {
        case 'main_menu':
            // Manejo de menú principal...
            break;
        case 'awaiting_payment_method':
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
            break;
        case 'awaiting_payment_confirmation':
            if (message.hasMedia) {
                const media = await message.downloadMedia();
                await message.reply("Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
                userStates.delete(userId); // Limpiar el estado después de manejar
            } else {
                await message.reply("Por favor, envía el comprobante de la transacción.");
            }
            break;
        default:
            // Si no hay estados aplicables, se puede pedir al usuario que reinicie la conversación
            userStates.delete(userId);
            await message.reply("No comprendo tu selección. Vamos a empezar de nuevo.");
            break;
    }
});



async function processCheckCredentials(message, userId) {
    let connection;
    try {
        connection = await connectToDatabase();
        const phoneNumber = userId.replace('@c.us', '');
        // Buscar el clienteID usando el número de teléfono
        const [clients] = await connection.query('SELECT clienteID, nombre FROM datos_de_cliente WHERE numero = ?', [phoneNumber]);

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
    userStates.delete(userId); // Limpiar el estado después de manejar
}

client.initialize();
