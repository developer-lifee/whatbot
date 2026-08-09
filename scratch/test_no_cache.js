const { Client, LocalAuth } = require('/root/whatbot/node_modules/whatsapp-web.js');
const path = require('path');

console.log("=== TEST: Without webVersionCache ===");

const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-blink-features=AutomationControlled'
        ],
        timeout: 60000,
        protocolTimeout: 120000
    },
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') })
});

client.on('qr', (qr) => {
    console.log("🎉 SUCCESS! QR CODE GENERATED WITHOUT WEBVERSIONCACHE!");
    process.exit(0);
});

client.on('ready', () => {
    console.log("🎉 SUCCESS! CLIENT READY!");
    process.exit(0);
});

client.initialize().catch(err => {
    console.error("❌ FAILED:", err);
});
