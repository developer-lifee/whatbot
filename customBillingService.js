const { pool } = require('./database');

let tableEnsured = false;

async function ensureCustomBillingTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_billing_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(30) NOT NULL,
      client_name VARCHAR(255) NULL,
      platform VARCHAR(120) NOT NULL,
      account_email VARCHAR(255) NULL,
      mode ENUM('custom_price', 'manual_only', 'owner_settlement', 'fixed_date') DEFAULT 'custom_price',
      custom_amount DECIMAL(12,2) NULL,
      fixed_billing_day TINYINT NULL,
      notes TEXT NULL,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_phone_platform (phone, platform)
    )
  `);
  // Migraciones idempotentes para tablas existentes
  try {
    await pool.query(`ALTER TABLE custom_billing_rules ADD COLUMN fixed_billing_day TINYINT NULL AFTER custom_amount`);
  } catch (_) {}
  try {
    await pool.query(`ALTER TABLE custom_billing_rules MODIFY COLUMN mode ENUM('custom_price', 'manual_only', 'owner_settlement', 'fixed_date') DEFAULT 'custom_price'`);
  } catch (_) {}
  tableEnsured = true;
}

/**
 * Aplica un día fijo de corte (1-31) a una fecha YYYY-MM-DD, ajustando al último día del mes si aplica.
 */
function applyFixedBillingDay(isoDateStr, fixedDay) {
  const dayNum = Number(fixedDay);
  if (!isoDateStr || !Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) return isoDateStr;
  const parts = String(isoDateStr).split('-');
  if (parts.length !== 3) return isoDateStr;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10); // 1-12
  if (isNaN(year) || isNaN(month)) return isoDateStr;
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const clampedDay = Math.min(dayNum, lastDayOfMonth);
  return `${year}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

function normalizePhoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function getCustomBillingRulesByPhone(phone) {
  try {
    await ensureCustomBillingTable();
    const tail = normalizePhoneTail(phone);
    if (!tail || tail.length < 7) return [];

    const [rows] = await pool.query(
      `SELECT * FROM custom_billing_rules
       WHERE is_active = 1 AND (phone LIKE ? OR phone = ?)
       ORDER BY id DESC`,
      [`%${tail}`, tail]
    );
    return rows || [];
  } catch (err) {
    console.warn('[CustomBilling] Error consultando reglas por teléfono:', err.message);
    return [];
  }
}

async function getAllCustomBillingRules() {
  await ensureCustomBillingTable();
  const [rows] = await pool.query(
    'SELECT * FROM custom_billing_rules WHERE is_active = 1 ORDER BY updated_at DESC, id DESC'
  );
  return rows || [];
}

function findMatchingCustomRule(rules, platformName) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const target = String(platformName || '').trim().toUpperCase();
  if (!target) return null;

  // 1. Coincidencia exacta
  const exact = rules.find(r => String(r.platform || '').trim().toUpperCase() === target);
  if (exact) return exact;

  // 2. Coincidencia parcial (ej. APPLE TV vs APPLE TV+, APPLE ONE)
  const partial = rules.find(r => {
    const rp = String(r.platform || '').trim().toUpperCase();
    return rp && rp !== 'ALL' && (target.includes(rp) || rp.includes(target));
  });
  if (partial) return partial;

  // 3. Regla global ALL
  return rules.find(r => String(r.platform || '').trim().toUpperCase() === 'ALL') || null;
}

async function saveCustomBillingRule(data) {
  await ensureCustomBillingTable();
  const tail = normalizePhoneTail(data.phone);
  if (!tail || tail.length < 7) {
    throw new Error('Teléfono inválido para guardar el acuerdo especial.');
  }
  const cleanPlatform = String(data.platform || '').trim().toUpperCase();
  if (!cleanPlatform) {
    throw new Error('Debes indicar la plataforma o servicio.');
  }

  const mode = ['custom_price', 'manual_only', 'owner_settlement', 'fixed_date'].includes(data.mode)
    ? data.mode
    : 'custom_price';
  const customAmount = (mode === 'custom_price' || mode === 'owner_settlement') && data.custom_amount !== undefined && data.custom_amount !== null && data.custom_amount !== ''
    ? Number(data.custom_amount)
    : null;
  const rawFixedDay = data.fixed_billing_day !== undefined && data.fixed_billing_day !== null && data.fixed_billing_day !== ''
    ? parseInt(data.fixed_billing_day, 10)
    : null;
  const fixedBillingDay = (rawFixedDay && !isNaN(rawFixedDay) && rawFixedDay >= 1 && rawFixedDay <= 31)
    ? rawFixedDay
    : null;

  await pool.query(
    `INSERT INTO custom_billing_rules
      (phone, client_name, platform, account_email, mode, custom_amount, fixed_billing_day, notes, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
      client_name = VALUES(client_name),
      account_email = VALUES(account_email),
      mode = VALUES(mode),
      custom_amount = VALUES(custom_amount),
      fixed_billing_day = VALUES(fixed_billing_day),
      notes = VALUES(notes),
      is_active = 1`,
    [
      tail,
      data.client_name ? String(data.client_name).trim() : null,
      cleanPlatform,
      data.account_email ? String(data.account_email).trim() : null,
      mode,
      customAmount,
      fixedBillingDay,
      data.notes ? String(data.notes).trim() : null
    ]
  );

  return getCustomBillingRulesByPhone(tail);
}

async function deleteCustomBillingRule(id) {
  await ensureCustomBillingTable();
  await pool.query('DELETE FROM custom_billing_rules WHERE id = ?', [Number(id)]);
}

async function calculateOwnerAccountSummary(accountEmail, ownerPhoneTail) {
  if (!accountEmail) return null;
  try {
    const { fetchRawData } = require('./apiService');
    const rows = await fetchRawData(false);
    const target = String(accountEmail).trim().toLowerCase();
    const matching = (rows || []).filter(r => String(r.correo || r.Correo || '').trim().toLowerCase() === target);
    if (matching.length === 0) return null;

    const others = [];
    let ownerSlots = 0;
    for (const r of matching) {
      const rPhone = normalizePhoneTail(r.numero || r.Numero || '');
      const rName = String(r.whatsapp || r.Nombre || '').trim();
      if (ownerPhoneTail && rPhone === ownerPhoneTail) {
        ownerSlots += 1;
      } else if (rName && !['libre', 'vacio', 'disponible'].includes(rName.toLowerCase())) {
        others.push(rName);
      }
    }

    return {
      totalRows: matching.length,
      ownerSlots,
      otherOccupiedCount: others.length,
      otherClients: others
    };
  } catch (err) {
    console.warn('[CustomBilling] Error calculando resumen de cuenta propietario:', err.message);
    return null;
  }
}

module.exports = {
  ensureCustomBillingTable,
  getCustomBillingRulesByPhone,
  getAllCustomBillingRules,
  findMatchingCustomRule,
  saveCustomBillingRule,
  deleteCustomBillingRule,
  calculateOwnerAccountSummary,
  applyFixedBillingDay
};
