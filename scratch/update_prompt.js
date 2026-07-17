const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function run() {
  console.log('Iniciando actualización de la plantilla de prompts en producción...');
  
  const templatePath = path.join(__dirname, '..', 'prompts', 'fallback_template.txt');
  if (!fs.existsSync(templatePath)) {
    console.error('No se encontró la plantilla local en:', templatePath);
    return;
  }
  const promptContent = fs.readFileSync(templatePath, 'utf8');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const [result] = await conn.query(
      "UPDATE system_configs SET cfg_value = ? WHERE cfg_key = 'fallback_template'",
      [promptContent]
    );
    console.log('✅ Base de datos actualizada con éxito. Afectado:', result.affectedRows);
  } catch (err) {
    console.error('Error durante la actualización:', err);
  } finally {
    await conn.end();
  }
}

run();
