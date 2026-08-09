const { Client, LocalAuth } = require('/root/whatbot/node_modules/whatsapp-web.js');

console.log("=== TEST: Clean dataPath .wwebjs_auth_new ===");

const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        timeout: 60000,
        protocolTimeout: 120000
    },
    authStrategy: new LocalAuth({ dataPath: '/root/whatbot/.wwebjs_auth_new' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1043861459-alpha.html',
        strict: false
    }
});

client.on('qr', (qr) => {
    console.log("🎉 SUCCESS! QR CODE GENERATED SUCCESSFULLY!");
    process.exit(0);
});

client.on('ready', () => {
    console.log("🎉 SUCCESS! CLIENT READY!");
    process.exit(0);
});

client.initialize().catch(err => {
    console.error("❌ FAILED:", err);
});
