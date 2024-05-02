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
            await processBuyAccount(message, userId);
            break;
        case '2':
            // Revisar credenciales
            await processCheckCredentials(message, userId);
            break;
        case '3':
            // Informar sobre precios
            await message.reply("Los precios de nuestras cuentas son...");
            userStates.delete(userId); // Limpiar el estado después de manejar
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

async function processBuyAccount(message, userId) {
    let connection;
    try {
        connection = await connectToDatabase();
        const [rows] = await connection.query('SELECT nombre_cuenta, precio FROM lista_maestra ORDER BY id_streaming');
        if (rows.length > 0) {
            let replyMessage = "A continuación, te proporciono la información de nuestras cuentas streaming y sus precios:\n";
            rows.forEach((account, index) => {
                replyMessage += `${index + 1}. ${account.nombre_cuenta}: $${account.precio}\n`;
            });
            replyMessage += "\nPor favor, responde con el número de la opción que deseas comprar.";
            await message.reply(replyMessage);
            userStates.set(userId, 'awaiting_account_selection');
        } else {
            await message.reply("Actualmente no tenemos información sobre cuentas disponibles.");
            userStates.delete(userId); // Limpiar el estado después de manejar
        }
    } catch (error) {
        console.error('Error al buscar en la base de datos:', error);
        await message.reply("Hubo un error al procesar tu solicitud. Por favor, inténtalo de nuevo más tarde.");
        userStates.delete(userId); // Limpiar el estado después de manejar
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

client.on('message', async (message) => {
    const userId = message.from;
    const currentState = userStates.get(userId);
    const userSelection = message.body.trim();

    switch (currentState) {
        case 'awaiting_account_selection':
            // Procesar la elección de la cuenta
            if (/^\d+$/.test(userSelection)) {  // Asegurarse de que es un número
                let paymentOptions = "⭐Nequi\n⭐Transfiya\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
                await message.reply(paymentOptions);
                userStates.set(userId, 'awaiting_payment_method');
            } else {
                await message.reply("Por favor, selecciona una opción válida.");
            }
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
                // Aquí puedes hacer algo con la imagen, como guardarla o procesarla
                await message.reply("Hemos recibido tu comprobante. Una persona revisará el comprobante para pasarte tus credenciales.");
                userStates.delete(userId); // Limpiar el estado después de manejar
            } else {
                await message.reply("Por favor, envía el comprobante de la transacción.");
            }
            break;
        default:
            // Código para otros estados
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
