// Test sending message via API or process
const http = require('http');

http.get('http://localhost:3000/api/whatsapp/status', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log("=== API STATUS RESPONSE ===");
        console.log(data);
        process.exit(0);
    });
}).on('error', (err) => {
    console.error("API Request Error:", err);
    process.exit(1);
});
