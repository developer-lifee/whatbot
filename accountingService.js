const { pool } = require('./database');
const { fetchCustomersData, getJsDateFromExcel } = require('./apiService');

const SEED_STREAMING_COSTS = [
  { platform: 'AMAZON', email: 'Alzap1479@gmail.com', total_cost: 14000, profile_slots: 6, duration_days: 30, expiration_date: '2024-06-15' },
  { platform: 'CRUNCHY ROLL', email: 'gagwgwaggwf@spotinetshop.com', total_cost: 14900, profile_slots: 5, duration_days: 30, expiration_date: '2024-06-16' },
  { platform: 'DISNEY', email: 'combitds@spotinetonline.org', total_cost: 18000, profile_slots: 7, duration_days: 30, expiration_date: '2024-06-18' },
  { platform: 'HBO', email: '2377eb6a@spotinetshop.com', total_cost: 15000, profile_slots: 5, duration_days: 30, expiration_date: '2024-06-23' },
  { platform: 'NETFLIX', email: 'bohrdavidaviladaza@gmail.com', total_cost: 64700, profile_slots: 7, duration_days: 30, expiration_date: '2024-06-30' },
  { platform: 'SPOTIFY', email: 'alep2037@yopmail.com', total_cost: 30500, profile_slots: 5, duration_days: 30, expiration_date: '2024-07-18' },
  { platform: 'VIX', email: 'combitds@spotinetonline.org', total_cost: 5000, profile_slots: 7, duration_days: 30, expiration_date: '2024-08-03' },
  { platform: 'PARAMOUNT', email: 'spotinetparamoun919822@spotinetshop.com', total_cost: 23900, profile_slots: 3, duration_days: 30, expiration_date: '2024-07-05' },
  { platform: 'IPTV', email: 'http://tvpro.tech:8080', total_cost: 5000, profile_slots: 5, duration_days: 30, expiration_date: '2024-06-16' },
  { platform: 'GPT', email: 'Alzap1479@gmail.com', total_cost: 85000, profile_slots: 9, duration_days: 31, expiration_date: '2026-11-28' },
  { platform: 'CHATGPT PLUS (4X A 6X)', email: 'sheeritdediagama@gmail.com', total_cost: 85000, profile_slots: 4, duration_days: 31, expiration_date: '2026-12-06' },
  { platform: 'CHATGPT PRO ($100 USD)', email: 'sheeritdediagama@gmail.com', total_cost: 420000, profile_slots: 5, duration_days: 31, expiration_date: null },
  { platform: 'CHATGPT PRO SCALE ($200 USD)', email: 'jordimemesmomazosdick@gmail.com', total_cost: 840000, profile_slots: 5, duration_days: 31, expiration_date: null },
  { platform: 'YOUTUBE', email: 'Sheerstreaming@gmail.com', total_cost: 41900, profile_slots: 6, duration_days: 32, expiration_date: '2024-06-18' },
  { platform: 'APPLE ONE', email: '', total_cost: 83900, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'MICROSOFT', email: '', total_cost: 46000, profile_slots: 5, duration_days: 31, expiration_date: null },
  { platform: 'GEMINI', email: 'discoveryrelesbiana@gmail.com', total_cost: 79900, profile_slots: 5, duration_days: 32, expiration_date: null },
  { platform: 'PLATZI', email: '', total_cost: 169154, profile_slots: 3, duration_days: 90, expiration_date: null },
  { platform: 'NETFLIX EXTRA', email: '', total_cost: 9900, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'HBO PLATINO', email: '', total_cost: 30000, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'APPLE TV', email: '', total_cost: 0, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'MICROSOFT COMPARTIDA', email: '', total_cost: 0, profile_slots: 1, duration_days: 31, expiration_date: null },
  { platform: 'GEMINI COMPARTIDA', email: '', total_cost: 0, profile_slots: 1, duration_days: 31, expiration_date: null },
  { platform: 'CANVA', email: '', total_cost: 5000, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'SPOTIFY OWNER', email: '', total_cost: 0, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'YOUTUBE OWNER', email: '', total_cost: 0, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'CLAUDE', email: 'angirosagptplus@gmail.com', total_cost: 85000, profile_slots: 8, duration_days: 31, expiration_date: '2026-10-29' },
  { platform: 'CLAUDE X2', email: 'nigadiagama@gmail.com', total_cost: 85000, profile_slots: 5, duration_days: 31, expiration_date: '2026-11-14' },
  { platform: 'CLAUDE MAX X5', email: 'sheeritdediagama@gmail.com', total_cost: 420000, profile_slots: 5, duration_days: 31, expiration_date: '2026-10-02' },
  { platform: 'CLAUDE MAX', email: 'jordimemesmomazosdick@gmail.com', total_cost: 840000, profile_slots: 8, duration_days: 31, expiration_date: '2026-10-01' },
  { platform: 'PLATZI COMPARTIDA', email: '', total_cost: 0, profile_slots: 5, duration_days: 30, expiration_date: null }
];

const SEED_STREAMING_PRICES = [
  { platform: 'NETFLIX', normal_price: 13000 },
  { platform: 'NETFLIX EXTRA', normal_price: 17000 },
  { platform: 'DISNEY', normal_price: 14000 },
  { platform: 'HBO', normal_price: 8000 },
  { platform: 'HBO PLATINO', normal_price: 11000 },
  { platform: 'AMAZON', normal_price: 10000 },
  { platform: 'SPOTIFY', normal_price: 8000 },
  { platform: 'SPOTIFY OWNER', normal_price: 8000 },
  { platform: 'YOUTUBE', normal_price: 12000 },
  { platform: 'YOUTUBE OWNER', normal_price: 12000 },
  { platform: 'GPT', normal_price: 20000 },
  { platform: 'CHATGPT PLUS (4X A 6X)', normal_price: 35000 },
  { platform: 'CHATGPT PRO ($100 USD)', normal_price: 120000 },
  { platform: 'CHATGPT PRO SCALE ($200 USD)', normal_price: 190000 },
  { platform: 'CLAUDE', normal_price: 20000 },
  { platform: 'CLAUDE X2', normal_price: 35000 },
  { platform: 'CLAUDE MAX X5', normal_price: 120000 },
  { platform: 'CLAUDE MAX', normal_price: 250000 },
  { platform: 'GEMINI', normal_price: 22000 },
  { platform: 'GEMINI COMPARTIDA', normal_price: 10000 },
  { platform: 'APPLE ONE', normal_price: 22000 },
  { platform: 'APPLE TV', normal_price: 8000 },
  { platform: 'PARAMOUNT', normal_price: 8000 },
  { platform: 'CRUNCHY ROLL', normal_price: 7000 },
  { platform: 'VIX', normal_price: 7000 },
  { platform: 'CANVA', normal_price: 7000 },
  { platform: 'MICROSOFT', normal_price: 13000 },
  { platform: 'MICROSOFT COMPARTIDA', normal_price: 5000 },
  { platform: 'PLATZI', normal_price: 150000 },
  { platform: 'PLATZI COMPARTIDA', normal_price: 20000 },
  { platform: 'IPTV', normal_price: 10000 }
];

