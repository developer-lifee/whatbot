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

//Genera el token de usuario  
const client = new Client({
    authStrategy: new LocalAuth()
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
            let replyMessage = "A continuación, te proporciono la información de nuestras ventas de cuentas streaming:\n";
            rows.forEach(account => {
                replyMessage += `- ${account.nombre_cuenta}: $${account.precio}\n`;
            });
            await message.reply(replyMessage);
        } else {
            await message.reply("Actualmente no tenemos información sobre cuentas disponibles.");
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

async function processCheckCredentials(message, userId) {
    let connection;
    try {
        connection = await connectToDatabase();
        const phoneNumber = userId.replace('@c.us', '');
        // Buscar el clienteID usando el número de teléfono
        const [clients] = await connection.query('SELECT clienteID FROM datos_de_cliente WHERE numero = ?', [phoneNumber]);

        if (clients.length > 0) {
            let replyMessage = "Estas son tus cuentas actuales:\n";
            for (const client of clients) {
                // Para cada clienteID, buscar en perfil para obtener los idCuenta
                const [profiles] = await connection.query('SELECT idCuenta FROM perfil WHERE clienteID = ?', [client.clienteID]);
                for (const profile of profiles) {
                    // Para cada idCuenta, buscar en datoscuenta para obtener los detalles de la cuenta
                    const [accounts] = await connection.query('SELECT correo, clave FROM datoscuenta WHERE idCuenta = ?', [profile.idCuenta]);
                    accounts.forEach((account, index) => {
                        replyMessage += `${index + 1}- ${account.correo} - ${account.clave}\n`;
                    });
                }
            }
            await message.reply(replyMessage);
        } else {
            await message.reply("No se encontraron cuentas asociadas a tu número.");
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
