const { pool } = require('./database');

let debtTableEnsured = false;

async function ensureOverdueDebtTable() {
  if (debtTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_overdue_debts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(30) NOT NULL,
      client_name VARCHAR(255) NULL,
      origin_platform VARCHAR(120) NOT NULL,
      extra_days INT NOT NULL DEFAULT 0,
      monthly_price DECIMAL(12,2) NOT NULL DEFAULT 0,
      debt_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      cut_date VARCHAR(40) NULL,
      is_consumed TINYINT(1) DEFAULT 0,
      consumed_at TIMESTAMP NULL,
      consumed_platform VARCHAR(120) NULL,
      days_deducted INT NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone_active (phone, is_consumed)
    )
  `);
  debtTableEnsured = true;
}

function normalizePhoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Registra días de mora disfrutados de más al momento de cortar un servicio,
 * guardando su valor prorrateado en COP para descontarlo en días en su próxima activación.
 */
async function recordOverdueDebt({ phone, clientName = '', platform = 'SERVICIO', extraDays = 0, monthlyPrice = 0, cutDate = '', notes = '' }) {
  const days = Math.max(0, Math.round(Number(extraDays) || 0));
  const tail = normalizePhoneTail(phone);
  if (!tail || tail.length < 7 || days <= 0) return null;

  await ensureOverdueDebtTable();
  const cleanPlatform = String(platform || 'SERVICIO').trim().toUpperCase();
  const price = Math.max(0, Number(monthlyPrice) || 0);
  const debtAmount = price > 0 ? Math.round((price / 30) * days) : 0;

  const [res] = await pool.query(
    `INSERT INTO client_overdue_debts
      (phone, client_name, origin_platform, extra_days, monthly_price, debt_amount, cut_date, notes, is_consumed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      tail,
      clientName ? String(clientName).trim() : null,
      cleanPlatform,
      days,
      price,
      debtAmount,
      cutDate || new Date().toISOString().slice(0, 10),
      notes || `Corte con +${days} día(s) disfrutados de más en ${cleanPlatform}`
    ]
  );

  return {
    id: res.insertId,
    phone: tail,
    origin_platform: cleanPlatform,
    extra_days: days,
    monthly_price: price,
    debt_amount: debtAmount
  };
}

/**
 * Obtiene los saldos pendientes de mora (no consumidos) de un cliente.
 */
async function getPendingOverdueDebts(phone) {
  try {
    const tail = normalizePhoneTail(phone);
    if (!tail || tail.length < 7) return [];
    await ensureOverdueDebtTable();
    const [rows] = await pool.query(
      `SELECT * FROM client_overdue_debts
       WHERE is_consumed = 0 AND (phone = ? OR phone LIKE ?)
       ORDER BY id ASC`,
      [tail, `%${tail}`]
    );
    return rows || [];
  } catch (err) {
    console.warn('[OverdueDebt] Error consultando saldos pendientes:', err.message);
    return [];
  }
}

/**
 * Elimina/perdona un saldo pendiente de mora desde el panel admin.
 */
async function deleteOverdueDebt(id) {
  await ensureOverdueDebtTable();
  await pool.query('DELETE FROM client_overdue_debts WHERE id = ?', [Number(id)]);
}

/**
 * Si el cliente tiene saldo pendiente por días disfrutados de más en un corte previo,
 * convierte el valor prorrateado en días del nuevo servicio, los resta de baseNextDateIso
 * y marca el saldo como consumido (una sola vez).
 */
async function consumeOverdueDebtForSale(phone, newPlatform, newMonthlyPrice, baseNextDateIso) {
  try {
    const pending = await getPendingOverdueDebts(phone);
    if (!pending || pending.length === 0 || !baseNextDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(baseNextDateIso)) {
      return null;
    }

    const totalDebtAmount = pending.reduce((acc, r) => acc + Math.max(0, Number(r.debt_amount) || 0), 0);
    const totalExtraDays = pending.reduce((acc, r) => acc + Math.max(0, Number(r.extra_days) || 0), 0);
    const newPrice = Math.max(0, Number(newMonthlyPrice) || 0);

    let daysToDeduct = 0;
    if (totalDebtAmount > 0 && newPrice > 0) {
      daysToDeduct = Math.max(1, Math.round(totalDebtAmount / (newPrice / 30)));
    } else if (totalExtraDays > 0) {
      daysToDeduct = totalExtraDays;
    }

    if (daysToDeduct <= 0) return null;

    // Calcular fecha ajustada asegurando que siempre queden al menos 3 días vigentes desde hoy
    const [y, m, d] = baseNextDateIso.split('-').map(Number);
    const baseDate = new Date(y, m - 1, d);
    baseDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDaysAvailable = Math.round((baseDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const maxSafeDeduction = Math.max(0, totalDaysAvailable - 3);
    const finalDaysDeducted = Math.min(daysToDeduct, maxSafeDeduction);

    if (finalDaysDeducted <= 0) return null;

    const adjustedDateObj = new Date(baseDate.getTime() - finalDaysDeducted * 24 * 60 * 60 * 1000);
    const adjY = adjustedDateObj.getFullYear();
    const adjM = String(adjustedDateObj.getMonth() + 1).padStart(2, '0');
    const adjD = String(adjustedDateObj.getDate()).padStart(2, '0');
    const adjustedDate = `${adjY}-${adjM}-${adjD}`;

    const ids = pending.map(r => r.id);
    const originPlatforms = [...new Set(pending.map(r => r.origin_platform).filter(Boolean))];

    await pool.query(
      `UPDATE client_overdue_debts
       SET is_consumed = 1, consumed_at = NOW(), consumed_platform = ?, days_deducted = ?
       WHERE id IN (${ids.map(() => '?').join(',')})`,
      [String(newPlatform || 'SERVICIO').trim().toUpperCase(), finalDaysDeducted, ...ids]
    );

    console.log(
      `[OverdueDebt] ⚖️ Saldo previo aplicado a ${normalizePhoneTail(phone)} (${newPlatform}): -$${totalDebtAmount} COP -> -${finalDaysDeducted} días (${baseNextDateIso} -> ${adjustedDate})`
    );

    return {
      adjustedDate,
      originalDate: baseNextDateIso,
      daysDeducted: finalDaysDeducted,
      totalDebtAmount,
      totalExtraDays,
      originPlatforms,
      debtIds: ids
    };
  } catch (err) {
    console.warn('[OverdueDebt] Error aplicando descuento por mora previa:', err.message);
    return null;
  }
}

module.exports = {
  ensureOverdueDebtTable,
  recordOverdueDebt,
  getPendingOverdueDebts,
  deleteOverdueDebt,
  consumeOverdueDebtForSale
};
