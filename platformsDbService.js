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

async function syncPriceToPublicCatalog(accountingPlatformName, newPrice) {
  await initPlatformsTables();
  const rawKey = (accountingPlatformName || '').toUpperCase().trim();
  const [plans] = await pool.query(`
    SELECT p.id as plan_id, p.name as plan_name, pl.id as platform_id, pl.name as platform_name 
    FROM platform_plans p 
    JOIN platforms pl ON p.platform_id = pl.id
  `);

  let targetPlan = null;

  // Reglas específicas de mapeo exacto
  if (rawKey === 'NETFLIX EXTRA') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('netflix') && p.plan_name.toLowerCase().includes('extra'));
  } else if (rawKey === 'NETFLIX') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('netflix') && (p.plan_name.toLowerCase().includes('4k') || !p.plan_name.toLowerCase().includes('extra')));
  } else if (rawKey === 'MICROSOFT COMPARTIDA') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('microsoft') && p.plan_name.toLowerCase().includes('compartida'));
  } else if (rawKey === 'MICROSOFT') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('microsoft') && p.plan_name.toLowerCase().includes('personal'));
  } else if (rawKey === 'GEMINI COMPARTIDA') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('gemini') && p.plan_name.toLowerCase().includes('compartida'));
  } else if (rawKey === 'GEMINI') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('gemini') && (p.plan_name.toLowerCase().includes('propio') || p.plan_name.toLowerCase().includes('personal')));
  } else if (rawKey === 'HBO PLATINO') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('hbo') && p.plan_name.toLowerCase().includes('platino'));
  } else if (rawKey === 'HBO') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('hbo') && p.plan_name.toLowerCase().includes('estándar'));
  } else if (rawKey === 'PLATZI COMPARTIDA') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('platzi') && p.plan_name.toLowerCase().includes('compartida'));
  } else if (rawKey === 'PLATZI') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('platzi') && !p.plan_name.toLowerCase().includes('compartida'));
  } else if (rawKey === 'APPLE ONE') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('apple') && p.plan_name.toLowerCase().includes('one'));
  } else if (rawKey === 'APPLE TV') {
    targetPlan = plans.find(p => p.platform_name.toLowerCase().includes('apple') && p.plan_name.toLowerCase().includes('tv'));
  } else {
    // Mapeo por similitud de nombre
    const cleanKey = rawKey.replace(/[^A-Z0-9]/g, '');
    targetPlan = plans.find(p => {
      const full = (p.platform_name + ' ' + p.plan_name).toUpperCase().replace(/[^A-Z0-9]/g, '');
      return full.includes(cleanKey) || cleanKey.includes(p.platform_name.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    });
  }

  if (targetPlan) {
    console.log(`[Sync Catalog] Sincronizando precio de ${rawKey} ($${newPrice}) con plan público "${targetPlan.platform_name} - ${targetPlan.plan_name}" (ID: ${targetPlan.plan_id})`);
    await updatePlanPriceInDb(targetPlan.plan_id, newPrice);
    return { success: true, planId: targetPlan.plan_id };
  } else {
    // Si no tiene plan específico, intentar buscar la plataforma directamente
    const [platforms] = await pool.query('SELECT id, name FROM platforms');
    const matchedPlat = platforms.find(pl => {
      const pClean = pl.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const kClean = rawKey.replace(/[^A-Z0-9]/g, '');
      return pClean.includes(kClean) || kClean.includes(pClean);
    });
    if (matchedPlat) {
      console.log(`[Sync Catalog] Sincronizando precio de ${rawKey} ($${newPrice}) con plataforma pública "${matchedPlat.name}" (ID: ${matchedPlat.id})`);
      await updatePlatformPriceInDb(matchedPlat.id, newPrice);
      return { success: true, platformId: matchedPlat.id };
    }
  }

  return { success: false, message: 'No matching public plan found' };
}

module.exports = {
  initPlatformsTables,
  seedPlatformsToDb,
  getPlatformsFromDb,
  updatePlanPriceInDb,
  updatePlatformPriceInDb,
  forceSyncJsonToDb,
  syncPriceToPublicCatalog
};
