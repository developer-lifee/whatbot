const { Client, LocalAuth } = require('/root/whatbot/node_modules/whatsapp-web.js');

console.log("=== Testing whatsapp-web.js Client Initialization ===");

const client = new Client({
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-blink-features=AutomationControlled'
        ],
        timeout: 60000,
        protocolTimeout: 120000
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({ dataPath: '/root/test_wweb_auth' }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1043861459-alpha.html',
        strict: false
    }
});

client.on('qr', (qr) => {
    console.log("✅ QR RECEIVED! Client connected to WhatsApp Web page successfully!");
    process.exit(0);
});

client.on('ready', () => {
    console.log("✅ CLIENT READY!");
    process.exit(0);
});

client.on('auth_failure', msg => {
    console.error("❌ AUTH FAILURE:", msg);
});

client.initialize().then(() => {
    console.log("Client initialize promise resolved.");
}).catch(err => {
    console.error("❌ Client initialize FAILED:", err);
});
