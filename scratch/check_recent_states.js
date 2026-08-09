const fs = require('fs');
const path = require('path');

try {
    const statesFile = path.join(__dirname, 'user_states.json');
    if (fs.existsSync(statesFile)) {
        const data = JSON.parse(fs.readFileSync(statesFile, 'utf8'));
        const now = Date.now();
        console.log("=== STATES UPDATED IN LAST 60 MINUTES ===");
        const recent = Object.entries(data).filter(([k, v]) => {
            const t = v.lastHumanInteraction || v.lastMessageTime || v.waitingTimestamp || 0;
            return (now - t) < 60 * 60 * 1000;
        });
        console.log(recent);
    }
} catch (e) {
    console.error("Error:", e);
} finally {
    process.exit(0);
}
