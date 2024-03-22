const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');

async function connectToDatabase() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'datos'
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

client.on('message', async (message) => {
    if (message.body === '¿Cuál es mi información?') {
        let connection;
        try {
            connection = await connectToDatabase();
            const contactId = message.from.replace('@c.us', '').replace(/\D/g, '').slice(2);
            console.log('Número de contacto limpio:', contactId);

            const [rows] = await connection.query('SELECT * FROM personaldata WHERE tel = ?', [contactId]);
            console.log('Resultado de la consulta:', rows);
            
            if (rows.length > 0) {
                const userInfo = rows[0];
                await message.reply(`Hola, ${userInfo.name}. Tu correo es ${userInfo.mail}.`);
            } else {
                await message.reply("Lo siento, no tengo información sobre ti.");
            }
        } catch (error) {
            console.error('Error al buscar en la base de datos:', error);
        } finally {
            if (connection) {
                await connection.end();
            }
        }
    }
});

client.initialize();
