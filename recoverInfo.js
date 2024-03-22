const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');


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

client.initialize();

client.on('message', async (message) => {
    if (message.body === '!recuperar') {
        // Obtiene el chat desde el mensaje
        const chat = await message.getChat();
        
        // Recupera los últimos 10 mensajes del chat
        const messages = await chat.fetchMessages({ limit: 10 });
        
        // Construye una respuesta con el contenido de los últimos mensajes
        let reply = 'Aquí están tus últimos mensajes:\n';
        messages.forEach((fetchedMsg, index) => {
            // Aquí simplemente agregaremos el cuerpo del mensaje a la respuesta
            reply += `${index + 1}: ${fetchedMsg.body}\n`;
        });

        // Responde al usuario con los últimos mensajes
        await message.reply(reply);
    }
});

client.on('ready', () => {
    console.log('Cliente listo!');
});
