const puppeteer = require('/root/whatbot/node_modules/puppeteer');

(async () => {
    console.log("=== TEST 1: Default Puppeteer Launch ===");
    try {
        const browser = await puppeteer.launch({
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
            ]
        });
        console.log("Test 1 SUCCESS! Chrome Version:", await browser.version());
        await browser.close();
    } catch (e) {
        console.error("Test 1 FAILED:", e.message);
    }

    console.log("\n=== TEST 2: Headless 'shell' mode ===");
    try {
        const browser = await puppeteer.launch({
            headless: 'shell',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });
        console.log("Test 2 SUCCESS! Chrome Version:", await browser.version());
        await browser.close();
    } catch (e) {
        console.error("Test 2 FAILED:", e.message);
    }

    console.log("\n=== TEST 3: System Chromium/Chrome if available ===");
    try {
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/google-chrome-stable',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log("Test 3 SUCCESS! Chrome Version:", await browser.version());
        await browser.close();
    } catch (e) {
        console.error("Test 3 FAILED:", e.message);
    }
})();
