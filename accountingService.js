const { pool } = require('./database');
const { fetchCustomersData, getJsDateFromExcel } = require('./apiService');

/**
 * Obtiene la lista de precios configurados
 */
async function getPrices() {
  const [rows] = await pool.query('SELECT * FROM streaming_prices ORDER BY platform ASC');
  return rows;
}

/**
 * Guarda o actualiza un precio
 */
async function savePrice(platform, normalPrice) {
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

  // 2. Procesar egresos basados en costos de cuentas configurados (streaming_costs)
  costs.forEach(cost => {
    const plat = cost.platform.toUpperCase().trim();
    if (!dailyAccounting[plat]) {
      dailyAccounting[plat] = {
        platform: cost.platform,
        ingreso_total: 0,
        egreso_total: 0,
        ganancia_porcentaje: 0,
        egreso_porcentaje: 0,
        utilidad_total: 0,
        indicador_gan: 0,
        active_profiles: 0
      };
    }

    // Calcular costo diario de este perfil/cuenta
    const totalCost = parseFloat(cost.total_cost);
    const slots = cost.profile_slots || 1;
    const duration = cost.duration_days || 30;
    
    // Si es cuenta de tipo owner/cupos de invitación que valen 1, el costo marginal es casi cero
    const dailyCost = totalCost / slots / duration;
    
    // Sumar al egreso total de la plataforma
    // Multiplicamos por la cantidad de perfiles activos que tenemos en esta plataforma, o asignamos el costo total
    // de la cuenta normalizada. Usemos el costo diario de la cuenta normalizada.
    dailyAccounting[plat].egreso_total += dailyCost * slots;
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
        active_profiles: 0
      };
    }

    const amount = parseFloat(entry.amount);
    if (entry.type === 'income') {
      // Si registramos ingresos directos del día (ej: ventas en efectivo)
      dailyAccounting[plat].ingreso_total += amount;
    } else {
      // Egresos directos del día
      dailyAccounting[plat].egreso_total += amount;
    }
  });

  // 4. Calcular Totales, Ganancia %, Egreso % y Utilidades
  const rows = Object.values(dailyAccounting);
  let globalIngresoTotal = 0;
  let globalEgresoTotal = 0;
  
  rows.forEach(r => {
    globalIngresoTotal += r.ingreso_total;
    globalEgresoTotal += r.egreso_total;
  });

  rows.forEach(r => {
    r.utilidad_total = r.ingreso_total - r.egreso_total;
    
    // % de Ganancia sobre el ingreso global
    r.ganancia_porcentaje = globalIngresoTotal > 0 ? (r.ingreso_total / globalIngresoTotal) * 100 : 0;
    
    // % de Egreso sobre el egreso global
    r.egreso_porcentaje = globalEgresoTotal > 0 ? (r.egreso_total / globalEgresoTotal) * 100 : 0;
    
    // Indicador Ganancia (Margen de utilidad sobre el costo de la propia plataforma)
    // Formula: Utilidad / Egreso * 100
    r.indicador_gan = r.egreso_total > 0 ? (r.utilidad_total / r.egreso_total) * 100 : 0;
  });

  const globalUtilidadTotal = globalIngresoTotal - globalEgresoTotal;
  const globalPorcentajeUtilidad = globalIngresoTotal > 0 ? (globalUtilidadTotal / globalIngresoTotal) * 100 : 0;

  return {
    rows: rows.filter(r => r.ingreso_total > 0 || r.egreso_total > 0),
    totals: {
      ingreso_total: globalIngresoTotal,
      egreso_total: globalEgresoTotal,
      utilidad_total: globalUtilidadTotal,
      porcentaje_utilidad: globalPorcentajeUtilidad,
      mensual_ingreso: globalIngresoTotal * 30,
      mensual_egreso: globalEgresoTotal * 30,
      mensual_utilidad: globalUtilidadTotal * 30
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
    const amount = parseFloat(s.amount || 0);
    if (dailyData[dayStr]) {
      dailyData[dayStr].income += amount;
    }
    const plat = (s.platformName || 'OTROS').toUpperCase().trim();
    platformIncomeBreakdown[plat] = (platformIncomeBreakdown[plat] || 0) + amount;
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
