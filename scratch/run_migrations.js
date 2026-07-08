const { pool } = require('../database');

async function run() {
  console.log("Running migrations...");
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streaming_prices (
          platform VARCHAR(100) PRIMARY KEY,
          normal_price DECIMAL(10, 2) NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    console.log("- Created table streaming_prices");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streaming_costs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          platform VARCHAR(100) NOT NULL,
          email VARCHAR(255) NOT NULL,
          total_cost DECIMAL(10, 2) NOT NULL,
          profile_slots INT DEFAULT 1,
          duration_days INT DEFAULT 30,
          expiration_date DATE NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("- Created table streaming_costs");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_flow_entries (
          id INT AUTO_INCREMENT PRIMARY KEY,
          type ENUM('income', 'expense') NOT NULL,
          platform VARCHAR(100) NULL,
          amount DECIMAL(10, 2) NOT NULL,
          description VARCHAR(255) NULL,
          entry_date DATE NOT NULL,
          is_automated TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("- Created table cash_flow_entries");

    // Insert mock or default prices from what the user had in the sheet if the table is empty
    const [existingPrices] = await pool.query('SELECT COUNT(*) as count FROM streaming_prices');
    if (existingPrices[0].count === 0) {
      const defaultPrices = [
        ['NETFLIX', 13000],
        ['AMAZON', 10000],
        ['DISNEY', 14000],
        ['HBO', 9000],
        ['PARAMOUNT', 18000],
        ['VIX', 4000],
        ['SPOTIFY', 10000],
        ['YOUTUBE', 12000],
        ['CRUNCHY ROLL', 7000],
        ['IPTV', 10000],
        ['XBOX', 30000],
        ['GPT', 20000],
        ['APPLE ONE', 21000],
        ['MICROSOFT', 12000],
        ['GEMINI', 20000],
        ['PLATZI', 50000],
        ['HBO PLATINO', 11000],
        ['NETFLIX EXTRA', 17000],
        ['GEMINI COMPARTIDA', 10000],
        ['CLAUDE', 20000],
        ['APPLE TV', 8000],
        ['MICROSOFT COMPARTIDA', 5000],
        ['GAMMA', 20000],
        ['CANVA', 10000],
        ['SPOTIFY OWNER', 8000],
        ['YOUTUBE OWNER', 11000],
        ['PLATZI COMPARTIDA', 20000]
      ];
      for (const [platform, price] of defaultPrices) {
        await pool.query('INSERT INTO streaming_prices (platform, normal_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE normal_price = ?', [platform, price, price]);
      }
      console.log("- Inserted default streaming prices");
    }

    console.log("Migrations completed successfully!");
  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    await pool.end();
  }
}

run();
