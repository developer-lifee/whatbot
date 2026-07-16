const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  console.log('Iniciando corrección de nómina...');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    // 1. Buscar el id del agente y su nómina actual
    const [agents] = await conn.query("SELECT id, fullname FROM agents WHERE email = 'esclepiades@hotmail.com'");
    if (agents.length === 0) {
      console.error('No se encontró el agente con email esclepiades@hotmail.com');
      return;
    }
    const agentId = agents[0].id;
    console.log(`Agente encontrado: ${agents[0].fullname} (ID: ${agentId})`);

    const month = '2026-07';
    const [payroll] = await conn.query("SELECT * FROM monthly_payroll WHERE agent_id = ? AND payroll_month = ?", [agentId, month]);
    if (payroll.length === 0) {
      console.error(`No se encontró registro de nómina cerrada para el mes ${month}`);
      return;
    }

    const current = payroll[0];
    console.log('Nómina actual:', current);

    // Descontar 2 días de 8 horas = 16 horas
    const newHours = Math.max(0, Number(current.total_hours) - 16);
    const newPayment = newHours * Number(current.hourly_rate) + Number(current.total_bonuses);

    console.log(`Nuevos valores calculados: Horas: ${newHours}, Pago: $${newPayment}`);

    // 2. Actualizar
    await conn.query(
      "UPDATE monthly_payroll SET total_hours = ?, total_payment = ? WHERE id = ?",
      [newHours, newPayment, current.id]
    );

    console.log('✅ Nómina corregida exitosamente.');
  } catch (err) {
    console.error('Error durante la corrección:', err);
  } finally {
    await conn.end();
  }
}

run();