let tablesInitialized = false;
async function initAccountingTables() {
  if (tablesInitialized) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streaming_prices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        platform VARCHAR(100) UNIQUE NOT NULL,
        normal_price DECIMAL(10,2) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS streaming_costs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        platform VARCHAR(100) NOT NULL,
        email VARCHAR(255) NULL DEFAULT '',
        provider VARCHAR(100) NULL,
        total_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
        profile_slots INT NOT NULL DEFAULT 1,
        duration_days INT NOT NULL DEFAULT 30,
        expiration_date DATE NULL,
        payment_method VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await pool.query('ALTER TABLE streaming_costs MODIFY COLUMN email VARCHAR(255) NULL DEFAULT \'\'');
    } catch (alterErr) { /* ya es nullable */ }

    try {
      const [costCols] = await pool.query("SHOW COLUMNS FROM streaming_costs");
      if (!costCols.some(c => c.Field === 'provider')) {
        await pool.query("ALTER TABLE streaming_costs ADD COLUMN provider VARCHAR(100) NULL AFTER email");
      }
      if (costCols.some(c => c.Field === 'payment_method' && c.Type.includes('100'))) {
        await pool.query("ALTER TABLE streaming_costs MODIFY COLUMN payment_method VARCHAR(255) NULL");
      }
    } catch (colErr) { /* ignore */ }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_renewals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        platform VARCHAR(100) NOT NULL,
        account_email VARCHAR(255) NOT NULL,
        provider VARCHAR(100) NULL,
        payment_method VARCHAR(255) NULL,
        amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
        renewal_date DATE NOT NULL,
        expiration_date DATE NOT NULL,
        duration_days INT NOT NULL DEFAULT 30,
        profile_slots INT NOT NULL DEFAULT 1,
        notes TEXT NULL,
        registered_by VARCHAR(100) NULL,
        sync_to_cash_flow TINYINT(1) DEFAULT 1,
        cash_flow_entry_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_flow_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type ENUM('income', 'expense') NOT NULL,
        platform VARCHAR(100) NULL,
        amount DECIMAL(12,2) NOT NULL,
        description TEXT,
        entry_date DATE NOT NULL,
        is_automated TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Sembrar precios (upsert para tener todas las plataformas cubiertas)
    for (const p of SEED_STREAMING_PRICES) {
      await pool.query(
        'INSERT INTO streaming_prices (platform, normal_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE normal_price = ?',
        [p.platform, p.normal_price, p.normal_price]
      );
    }

    // Sembrar costos maestros de streaming si no existen
    for (const c of SEED_STREAMING_COSTS) {
      const [existing] = await pool.query('SELECT id FROM streaming_costs WHERE platform = ? LIMIT 1', [c.platform]);
      if (existing.length === 0) {
        await pool.query(
          'INSERT INTO streaming_costs (platform, email, total_cost, profile_slots, duration_days, expiration_date) VALUES (?, ?, ?, ?, ?, ?)',
          [c.platform, c.email || '', c.total_cost, c.profile_slots, c.duration_days, c.expiration_date || null]
        );
      }
    }

    tablesInitialized = true;
  } catch (err) {
    console.error('[Accounting Tables Init Error]:', err.message);
  }
}

/**
 * Obtiene la lista de precios configurados
 */
async function getPrices() {
  await initAccountingTables();
  const [rows] = await pool.query('SELECT * FROM streaming_prices ORDER BY platform ASC');
  return rows;
}

/**
 * Guarda o actualiza un precio
 */
async function savePrice(platform, normalPrice) {
  await initAccountingTables();
  await pool.query(
    'INSERT INTO streaming_prices (platform, normal_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE normal_price = ?',
    [platform.toUpperCase(), normalPrice, normalPrice]
  );
  return { success: true };
}

/**
 * Obtiene la lista de costos configurados
 */
async function getCosts() {
  await initAccountingTables();
  const [rows] = await pool.query('SELECT * FROM streaming_costs ORDER BY platform ASC');
  return rows;
}

/**
 * Guarda o actualiza un costo
 */
async function saveCost(data) {
  await initAccountingTables();
  const { id, platform, email, provider, total_cost, profile_slots, duration_days, expiration_date, payment_method } = data;
  if (id) {
    await pool.query(
      'UPDATE streaming_costs SET platform = ?, email = ?, provider = ?, total_cost = ?, profile_slots = ?, duration_days = ?, expiration_date = ?, payment_method = ? WHERE id = ?',
      [platform.toUpperCase(), email, provider || null, total_cost, profile_slots || 1, duration_days || 30, expiration_date || null, payment_method || null, id]
    );
  } else {
    await pool.query(
      'INSERT INTO streaming_costs (platform, email, provider, total_cost, profile_slots, duration_days, expiration_date, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [platform.toUpperCase(), email, provider || null, total_cost, profile_slots || 1, duration_days || 30, expiration_date || null, payment_method || null]
    );
  }
  return { success: true };
}

/**
 * Elimina un costo
 */
async function deleteCost(id) {
  await pool.query('DELETE FROM streaming_costs WHERE id = ?', [id]);
  return { success: true };
}

