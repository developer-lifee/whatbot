const fs = require('fs');
const path = require('path');

try {
    const statesFile = path.join(__dirname, 'user_states.json');
    if (fs.existsSync(statesFile)) {
        const data = JSON.parse(fs.readFileSync(statesFile, 'utf8'));
        console.log("=== TOTAL USER STATES IN DISK ===", Object.keys(data).length);
        const waitingHuman = Object.entries(data).filter(([k, v]) => v.state === 'waiting_human');
        console.log("=== WAITING HUMAN COUNT ===", waitingHuman.length);
        console.log("=== LAST 5 WAITING HUMAN STATES ===");
        console.log(waitingHuman.slice(-5));
    } else {
        console.log("user_states.json does not exist");
    }
} catch (e) {
    console.error("Error reading states:", e);
} finally {
    process.exit(0);
}
