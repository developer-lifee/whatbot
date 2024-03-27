const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');

async function connectToDatabase() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'esteban'
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

const userStates = new Map();

client.on('message', async (message) => {
    const userId = message.from;
    
    if (message.body === '/ayuda') {
        await message.reply(
            "Aquí tienes las opciones disponibles:\n" +
            "1 - Comprar cuenta\n" +
            "2 - Revisar credenciales\n" +
            "3 - Precio de mis cuentas\n" +
            "4 - No puedo acceder a mi cuenta\n" +
            "5 - Otro\n" +
            "Por favor, responde *SOLO* con el número de la opción que deseas."
        );
    } else if (message.body.trim() === '1') {
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
        await message.reply("Entiendo que tienes una consulta diferente a las opciones brindadas. así que un asesor te atenderá lo mas pronto posible, muchas gracias.");
    }
});

client.initialize();

