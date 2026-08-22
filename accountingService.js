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
  { platform: 'XBOX', email: 'sheerit294@outlook.com', total_cost: 30800, profile_slots: 5, duration_days: 30, expiration_date: '2024-08-27' },
  { platform: 'IPTV', email: 'http://tvpro.tech:8080', total_cost: 5000, profile_slots: 5, duration_days: 30, expiration_date: '2024-06-16' },
  { platform: 'GPT', email: 'Sheerstreaming@gmail.com', total_cost: 85000, profile_slots: 23, duration_days: 31, expiration_date: '2024-06-17' },
  { platform: 'YOUTUBE', email: 'Sheerstreaming@gmail.com', total_cost: 41900, profile_slots: 6, duration_days: 32, expiration_date: '2024-06-18' },
  { platform: 'APPLE ONE', email: '', total_cost: 83900, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'MICROSOFT', email: '', total_cost: 46000, profile_slots: 5, duration_days: 31, expiration_date: null },
  { platform: 'GEMINI', email: '', total_cost: 79900, profile_slots: 6, duration_days: 32, expiration_date: null },
  { platform: 'PLATZI', email: '', total_cost: 169154, profile_slots: 3, duration_days: 30, expiration_date: null },
  { platform: 'NETFLIX EXTRA', email: '', total_cost: 9900, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'HBO PLATINO', email: '', total_cost: 30000, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'APPLE TV', email: '', total_cost: 1, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'MICROSOFT COMPARTIDA', email: '', total_cost: 1, profile_slots: 1, duration_days: 31, expiration_date: null },
  { platform: 'GEMINI COMPARTIDA', email: '', total_cost: 1, profile_slots: 1, duration_days: 31, expiration_date: null },
  { platform: 'GAMMA', email: '', total_cost: 81000, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'CANVA', email: '', total_cost: 5000, profile_slots: 5, duration_days: 30, expiration_date: null },
  { platform: 'SPOTIFY OWNER', email: '', total_cost: 1, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'YOUTUBE OWNER', email: '', total_cost: 1, profile_slots: 1, duration_days: 30, expiration_date: null },
  { platform: 'CLAUDE', email: '', total_cost: 76000, profile_slots: 10, duration_days: 31, expiration_date: null },
  { platform: 'PLATZI COMPARTIDA', email: '', total_cost: 1, profile_slots: 5, duration_days: 30, expiration_date: null }
];