/**
 * Registra la renovación y pago exacto de una cuenta matriz
 * Almacena el monto real (sube/baja por promoción), proveedor, tarjeta/método, fecha vencimiento
 * y lo conecta con el flujo de caja contable (egreso real de dinero).
 */
async function recordAccountRenewal(data) {
  await initAccountingTables();
  const {
    platform,
    account_email,
    provider,
    payment_method,
    amount_paid,
    renewal_date,
    expiration_date,
    duration_days = 30,
    profile_slots = 5,
    notes = '',
    registered_by = 'Asesor',
    sync_to_cash_flow = true,
    sync_to_excel = false
  } = data;

  if (!platform || !account_email || !renewal_date || !expiration_date) {
    throw new Error('Faltan datos requeridos (plataforma, correo, fecha renovación, fecha vencimiento).');
  }

  const cleanPlat = platform.trim().toUpperCase();
  const cleanEmail = account_email.trim();
  const paidAmount = parseFloat(amount_paid) || 0;

  let cashFlowEntryId = null;

  // 1. Asentar egreso real en flujo de caja contable si está marcado
  if (sync_to_cash_flow && paidAmount > 0) {
    const desc = `Renovación cuenta ${cleanPlat} (${cleanEmail}) | Prov: ${provider || 'Directo'} | Pago: ${payment_method || 'N/A'}`;
    const [resCf] = await pool.query(
      'INSERT INTO cash_flow_entries (type, platform, amount, description, entry_date, is_automated) VALUES (?, ?, ?, ?, ?, ?)',
      ['expense', cleanPlat, paidAmount, desc, renewal_date, 1]
    );
    cashFlowEntryId = resCf.insertId;
  }

  // 2. Insertar registro histórico en account_renewals
  const [resRen] = await pool.query(
    `INSERT INTO account_renewals 
     (platform, account_email, provider, payment_method, amount_paid, renewal_date, expiration_date, duration_days, profile_slots, notes, registered_by, sync_to_cash_flow, cash_flow_entry_id) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cleanPlat,
      cleanEmail,
      provider ? provider.trim() : null,
      payment_method ? payment_method.trim() : null,
      paidAmount,
      renewal_date,
      expiration_date,
      duration_days || 30,
      profile_slots || 1,
      notes || null,
      registered_by || null,
      sync_to_cash_flow ? 1 : 0,
      cashFlowEntryId
    ]
  );

  // 3. Sincronizar / actualizar tabla base de costos de streaming (streaming_costs)
  const [costRows] = await pool.query(
    'SELECT id FROM streaming_costs WHERE UPPER(platform) = ? AND LOWER(email) = ?',
    [cleanPlat, cleanEmail.toLowerCase()]
  );
  if (costRows.length > 0) {
    await pool.query(
      `UPDATE streaming_costs 
       SET total_cost = ?, expiration_date = ?, provider = ?, payment_method = ?, duration_days = ?, profile_slots = ? 
       WHERE id = ?`,
      [paidAmount, expiration_date, provider || null, payment_method || null, duration_days || 30, profile_slots || 1, costRows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO streaming_costs 
       (platform, email, provider, total_cost, profile_slots, duration_days, expiration_date, payment_method) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanPlat, cleanEmail, provider || null, paidAmount, profile_slots || 1, duration_days || 30, expiration_date, payment_method || null]
    );
  }

  // 4. Sincronización opcional hacia Excel Online (OneDrive Graph) si está activo
  let excelUpdatedRows = 0;
  if (sync_to_excel) {
    try {
      const { fetchCustomersData, writeRowToGraphDirect } = require('./apiService');
      const allCustomers = await fetchCustomersData();
      const matching = allCustomers.filter(c => (c.correo || '').trim().toLowerCase() === cleanEmail.toLowerCase());
      
      const combinedPaymentMethod = provider 
        ? `${provider.trim()} - ${payment_method ? payment_method.trim() : ''}`.trim()
        : (payment_method ? payment_method.trim() : '');

      for (const row of matching) {
        if (row.rowNumber) {
          const updates = {
            vencimiento: expiration_date
          };
          if (combinedPaymentMethod) {
            updates["Metodo de pago"] = combinedPaymentMethod;
          }
          await writeRowToGraphDirect(row.rowNumber, updates);
          excelUpdatedRows++;
        }
      }
    } catch (err) {
      console.error('[Account Renewal] Error sincronizando a Excel Online:', err.message);
    }
  }

  return {
    success: true,
    renewal_id: resRen.insertId,
    cash_flow_entry_id: cashFlowEntryId,
    excel_updated_rows: excelUpdatedRows,
    message: 'Renovación de cuenta registrada exitosamente.'
  };
}

/**
 * Obtiene el historial de renovaciones de cuentas
 */
async function getAccountRenewals(filters = {}) {
  await initAccountingTables();
  let query = 'SELECT * FROM account_renewals WHERE 1=1';
  const params = [];

  if (filters.platform) {
    query += ' AND platform = ?';
    params.push(filters.platform.toUpperCase().trim());
  }
  if (filters.month && filters.year) {
    query += ' AND MONTH(renewal_date) = ? AND YEAR(renewal_date) = ?';
    params.push(filters.month, filters.year);
  } else if (filters.year) {
    query += ' AND YEAR(renewal_date) = ?';
    params.push(filters.year);
  }

  query += ' ORDER BY renewal_date DESC, id DESC LIMIT ?';
  params.push(parseInt(filters.limit) || 100);

  const [rows] = await pool.query(query, params);
  return rows;
}

/**
 * Elimina un registro de renovación de cuenta y revierte el egreso en flujo de caja si existía
 */
async function deleteAccountRenewal(id) {
  await initAccountingTables();
  const [rows] = await pool.query('SELECT cash_flow_entry_id FROM account_renewals WHERE id = ?', [id]);
  if (rows.length > 0 && rows[0].cash_flow_entry_id) {
    await pool.query('DELETE FROM cash_flow_entries WHERE id = ?', [rows[0].cash_flow_entry_id]);
  }
  await pool.query('DELETE FROM account_renewals WHERE id = ?', [id]);
  return { success: true };
}

/**
 * Registra una transacción de flujo de caja real
 */
async function addTransaction(type, platform, amount, description, entryDate, isAutomated = 0) {
  await pool.query(
    'INSERT INTO cash_flow_entries (type, platform, amount, description, entry_date, is_automated) VALUES (?, ?, ?, ?, ?, ?)',
    [type, platform ? platform.toUpperCase() : null, amount, description, entryDate, isAutomated]
  );
  return { success: true };
}

/**
 * Obtiene las transacciones reales de flujo de caja para un rango de fechas
 */
async function getTransactions(startDate, endDate) {
  const [rows] = await pool.query(
    'SELECT * FROM cash_flow_entries WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, id DESC',
    [startDate, endDate]
  );
  return rows;
}

function normalizePlatformKey(raw) {
  if (!raw) return 'OTROS';
  const clean = raw.toUpperCase().trim();
  if (clean.includes('AMAZON') || clean.includes('PRIME')) return 'AMAZON';
  if (clean.includes('DISNEY')) return 'DISNEY';
  if (clean.includes('CLAUDE')) {
    if (clean.includes('X5') || clean.includes('5X') || clean.includes('20X') || clean.includes('25X') || clean.includes('100')) {
      return 'CLAUDE MAX X5';
    }
    if (clean.includes('MAX') || clean.includes('50X') || clean.includes('100X') || clean.includes('200') || clean.includes('SCALE')) {
      return 'CLAUDE MAX';
    }
    if (clean.includes('X2') || clean.includes('2X') || clean.includes('4X') || clean.includes('6X')) {
      return 'CLAUDE X2';
    }
    return 'CLAUDE';
  }
  if (clean.includes('HBO') || (clean.includes('MAX') && !clean.includes('CLAUDE'))) {
    if (clean.includes('PLATINO')) return 'HBO PLATINO';
    return 'HBO';
  }
  if (clean.includes('NETFLIX')) {
    if (clean.includes('EXTRA') || clean.includes('MIEMBRO')) return 'NETFLIX EXTRA';
    return 'NETFLIX';
  }
  if (clean.includes('SPOTIFY')) {
    if (clean.includes('OWNER') || clean.includes('DUEÑO') || clean.includes('FAMILIAR')) return 'SPOTIFY OWNER';
    return 'SPOTIFY';
  }
  if (clean.includes('YOUTUBE')) {
    if (clean.includes('OWNER') || clean.includes('FAMILIAR')) return 'YOUTUBE OWNER';
    return 'YOUTUBE';
  }
  if (clean.includes('APPLE')) {
    if (clean.includes('ONE')) return 'APPLE ONE';
    return 'APPLE TV';
  }
  if (clean.includes('CRUNCHY')) return 'CRUNCHY ROLL';
  if (clean.includes('VIX')) return 'VIX';
  if (clean.includes('CANVA')) return 'CANVA';
  if (clean.includes('MICROSOFT') || clean.includes('OFFICE') || clean.includes('365')) {
    if (clean.includes('COMPARTIDA')) return 'MICROSOFT COMPARTIDA';
    return 'MICROSOFT';
  }
  if (clean.includes('PLATZI')) {
    if (clean.includes('COMPARTIDA')) return 'PLATZI COMPARTIDA';
    return 'PLATZI';
  }
  if (clean.includes('GAMMA')) return 'GAMMA';
  if (clean.includes('GEMINI')) {
    if (clean.includes('COMPARTIDA')) return 'GEMINI COMPARTIDA';
    return 'GEMINI';
  }
  if (clean.includes('GPT') || clean.includes('CHATGPT')) {
    if (clean.includes('200') || clean.includes('SCALE') || clean.includes('50X') || clean.includes('100X')) {
      return 'CHATGPT PRO SCALE ($200 USD)';
    }
    if (clean.includes('100') || clean.includes('20X') || clean.includes('25X') || (clean.includes('PRO') && !clean.includes('PLUS'))) {
      return 'CHATGPT PRO ($100 USD)';
    }
    if (clean.includes('4X') || clean.includes('6X') || clean.includes('X2') || clean.includes('PLUS')) {
      return 'CHATGPT PLUS (4X A 6X)';
    }
    return 'GPT';
  }
  if (clean.includes('IPTV')) return 'IPTV';
  if (clean.includes('XBOX')) return 'XBOX';
  return clean;
}

/**
 * Convierte un cobro bruto de pasarela web (con comisión Bold) al precio base aproximado del plan
 */
function normalizeWebSaleToPlanPrice(grossAmount) {
  const amt = parseFloat(grossAmount) || 0;
  if (amt <= 0) return 0;
  if (amt >= 20000 && amt <= 23500) return 20000;
  if (amt >= 30000 && amt <= 34000) return 30000;
  if (amt >= 34500 && amt <= 39500) return 35000;
  if (amt >= 58000 && amt <= 66000) return 60000;
  if (amt >= 115000 && amt <= 132000) return 120000;
  if (amt >= 180000 && amt <= 210000) return 190000;
  if (amt >= 240000 && amt <= 270000) return 250000;
  return Math.round((amt * (1 - 0.03904)) - 900);
}

/**
 * Calcula la contabilidad consolidando:
 * 1. Clientes activos (ingreso diario normalizado con combos reales y verificación de pago real en subplanes de IA).
 * 2. Costos de perfiles/cuentas activas (egreso diario normalizado y modelo Excel con conteo real de cuentas matriz).
 * 3. Transacciones reales de cash_flow_entries registradas en el día.
 * 4. Auditoría de Red Flags para cuentas de alto costo ($100 USD / $200 USD) con déficit o clientes sub-facturados.
 */
async function calculateDailyAccounting() {
  const prices = await getPrices();
  const costs = await getCosts();
  const clients = await fetchCustomersData();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Cargar historial de ventas web aprobadas para cruzar cuánto pagó realmente cada cliente en subplanes de Claude/GPT
  const webSalesByPhone = {};
  try {
    const [webSales] = await pool.query(
      'SELECT whatsapp, platformName, amount, approvedAt FROM web_sales_approved ORDER BY approvedAt DESC'
    );
    webSales.forEach(s => {
      const digits = String(s.whatsapp || '').replace(/\D/g, '').slice(-10);
      if (digits.length >= 7) {
        if (!webSalesByPhone[digits]) webSalesByPhone[digits] = [];
        webSalesByPhone[digits].push(s);
      }
    });
  } catch (err) {
    console.warn('[Accounting] No se pudo consultar web_sales_approved para cruce de subplanes:', err.message);
  }

  // Crear mapas rápidos para búsqueda
  const priceMap = {};
  prices.forEach(p => {
    const normKey = normalizePlatformKey(p.platform);
    priceMap[normKey] = parseFloat(p.normal_price);
    priceMap[p.platform.toUpperCase().trim()] = parseFloat(p.normal_price);
  });

  const dailyAccounting = {};

  // Inicializar todas las plataformas conocidas con valores en cero
  prices.forEach(p => {
    const plat = normalizePlatformKey(p.platform);
    if (!dailyAccounting[plat]) {
      dailyAccounting[plat] = {
        platform: plat,
        ingreso_total: 0,
        egreso_total: 0,
        ganancia_porcentaje: 0,
        egreso_porcentaje: 0,
        utilidad_total: 0,
        indicador_gan: 0,
        active_profiles: 0
      };
    }
  });

  // Contabilizar también todas las filas (ocupadas o libres) por cuenta matriz para auditoría de stock y costo real
  const masterAccountsInventory = {};
  const distinctMasterEmailsByPlat = {};
  clients.forEach(c => {
    const rawStream = (c.Streaming || '').toString().trim();
    const rawEmail = (c.correo || '').toString().trim().toLowerCase();
    if (!rawStream) return;
    const platKey = normalizePlatformKey(rawStream);
    if (rawEmail && !rawEmail.startsWith('http')) {
      if (!distinctMasterEmailsByPlat[platKey]) distinctMasterEmailsByPlat[platKey] = new Set();
      distinctMasterEmailsByPlat[platKey].add(rawEmail);

      const invKey = `${platKey}::${rawEmail}`;
      if (!masterAccountsInventory[invKey]) {
        masterAccountsInventory[invKey] = {
          platform: platKey,
          email: (c.correo || '').toString().trim(),
          total_slots: 0,
          occupied_slots: 0,
          expiration_date: c.vencimiento || null,
          clients: []
        };
      }
      masterAccountsInventory[invKey].total_slots += 1;
    }
  });

  // 1. Filtrar clientes activos
  const activeClients = [];
  clients.forEach(c => {
    const clientNameStr = (c.Nombre || c.nombre || '').toString().trim();
    const clientPhoneStr = (c.whatsapp || c.numero || '').toString().trim();
    // Un cupo está ocupado por un cliente si tiene nombre (distinto de 'libre') o teléfono
    const hasClientOccupant = Boolean(
      (clientNameStr && clientNameStr.toLowerCase() !== 'libre') ||
      clientPhoneStr
    );
    const hasStreaming = Boolean((c.Streaming || '').toString().trim());
    if (!hasClientOccupant || !hasStreaming) {
      return;
    }

    const dateVal = c.deben || c.vencimiento;
    let isActive = false;
    if (dateVal) {
      const venc = getJsDateFromExcel(dateVal);
      if (venc && !isNaN(venc.getTime())) {
        venc.setHours(0, 0, 0, 0);
        if (venc.getTime() >= now.getTime()) {
          isActive = true;
        }
      }
    } else {
      isActive = true;
    }
    if (isActive) activeClients.push(c);
  });

  // 2. Agrupar por cliente para detectar combos reales
  const clientGroups = {};
  activeClients.forEach(c => {
    const phone = String(c.numero || c.whatsapp || '').replace(/\D/g, '').slice(-10);
    const key = phone.length >= 7 ? phone : (c.Nombre || c.nombre || 'cliente_general');
    if (!clientGroups[key]) clientGroups[key] = [];
    clientGroups[key].push(c);
  });

  // Control para CLAUDE MAX ($200 USD): sabemos que en jordimemesmomazosdick@gmail.com solo 1 persona sin registro web pagó los $250.000 COP
  let claudeMaxFullPayerCounted = false;

  // 3. Procesar cada grupo de cliente aplicando la regla de descuento de combo y cruce real de subplanes
  Object.values(clientGroups).forEach(group => {
    const isCombo = group.length > 1;
    group.forEach((c, idx) => {
      const platKey = normalizePlatformKey(c.Streaming);
      const phoneDigits = String(c.numero || c.whatsapp || '').replace(/\D/g, '').slice(-10);
      const rawEmail = (c.correo || '').toString().trim().toLowerCase();

      // Prioridad 1: Tomar precio individual de la fila del cliente si existe en Excel (Ingreso Mensual2)
      let rowPrice = 0;
      const rawPriceVal = c['Ingreso Mensual2'] || c['ingreso mensual'] || c.precio || c.Precio || c.valor || c.Valor || c['precio cobrado'];
      if (rawPriceVal && !String(rawPriceVal).includes('#N/A')) {
        const rawP = String(rawPriceVal).replace(/[^\d.]/g, '');
        rowPrice = parseFloat(rawP) || 0;
      }

      let price = rowPrice;
      let paymentSource = rowPrice > 0 ? 'Excel' : 'Catálogo';

      // Prioridad 2: En subplanes de Claude y ChatGPT (donde Excel tiene #N/A), cruzar con el pago real del cliente
      const isAiSubplan = ['CLAUDE', 'CLAUDE X2', 'CLAUDE MAX X5', 'CLAUDE MAX', 'GPT', 'CHATGPT PLUS (4X A 6X)', 'CHATGPT PRO ($100 USD)', 'CHATGPT PRO SCALE ($200 USD)'].includes(platKey);
      if (price <= 0 && isAiSubplan) {
        const clientSales = phoneDigits.length >= 7 ? (webSalesByPhone[phoneDigits] || []) : [];
        const isClaudePlat = platKey.includes('CLAUDE');
        const matchingSale = clientSales.find(s => {
          const pName = (s.platformName || '').toUpperCase();
          return isClaudePlat ? pName.includes('CLAUDE') : (pName.includes('GPT') || pName.includes('CHATGPT'));
        });

        if (matchingSale) {
          // Si fue un combo en una sola orden (ej. YouTube + Claude Max = 74821), descontar el otro servicio
          const pNameUpper = (matchingSale.platformName || '').toUpperCase();
          if (pNameUpper.includes(',') && matchingSale.amount > 65000 && matchingSale.amount < 80000) {
            price = 60000;
          } else {
            price = normalizeWebSaleToPlanPrice(matchingSale.amount);
          }
          paymentSource = `Pago Web ($${Number(matchingSale.amount).toLocaleString('es-CO')})`;
        } else if (platKey === 'CLAUDE MAX') {
          // En CLAUDE MAX (jordimemesmomazosdick@gmail.com - $200 USD), solo 1 cliente pagó los $250.000 COP completos
          if (!claudeMaxFullPayerCounted) {
            price = 250000;
            claudeMaxFullPayerCounted = true;
            paymentSource = '1 único pago $250k';
          } else {
            price = 60000;
            paymentSource = 'Tarifa anterior ($60k)';
          }
        } else if (platKey === 'CLAUDE MAX X5') {
          // Cuentas en sheeritdediagama@gmail.com sin pago de $120k en web fueron vendidas a tarifa anterior ($35k - $60k)
          price = 45000;
          paymentSource = 'Tarifa anterior WhatsApp';
        }
      }

      if (price <= 0) {
        const basePrice = priceMap[platKey] || priceMap[c.Streaming] || 10000;
        if (isCombo && idx > 0) {
          price = Math.max(1000, basePrice - 1000);
        } else {
          price = basePrice;
        }
      }

      if (!dailyAccounting[platKey]) {
        dailyAccounting[platKey] = {
          platform: platKey,
          ingreso_total: 0,
          egreso_total: 0,
          ganancia_porcentaje: 0,
          egreso_porcentaje: 0,
          utilidad_total: 0,
          indicador_gan: 0,
          active_profiles: 0
        };
      }

      const dailyIncome = price / 30;
      dailyAccounting[platKey].ingreso_total += dailyIncome;
      dailyAccounting[platKey].active_profiles += 1;
      dailyAccounting[platKey].monthly_client_income = (dailyAccounting[platKey].monthly_client_income || 0) + price;

      // Registrar cliente en el inventario de la cuenta matriz para la auditoría de Red Flags
      if (rawEmail && !rawEmail.startsWith('http')) {
        const invKey = `${platKey}::${rawEmail}`;
        if (masterAccountsInventory[invKey]) {
          masterAccountsInventory[invKey].occupied_slots += 1;
          masterAccountsInventory[invKey].clients.push({
            rowNumber: c.rowNumber,
            name: `${(c.Nombre || '').trim()} ${(c.apellido || '').trim()}`.trim() || 'Cliente',
            phone: phoneDigits,
            paid_amount: price,
            expected_amount: priceMap[platKey] || price,
            source: paymentSource,
            notes: c.observaciones || ''
          });
        }
      }
    });
  });

  // 2. Procesar egresos e inventario necesario según costos de cuentas configurados (streaming_costs)
  const costMap = {};
  costs.forEach(cost => {
    const plat = cost.platform.toUpperCase().trim();
    costMap[plat] = {
      total_cost: parseFloat(cost.total_cost) || 0,
      profile_slots: cost.profile_slots || 1,
      duration_days: cost.duration_days || 30,
      email: cost.email || ''
    };
  });

  // Lista de plataformas cuyo costo ya está implícito en la cuenta matriz principal
  const IMPLICIT_COST_PLATFORMS = new Set([
    'SPOTIFY OWNER',
    'YOUTUBE OWNER',
    'APPLE TV',
    'MICROSOFT COMPARTIDA',
    'GEMINI COMPARTIDA',
    'PLATZI COMPARTIDA'
  ]);

  // Calcular egresos unitarios y egresos totales de inventario según perfiles activos y cuentas matriz reales
  Object.keys(dailyAccounting).forEach(plat => {
    const item = dailyAccounting[plat];
    const costInfo = costMap[plat] || { total_cost: 0, profile_slots: 1, duration_days: 30 };
    const isImplicit = IMPLICIT_COST_PLATFORMS.has(plat) || costInfo.total_cost === 0;

    item.is_implicit_cost = isImplicit;

    if (isImplicit) {
      item.accounts_needed = 0;
      item.monthly_inventory_cost = 0;
      item.egreso_total = 0;
      item.unit_daily_cost = 0;
    } else {
      const slots = costInfo.profile_slots || 1;
      const duration = costInfo.duration_days || 30;
      const theoreticalAccounts = item.active_profiles > 0 ? Math.ceil(item.active_profiles / slots) : 0;
      // Contar cuántas cuentas maestras reales (correos únicos en Excel) existen para esta plataforma
      const realEmailsCount = distinctMasterEmailsByPlat[plat] ? distinctMasterEmailsByPlat[plat].size : 0;
      // Si la plataforma es de múltiples perfiles por correo (slots > 1) y tiene correos maestros en Excel, usar el conteo real de cuentas en Excel
      const accountsNeeded = item.active_profiles > 0
        ? (slots > 1 && realEmailsCount > 0 ? realEmailsCount : theoreticalAccounts)
        : 0;
      
      item.accounts_needed = accountsNeeded;
      item.monthly_inventory_cost = duration > 0 ? (accountsNeeded * costInfo.total_cost * (30 / duration)) : (accountsNeeded * costInfo.total_cost);
      item.egreso_total = duration > 0 ? (item.monthly_inventory_cost / duration) : 0;
      item.unit_daily_cost = accountsNeeded > 0 && duration > 0 ? ((costInfo.total_cost / slots / duration) * slots) : 0;
    }
  });

  // Construir auditoría de Red Flags para todas las cuentas matriz con pérdida o sub-facturación en subplanes
  const redFlags = [];
  Object.values(masterAccountsInventory).forEach(inv => {
    if (IMPLICIT_COST_PLATFORMS.has(inv.platform) || inv.platform === 'NETFLIX EXTRA' || inv.platform === 'PLATZI') return;
    const isAiPlat = inv.platform.includes('CLAUDE') || inv.platform.includes('GPT') || inv.platform.includes('CHATGPT') || (inv.platform === 'GEMINI');
    const costInfo = costMap[inv.platform] || { total_cost: 85000, profile_slots: inv.total_slots || 5, duration_days: 30 };
    if (!costInfo.total_cost || costInfo.total_cost <= 0) return;
    const monthlyAccountCost = Math.round(costInfo.total_cost * (30 / (costInfo.duration_days || 30)));
    const realMonthlyIncome = inv.clients.reduce((sum, cl) => sum + cl.paid_amount, 0);
    const expectedPricePerSlot = priceMap[inv.platform] || 20000;
    const netBalance = realMonthlyIncome - monthlyAccountCost;
    // Ignorar descuentos normales de combo ($500 - $5.000 COP); marcar solo cuando pagaron el precio de un tier inferior en subplanes IA
    const underpayingClients = isAiPlat ? inv.clients.filter(cl => cl.paid_amount < (expectedPricePerSlot - 6000)) : [];

    let usdTier = 'COP Matriz';
    if (costInfo.total_cost >= 700000) usdTier = '$200 USD';
    else if (costInfo.total_cost >= 350000) usdTier = '$100 USD';
    else if (isAiPlat) usdTier = '$20 USD';

    // Marcar como Red Flag si la cuenta da pérdida (netBalance < 0), cuesta >= $100 USD, o tiene clientes alojados de un tier inferior
    if (netBalance < 0 || costInfo.total_cost >= 350000 || underpayingClients.length > 0) {
      let alertReason = '';
      if (inv.platform === 'CLAUDE MAX') {
        alertReason = `Cuenta de ${usdTier} ($${costInfo.total_cost.toLocaleString('es-CO')} COP/mes) donde solo 1 cliente pagó los $250.000 COP y tiene ${inv.total_slots - inv.occupied_slots} cupos vacíos + clientes con tarifa de $60.000.`;
      } else if (inv.platform === 'CLAUDE MAX X5') {
        alertReason = `Cuenta de ${usdTier} ($${costInfo.total_cost.toLocaleString('es-CO')} COP/mes) con clientes alojados pagando tarifa estándar ($20.000 - $63.000 COP) en lugar de $120.000 COP.`;
      } else if (underpayingClients.length > 0) {
        alertReason = `Tiene ${underpayingClients.length} cliente(s) que pagaron tarifa de plan inferior ($${underpayingClients[0].paid_amount.toLocaleString('es-CO')}) en cuenta de $${expectedPricePerSlot.toLocaleString('es-CO')}/cupo.`;
      } else {
        alertReason = `Ingresos actuales ($${realMonthlyIncome.toLocaleString('es-CO')}) no cubren el costo de la cuenta matriz ($${monthlyAccountCost.toLocaleString('es-CO')}).`;
      }

      redFlags.push({
        platform: inv.platform,
        email: inv.email,
        usd_tier: usdTier,
        occupied_slots: inv.occupied_slots,
        total_slots: inv.total_slots,
        base_cost: costInfo.total_cost,
        monthly_cost: monthlyAccountCost,
        real_monthly_income: realMonthlyIncome,
        net_balance: netBalance,
        expected_slot_price: expectedPricePerSlot,
        severity: netBalance < -100000 ? 'critical' : (netBalance < 0 ? 'high' : 'warning'),
        reason: alertReason,
        clients: inv.clients
      });
    }
  });
  redFlags.sort((a, b) => a.net_balance - b.net_balance);

  // 3. Procesar egresos adicionales u otros registrados del día en cash_flow_entries (flujo de caja real)
  const todayStr = now.toISOString().slice(0, 10);
  const [entries] = await pool.query(
    'SELECT * FROM cash_flow_entries WHERE entry_date = ?',
    [todayStr]
  );
  
  entries.forEach(entry => {
    const plat = entry.platform ? entry.platform.toUpperCase().trim() : 'OTROS';
    if (!dailyAccounting[plat]) {
      dailyAccounting[plat] = {
        platform: entry.platform || 'OTROS',
        ingreso_total: 0,
        egreso_total: 0,
        ganancia_porcentaje: 0,
        egreso_porcentaje: 0,
        utilidad_total: 0,
        indicador_gan: 0,
        active_profiles: 0,
        accounts_needed: 0,
        monthly_inventory_cost: 0,
        is_cash_flow_only: true
      };
    } else {
      dailyAccounting[plat].has_cash_flow = true;
    }

    const amount = parseFloat(entry.amount);
    if (entry.type === 'income') {
      if (dailyAccounting[plat].is_cash_flow_only) {
        dailyAccounting[plat].ingreso_total += amount;
        dailyAccounting[plat].monthly_client_income = (dailyAccounting[plat].monthly_client_income || 0) + amount;
      } else {
        dailyAccounting[plat].today_cash_income = (dailyAccounting[plat].today_cash_income || 0) + amount;
      }
    } else {
      if (dailyAccounting[plat].is_cash_flow_only) {
        dailyAccounting[plat].egreso_total += amount;
        dailyAccounting[plat].monthly_inventory_cost = (dailyAccounting[plat].monthly_inventory_cost || 0) + amount;
      } else {
        dailyAccounting[plat].today_cash_expense = (dailyAccounting[plat].today_cash_expense || 0) + amount;
      }
    }
  });

  // 4. Calcular Totales, Ganancia %, Egreso % y Utilidades
  const rows = Object.values(dailyAccounting);
  let globalIngresoTotal = 0;
  let globalEgresoTotal = 0;
  let globalMonthlyIncome = 0;
  let globalMonthlyCost = 0;
  
  rows.forEach(r => {
    r.monthly_income = r.monthly_client_income !== undefined ? r.monthly_client_income : (r.is_cash_flow_only ? r.ingreso_total : (r.ingreso_total * 30));
    r.monthly_expense = r.monthly_inventory_cost !== undefined ? r.monthly_inventory_cost : (r.is_cash_flow_only ? r.egreso_total : (r.egreso_total * 30));

    globalIngresoTotal += r.ingreso_total;
    globalEgresoTotal += r.egreso_total;
    globalMonthlyIncome += r.monthly_income;
    globalMonthlyCost += r.monthly_expense;
  });

  rows.forEach(r => {
    r.utilidad_total = r.ingreso_total - r.egreso_total;
    
    // % de Ganancia sobre el ingreso global
    r.ganancia_porcentaje = globalIngresoTotal > 0 ? (r.ingreso_total / globalIngresoTotal) * 100 : 0;
    
    // % de Egreso sobre el egreso global
    r.egreso_porcentaje = globalEgresoTotal > 0 ? (r.egreso_total / globalEgresoTotal) * 100 : 0;
    
    // Indicador Ganancia (Margen de utilidad sobre el costo de la propia plataforma mensual)
    if (r.monthly_expense > 0) {
      r.indicador_gan = ((r.monthly_income - r.monthly_expense) / r.monthly_expense) * 100;
    } else if (r.monthly_income > 0) {
      // Plataforma con costo implícito en cuenta matriz (Spotify/YouTube familiar, etc.): 100% de margen limpio
      r.indicador_gan = 100;
    } else {
      r.indicador_gan = 0;
    }
  });

  const globalUtilidadTotal = globalIngresoTotal - globalEgresoTotal;
  const globalPorcentajeUtilidad = globalIngresoTotal > 0 ? (globalUtilidadTotal / globalIngresoTotal) * 100 : 0;
  const globalMonthlyProfit = globalMonthlyIncome - globalMonthlyCost;

  return {
    rows: rows.filter(r => r.ingreso_total > 0 || r.egreso_total > 0),
    red_flags: redFlags,
    totals: {
      ingreso_total: globalIngresoTotal,
      egreso_total: globalEgresoTotal,
      utilidad_total: globalUtilidadTotal,
      porcentaje_utilidad: globalPorcentajeUtilidad,
      mensual_ingreso: globalMonthlyIncome,
      mensual_egreso: globalMonthlyCost,
      mensual_utilidad: globalMonthlyProfit
    }
  };
}

async function calculateRealCashFlow() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();

  const dailyData = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    dailyData[dayStr] = {
      date: dayStr,
      income: 0,
      expense: 0,
      profit: 0
    };
  }

  const [sales] = await pool.query(`
    SELECT amount, platformName, DATE_FORMAT(approvedAt, '%Y-%m-%d') as sale_date 
    FROM web_sales_approved 
    WHERE MONTH(approvedAt) = ? AND YEAR(approvedAt) = ?
  `, [month, year]);

  const [entries] = await pool.query(`
    SELECT type, platform, amount, DATE_FORMAT(entry_date, '%Y-%m-%d') as entry_date 
    FROM cash_flow_entries 
    WHERE MONTH(entry_date) = ? AND YEAR(entry_date) = ?
  `, [month, year]);

  const [costs] = await pool.query(`
    SELECT platform, total_cost, DATE_FORMAT(expiration_date, '%Y-%m-%d') as exp_date 
    FROM streaming_costs 
    WHERE MONTH(expiration_date) = ? AND YEAR(expiration_date) = ?
  `, [month, year]);

  const platformIncomeBreakdown = {};
  const platformExpenseBreakdown = {};

  sales.forEach(s => {
    const dayStr = s.sale_date;
    const grossAmount = parseFloat(s.amount || 0);
    
    // Aplicar fórmula inversa de la comisión de pasarela Bold (3.49% + 0.414% ReteICA + $900 COP fijo)
    // para obtener el dinero neto que realmente ingresa a la cuenta bancaria.
    const totalPercentageDecimal = 0.0349 + 0.00414; // 0.03904
    const fixedFee = 900;
    let netAmount = grossAmount;
    if (grossAmount > fixedFee) {
      const calculatedNet = Math.round((grossAmount * (1 - totalPercentageDecimal)) - fixedFee);
      if (calculatedNet > 0) {
        netAmount = calculatedNet;
      }
    }

    if (dailyData[dayStr]) {
      dailyData[dayStr].income += netAmount;
    }
    const plat = (s.platformName || 'OTROS').toUpperCase().trim();
    platformIncomeBreakdown[plat] = (platformIncomeBreakdown[plat] || 0) + netAmount;
  });

  entries.forEach(e => {
    const dayStr = e.entry_date;
    const amount = parseFloat(e.amount || 0);
    const plat = (e.platform || 'OTROS').toUpperCase().trim();
    if (dailyData[dayStr]) {
      if (e.type === 'income') {
        dailyData[dayStr].income += amount;
        platformIncomeBreakdown[plat] = (platformIncomeBreakdown[plat] || 0) + amount;
      } else {
        dailyData[dayStr].expense += amount;
        platformExpenseBreakdown[plat] = (platformExpenseBreakdown[plat] || 0) + amount;
      }
    }
  });

  costs.forEach(c => {
    const dayStr = c.exp_date;
    const amount = parseFloat(c.total_cost || 0);
    const plat = (c.platform || 'OTROS').toUpperCase().trim();
    if (dailyData[dayStr]) {
      dailyData[dayStr].expense += amount;
    }
    platformExpenseBreakdown[plat] = (platformExpenseBreakdown[plat] || 0) + amount;
  });

  let totalIncome = 0;
  let totalExpense = 0;
  const list = [];

  for (const dateStr of Object.keys(dailyData).sort()) {
    const d = dailyData[dateStr];
    d.profit = d.income - d.expense;
    totalIncome += d.income;
    totalExpense += d.expense;
    list.push(d);
  }

  const incomeBreakdownList = Object.keys(platformIncomeBreakdown).map(name => ({
    name,
    value: platformIncomeBreakdown[name]
  })).sort((a, b) => b.value - a.value);

  const expenseBreakdownList = Object.keys(platformExpenseBreakdown).map(name => ({
    name,
    value: platformExpenseBreakdown[name]
  })).sort((a, b) => b.value - a.value);

  return {
    daily: list,
    totals: {
      income: totalIncome,
      expense: totalExpense,
      profit: totalIncome - totalExpense
    },
    breakdown: {
      income: incomeBreakdownList,
      expense: expenseBreakdownList
    }
  };
}

module.exports = {
  getPrices,
  savePrice,
  getCosts,
  saveCost,
  deleteCost,
  addTransaction,
  addCashFlowEntry: addTransaction,
  getTransactions,
  calculateDailyAccounting,
  calculateRealCashFlow,
  recordAccountRenewal,
  getAccountRenewals,
  deleteAccountRenewal
};
