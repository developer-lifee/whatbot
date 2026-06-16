const { pool } = require('../database');

async function check() {
    try {
        const [rows] = await pool.query("DESCRIBE messages");
        console.log("COLUMNS IN messages TABLE:");
        console.log(rows);
    } catch (err) {
        console.error("Error checking DB:", err.message);
    } finally {
        process.exit(0);
    }
}

check();
