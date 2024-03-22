const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');

// Conexion a la base de datos, cambiar por las credenciales de acceso y la respectiva tabla  
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

//  El message.body es el mensaje que deberá enviar la persona para que el bot le brinde la información almacenada a su NUMERO DE TELEFONO, esa es la primary Key de este caso 
/**
** Para el mensaje se pueden manejar con el operador OR y validar distintos casos o simular un caso de ayuda, ejemplo "/ayuda", cuando el usuario ingrese dicho mensaje
** el bot arrojara distintas "opciones" que ayuden al usuario a saber que mensaje especificamente enviar para que automaticamente el bot responda, o en caso de ser necesario
** que arroje una notificacion al numero de esteban solicitando ayuda de una persona.

*? Este caso de prueba es si el cliente requiere la informacion de la cuenta o cuentas que tiene, también se puede agrerar temas de deudas, fecha de corte, etc, solo se necesita
*? establecer la conexion a la tabla donde esta dicha data e indicar las columnas como se ve en la parte inferior

 *! Es necesario averiguar una forma de sanitizar la información para evitar SQL Injection 
 */
    if (message.body === '¿Cuál es mi información?') {
        const contactId = message.from.replace('@c.us', '').replace(/\D/g, '');
        console.log('Número de contacto limpio:', contactId);

        try {
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
            if (connection && connection.end) connection.end();
        }
    }
});


client.initialize();
