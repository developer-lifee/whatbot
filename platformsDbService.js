const { pool } = require('./database');
const fs = require('fs');
const path = require('path');

const LOCAL_JSON_PATH = path.join(__dirname, 'platforms.json');

let tablesInitialized = false;

async function initPlatformsTables() {
  if (tablesInitialized) return;
  try {
    // 1. Crear tabla platforms
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platforms (
        id INT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        image TEXT,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        characteristics JSON,
        discount_tier VARCHAR(10) DEFAULT 'A',
        display_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. Crear tabla platform_plans
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_plans (
        id INT PRIMARY KEY,
        platform_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        characteristics JSON,
        detalles TEXT,
        is_personal_email TINYINT(1) DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_platform (platform_id),
        FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. Verificar si hay plataformas en la BD
    const [existing] = await pool.query('SELECT COUNT(*) as count FROM platforms');
    if (existing[0].count === 0 && fs.existsSync(LOCAL_JSON_PATH)) {
      console.log('[Platforms DB] Seeding platforms and plans from platforms.json into MySQL...');
      const seedData = JSON.parse(fs.readFileSync(LOCAL_JSON_PATH, 'utf8'));
      await seedPlatformsToDb(seedData);
      console.log('[Platforms DB] ✅ Platforms and plans successfully seeded to DB.');
    }

    tablesInitialized = true;
  } catch (err) {
    console.error('[Platforms DB Init Error]:', err.message);
  }
}

async function seedPlatformsToDb(platformsArray) {
  for (let i = 0; i < platformsArray.length; i++) {
    const p = platformsArray[i];
    await pool.query(`
      INSERT INTO platforms (id, name, image, price, characteristics, discount_tier, display_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        image = VALUES(image),
        price = VALUES(price),
        characteristics = VALUES(characteristics),
        discount_tier = VALUES(discount_tier),
        display_order = VALUES(display_order);
    `, [
      p.id,
      p.name,
      p.image || '',
      p.price || 0,
      JSON.stringify(p.characteristics || []),
      p.discountTier || 'A',
      i
    ]);

    if (Array.isArray(p.plans) && p.plans.length > 0) {
      for (const pl of p.plans) {
        await pool.query(`
          INSERT INTO platform_plans (id, platform_id, name, price, characteristics, detalles, is_personal_email, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            price = VALUES(price),
            characteristics = VALUES(characteristics),
            detalles = VALUES(detalles),
            is_personal_email = VALUES(is_personal_email);
        `, [
          pl.id,
          p.id,
          pl.name,
          pl.price || 0,
          JSON.stringify(pl.characteristics || []),
          pl.detalles || '',
          pl.isPersonalEmail ? 1 : 0
        ]);
      }
    }
  }
}

async function getPlatformsFromDb() {
  try {
    await initPlatformsTables();

    const [platformRows] = await pool.query(
      'SELECT * FROM platforms WHERE is_active = 1 ORDER BY display_order ASC, id ASC'
    );

    if (!platformRows || platformRows.length === 0) {
      if (fs.existsSync(LOCAL_JSON_PATH)) {
        return JSON.parse(fs.readFileSync(LOCAL_JSON_PATH, 'utf8'));
      }
      return [];
    }

    const [planRows] = await pool.query(
      'SELECT * FROM platform_plans WHERE is_active = 1 ORDER BY platform_id ASC, id ASC'
    );

    const plansByPlatform = {};
    planRows.forEach(plan => {
      if (!plansByPlatform[plan.platform_id]) {
        plansByPlatform[plan.platform_id] = [];
      }
      let characteristics = [];
      try {
        characteristics = typeof plan.characteristics === 'string' ? JSON.parse(plan.characteristics) : (plan.characteristics || []);
      } catch (e) {
        characteristics = [];
      }

      plansByPlatform[plan.platform_id].push({
        id: plan.id,
        name: plan.name,
        price: parseFloat(plan.price),
        characteristics,
        detalles: plan.detalles || undefined,
        isPersonalEmail: Boolean(plan.is_personal_email)
      });
    });

    return platformRows.map(p => {
      let characteristics = [];
      try {
        characteristics = typeof p.characteristics === 'string' ? JSON.parse(p.characteristics) : (p.characteristics || []);
      } catch (e) {
        characteristics = [];
      }

      return {
        id: p.id,
        name: p.name,
        image: p.image,
        price: parseFloat(p.price),
        characteristics,
        discountTier: p.discount_tier || undefined,
        plans: plansByPlatform[p.id] || []
      };
    });
  } catch (err) {
    console.warn('[Platforms DB Fallback to JSON]:', err.message);
    if (fs.existsSync(LOCAL_JSON_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_JSON_PATH, 'utf8'));
    }
    return [];
  }
}

async function updatePlanPriceInDb(planId, newPrice) {
  await initPlatformsTables();
  await pool.query('UPDATE platform_plans SET price = ? WHERE id = ?', [newPrice, planId]);
  
  const [plan] = await pool.query('SELECT platform_id FROM platform_plans WHERE id = ?', [planId]);
  if (plan.length > 0) {
    const platformId = plan[0].platform_id;
    const [minPlan] = await pool.query('SELECT MIN(price) as min_price FROM platform_plans WHERE platform_id = ?', [platformId]);
    if (minPlan.length > 0 && minPlan[0].min_price) {
      await pool.query('UPDATE platforms SET price = ? WHERE id = ?', [minPlan[0].min_price, platformId]);
    }
  }
  return { success: true };
}

async function updatePlatformPriceInDb(platformId, newPrice) {
  await initPlatformsTables();
  await pool.query('UPDATE platforms SET price = ? WHERE id = ?', [newPrice, platformId]);
  return { success: true };
}

// Sincronizar masivamente toda la base de datos a partir del JSON (útil para forzar migración inicial)
async function forceSyncJsonToDb() {
  await initPlatformsTables();
  if (fs.existsSync(LOCAL_JSON_PATH)) {
    const seedData = JSON.parse(fs.readFileSync(LOCAL_JSON_PATH, 'utf8'));
    await seedPlatformsToDb(seedData);
    return { success: true, count: seedData.length };
  }
  return { success: false, message: 'JSON not found' };
}

module.exports = {
  initPlatformsTables,
  seedPlatformsToDb,
  getPlatformsFromDb,
  updatePlanPriceInDb,
  updatePlatformPriceInDb,
  forceSyncJsonToDb
};
