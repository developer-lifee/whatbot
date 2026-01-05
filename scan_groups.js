const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    puppeteer: {
        // Si es Mac, usa tu Chrome. Si es Linux, usa el que trae Puppeteer (undefined)
        executablePath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' })
});

client.on('qr', (qr) => {
  console.log('Escanea el QR con WhatsApp:');
  require('qrcode-terminal').generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ Cliente listo y conectado!');
    console.log('🔍 Buscando grupos...');

    const chats = await client.getChats();
    
    // Filtramos solo los grupos
    const grupos = chats.filter(chat => chat.isGroup);

    console.log('------------------------------------------------');
    console.log(`Encontré ${grupos.length} grupos. Aquí tienes sus IDs:`);
    console.log('------------------------------------------------');

    grupos.forEach(grupo => {
        console.log(`Nombre: ${grupo.name}`);
        console.log(`ID:     ${grupo.id._serialized}`);
        console.log('------------------------------------------------');
    });

    process.exit(0); // Salir después de imprimir
});

client.initialize();