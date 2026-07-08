const { pool } = require('../database');

async function main() {
    try {
        const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "initial_intent_prompt"');
        if (rows && rows.length > 0) {
            console.log("DATABASE VALUE FOUND:\n", rows[0].cfg_value);
        } else {
            console.log("No config found in database.");
        }
    } catch (err) {
        console.error("Error reading db:", err.message);
    } finally {
        await pool.end();
    }
}

main();