const SEED_STREAMING_PRICES = [
  { platform: 'NETFLIX', normal_price: 14000 },
  { platform: 'DISNEY', normal_price: 10000 },
  { platform: 'HBO', normal_price: 9000 },
  { platform: 'HBO PLATINO', normal_price: 12000 },
  { platform: 'AMAZON', normal_price: 9000 },
  { platform: 'SPOTIFY', normal_price: 10000 },
  { platform: 'SPOTIFY OWNER', normal_price: 15000 },
  { platform: 'YOUTUBE', normal_price: 10000 },
  { platform: 'YOUTUBE OWNER', normal_price: 15000 },
  { platform: 'GPT', normal_price: 18000 },
  { platform: 'CLAUDE', normal_price: 20000 },
  { platform: 'GEMINI', normal_price: 18000 },
  { platform: 'GEMINI COMPARTIDA', normal_price: 12000 },
  { platform: 'APPLE ONE', normal_price: 25000 },
  { platform: 'APPLE TV', normal_price: 8000 },
  { platform: 'PARAMOUNT', normal_price: 9000 },
  { platform: 'CRUNCHY ROLL', normal_price: 9000 },
  { platform: 'VIX', normal_price: 8000 },
  { platform: 'CANVA', normal_price: 8000 },
  { platform: 'MICROSOFT', normal_price: 15000 },
  { platform: 'MICROSOFT COMPARTIDA', normal_price: 10000 },
  { platform: 'PLATZI', normal_price: 50000 },
  { platform: 'PLATZI COMPARTIDA', normal_price: 25000 },
  { platform: 'GAMMA', normal_price: 25000 },
  { platform: 'XBOX', normal_price: 15000 },
  { platform: 'IPTV', normal_price: 10000 },
  { platform: 'NETFLIX EXTRA', normal_price: 16000 }
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
        email VARCHAR(255),
        total_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
        profile_slots INT NOT NULL DEFAULT 1,
        duration_days INT NOT NULL DEFAULT 30,
        expiration_date DATE NULL,
        payment_method VARCHAR(100) NULL,
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
          [c.platform, c.email || null, c.total_cost, c.profile_slots, c.duration_days, c.expiration_date || null]
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
  const { id, platform, email, total_cost, profile_slots, duration_days, expiration_date, payment_method } = data;
  if (id) {
    await pool.query(
      'UPDATE streaming_costs SET platform = ?, email = ?, total_cost = ?, profile_slots = ?, duration_days = ?, expiration_date = ?, payment_method = ? WHERE id = ?',
      [platform.toUpperCase(), email, total_cost, profile_slots || 1, duration_days || 30, expiration_date || null, payment_method || null, id]
    );
  } else {
    await pool.query(
      'INSERT INTO streaming_costs (platform, email, total_cost, profile_slots, duration_days, expiration_date, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [platform.toUpperCase(), email, total_cost, profile_slots || 1, duration_days || 30, expiration_date || null, payment_method || null]
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

/**
 * Calcula la contabilidad diaria consolidando:
 * 1. Clientes activos (ingreso diario normalizado).
 * 2. Costos de perfiles/cuentas activas (egreso diario normalizado).
 * 3. Transacciones reales de cash_flow_entries registradas en el día.
 */
async function calculateDailyAccounting() {
  const prices = await getPrices();
  const costs = await getCosts();
  const clients = await fetchCustomersData();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Crear mapas rápidos para búsqueda
  const priceMap = {};
  prices.forEach(p => {
    priceMap[p.platform.toUpperCase().trim()] = parseFloat(p.normal_price);
  });

  const dailyAccounting = {};

  // Inicializar todas las plataformas conocidas con valores en cero
  prices.forEach(p => {
    const plat = p.platform.toUpperCase().trim();
    dailyAccounting[plat] = {
      platform: p.platform,
      ingreso_total: 0,
      egreso_total: 0,
      ganancia_porcentaje: 0,
      egreso_porcentaje: 0,
      utilidad_total: 0,
      indicador_gan: 0,
      active_profiles: 0
    };
  });

  // 1. Procesar ingresos basados en suscripciones de clientes activos
  clients.forEach(c => {
    const rawPlat = (c.Streaming || 'OTROS').toUpperCase().trim();
    // Encontrar la mejor coincidencia en priceMap
    let matchedPlat = Object.keys(priceMap).find(p => rawPlat.includes(p)) || 'OTROS';
    
    // Si no está inicializado en la respuesta
    if (!dailyAccounting[matchedPlat]) {
      dailyAccounting[matchedPlat] = {
        platform: matchedPlat,
        ingreso_total: 0,
        egreso_total: 0,
        ganancia_porcentaje: 0,
        egreso_porcentaje: 0,
        utilidad_total: 0,
        indicador_gan: 0,
        active_profiles: 0
      };
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
      // Si no tiene fecha pero está en el listado, asumimos activo por defecto
      isActive = true;
    }

    if (isActive) {
      // Ingreso mensual estimado
      const price = priceMap[matchedPlat] || 10000;
      // Normalizado a diario (dividido por 30)
      const dailyIncome = price / 30;
      dailyAccounting[matchedPlat].ingreso_total += dailyIncome;
      dailyAccounting[matchedPlat].active_profiles += 1;
    }
  });

  // 2. Procesar egresos e inventario necesario según costos de cuentas configurados (streaming_costs)
  const costMap = {};
  costs.forEach(cost => {
    const plat = cost.platform.toUpperCase().trim();
    costMap[plat] = {
      total_cost: parseFloat(cost.total_cost) || 0,
      profile_slots: cost.profile_slots || 1,
      duration_days: cost.duration_days || 30
    };
  });

  // Calcular egresos unitarios y egresos totales de inventario según perfiles activos
  Object.keys(dailyAccounting).forEach(plat => {
    const item = dailyAccounting[plat];
    const costInfo = costMap[plat] || { total_cost: 1000, profile_slots: 1, duration_days: 30 };
    
    // Cuentas completas necesarias para suplir a todos los clientes activos
    const slots = costInfo.profile_slots || 1;
    const duration = costInfo.duration_days || 30;
    const accountsNeeded = item.active_profiles > 0 ? Math.ceil(item.active_profiles / slots) : 1;
    
    // Egreso total mensual de compra de cuentas matriz necesarias
    item.accounts_needed = accountsNeeded;
    item.monthly_inventory_cost = accountsNeeded * costInfo.total_cost;
    
    // Egreso diario de inventario (fórmula Excel)
    item.egreso_total = item.monthly_inventory_cost / duration;
    
    // Egreso unitario de 1 sola cuenta normalizada (para análisis unitario)
    item.unit_daily_cost = (costInfo.total_cost / slots / duration) * slots;
  });

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
        monthly_inventory_cost: 0
      };
    }

    const amount = parseFloat(entry.amount);
    if (entry.type === 'income') {
      dailyAccounting[plat].ingreso_total += amount;
    } else {
      dailyAccounting[plat].egreso_total += amount;
    }
  });

  // 4. Calcular Totales, Ganancia %, Egreso % y Utilidades
  const rows = Object.values(dailyAccounting);
  let globalIngresoTotal = 0;
  let globalEgresoTotal = 0;
  let globalMonthlyIncome = 0;
  let globalMonthlyCost = 0;
  
  rows.forEach(r => {
    globalIngresoTotal += r.ingreso_total;
    globalEgresoTotal += r.egreso_total;
    globalMonthlyIncome += (r.ingreso_total * 30);
    globalMonthlyCost += (r.monthly_inventory_cost || (r.egreso_total * 30));
  });

  rows.forEach(r => {
    r.utilidad_total = r.ingreso_total - r.egreso_total;
    
    // % de Ganancia sobre el ingreso global
    r.ganancia_porcentaje = globalIngresoTotal > 0 ? (r.ingreso_total / globalIngresoTotal) * 100 : 0;
    
    // % de Egreso sobre el egreso global
    r.egreso_porcentaje = globalEgresoTotal > 0 ? (r.egreso_total / globalEgresoTotal) * 100 : 0;
    
    // Indicador Ganancia (Margen de utilidad sobre el costo de la propia plataforma)
    r.indicador_gan = r.egreso_total > 0 ? (r.utilidad_total / r.egreso_total) * 100 : 0;
  });

  const globalUtilidadTotal = globalIngresoTotal - globalEgresoTotal;
  const globalPorcentajeUtilidad = globalIngresoTotal > 0 ? (globalUtilidadTotal / globalIngresoTotal) * 100 : 0;
  const globalMonthlyProfit = globalMonthlyIncome - globalMonthlyCost;

  return {
    rows: rows.filter(r => r.ingreso_total > 0 || r.egreso_total > 0),
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
  getTransactions,
  calculateDailyAccounting,
  calculateRealCashFlow
};
