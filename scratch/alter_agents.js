const { pool } = require('../database');

async function run() {
  console.log("Altering agents table...");
  try {
    // Alter agent role enum to include 'trial'
    await pool.query(`
      ALTER TABLE agents MODIFY COLUMN role ENUM('admin', 'agent', 'supervisor', 'trial') DEFAULT 'agent'
    `);
    console.log("- Altered agents role enum");

    // Add trial_hourly_rate default if needed to support_schedule.json
    console.log("Database alteration complete!");
  } catch (err) {
    console.error("Alter error:", err);
  } finally {
    await pool.end();
  }
}

run();
