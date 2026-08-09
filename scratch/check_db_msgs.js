const { pool } = require('./database');

async function checkRecentMsgs() {
    try {
        const [rows] = await pool.query('SELECT * FROM messages ORDER BY id DESC LIMIT 10');
        console.log("=== LATEST 10 MESSAGES IN DB ===");
        console.log(rows);
    } catch (err) {
        console.error("DB Error:", err);
    } finally {
        process.exit(0);
    }
}

checkRecentMsgs();
