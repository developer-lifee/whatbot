const fs = require('fs');
const path = require('path');
const { pool } = require('../database');

async function sync() {
    try {
        const templatePath = path.join(__dirname, '..', 'prompts', 'fallback_template.txt');
        if (!fs.existsSync(templatePath)) {
            console.error("Local template file not found!");
            process.exit(1);
        }
        const promptContent = fs.readFileSync(templatePath, 'utf8');
        
        // Check if row exists
        const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "fallback_template"');
        if (rows && rows.length > 0) {
            await pool.query('UPDATE system_configs SET cfg_value = ? WHERE cfg_key = "fallback_template"', [promptContent]);
            console.log("Successfully updated fallback_template in database.");
        } else {
            await pool.query('INSERT INTO system_configs (cfg_key, cfg_value) VALUES ("fallback_template", ?)', [promptContent]);
            console.log("Successfully inserted fallback_template into database.");
        }
        process.exit(0);
    } catch (err) {
        console.error("Error syncing prompt to database:", err);
        process.exit(1);
    }
}

sync();
