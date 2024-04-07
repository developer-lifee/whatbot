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
    host: '200.118.60.37',
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

// uso de la libreria "whatsapp-web.js 1.23.0", cualquier duda o cambio, REVISAR LA DOCUMENTACION <3
// https://docs.wwebjs.dev/index.html

client.on('message', async (message) => {
    const userId = message.from;
    
await message.reply(
    "Aquí tienes las opciones disponibles:\n" +
    "1 - Comprar cuenta\n" +
    "2 - Revisar credenciales\n" +
    "3 - Precio de mis cuentas\n" +
    "4 - No puedo acceder a mi cuenta\n" +
    "5 - Otro\n" +
    "Por favor, responde *SOLO* con el número de la opción que deseas."
);

   if (message.body.trim() === '1') {
        // Caso 1: Comprar cuenta
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
    } else if (message.body.trim() === '2') {
        // Caso 2: Revision de credenciales
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
    } else if (message.body.trim() === '4') {
        // Caso 4: Problemas al ingresar, retorno de imagenes
        userStates.set(userId, 'seleccionar_servicio');
        await message.reply(
            "Entiendo que tienes problemas para acceder a tu cuenta. Por favor, selecciona el número del servicio al que no puedes acceder:\n" +
            "1 - Netflix\n" +
            "2 - Amazon\n" +
            "3 - Disney\n" +
            "4 - HBO\n" +
            "5 - Paramount\n" +
            "6 - Star+\n" +
            "7 - Spotify\n" +
            "8 - YouTube\n" +
            "9 - Crunchyroll\n" +
            "10 - IPTV\n" +
            "11 - Xbox Game Pass\n" +
            "12 - Chat GPT\n" +
            "Por favor, responde *SOLO* con el número de la opción que deseas."
        );
    } else if (userStates.get(userId) === 'seleccionar_servicio') {
        userStates.delete(userId);
        await message.reply("ERROR");
    }
     else if (message.body.trim() === '5') {
        // Caso 5: Revision de credenciales
        await message.reply("Entiendo que tienes una consulta diferente a las opciones brindadas así que un asesor te atenderá lo mas pronto posible, muchas gracias.");
    }
});

client.initialize();

