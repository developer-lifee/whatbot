const fs = require('fs');
const path = require('path');
const { pool } = require('../database');

async function sync() {
    try {
        // 1. Sync fallback_template
        const templatePath = path.join(__dirname, '..', 'prompts', 'fallback_template.txt');
        if (fs.existsSync(templatePath)) {
            const promptContent = fs.readFileSync(templatePath, 'utf8');
            await pool.query(
                'INSERT INTO system_configs (cfg_key, cfg_value) VALUES ("fallback_template", ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
                [promptContent]
            );
            console.log("Successfully synced fallback_template in database.");
        }

        // 2. Sync initial_intent_prompt
        const indexFile = path.join(__dirname, '..', 'index.js');
        if (fs.existsSync(indexFile)) {
            const indexContent = fs.readFileSync(indexFile, 'utf8');
            // Extract DEFAULT_INITIAL_INTENT_PROMPT using regex
            const match = indexContent.match(/const DEFAULT_INITIAL_INTENT_PROMPT = `([\s\S]*?)`;/);
            if (match && match[1]) {
                const initialIntentPrompt = match[1];
                await pool.query(
                    'INSERT INTO system_configs (cfg_key, cfg_value) VALUES ("initial_intent_prompt", ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
                    [initialIntentPrompt]
                );
                console.log("Successfully synced initial_intent_prompt in database.");
            }
        }
        process.exit(0);
    } catch (err) {
        console.error("Error syncing prompts to database:", err);
        process.exit(1);
    }
}

sync();
