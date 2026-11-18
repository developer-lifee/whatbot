const { pool } = require('./database');

let tableEnsured = false;

async function ensureValidatedPaymentsTable() {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS validated_payments_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(30) NULL,
      user_id VARCHAR(100) NULL,
      client_name VARCHAR(255) NULL,
      payment_type ENUM('renewal', 'new_sale', 'mixed') DEFAULT 'new_sale',
      platform VARCHAR(120) NOT NULL,
      account_email VARCHAR(255) NULL,
      excel_row INT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      duration_months INT NOT NULL DEFAULT 1,
      payment_method VARCHAR(120) NULL,
      bank VARCHAR(80) NULL,
      destination_key VARCHAR(80) NULL,
      destination_name VARCHAR(150) NULL,
      transaction_reference VARCHAR(120) NULL,
      receipt_date VARCHAR(30) NULL,
      gmail_match_id VARCHAR(150) NULL,
      new_expiration VARCHAR(50) NULL,
      validation_source VARCHAR(50) DEFAULT 'auto_ocr',
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_phone (phone),
      INDEX idx_created_at (created_at),
      INDEX idx_ref (transaction_reference)
    )
  `);
  tableEnsured = true;
}

function inferValidationSource(paymentMethod, gmailMatchId, autoValidatedByKey) {
  const pm = String(paymentMethod || '').toLowerCase();
  if (pm.includes('bold')) return 'bold';
  if (gmailMatchId || pm.includes('gmail')) return 'gmail_match';
  if (autoValidatedByKey || pm.includes('auto-ocr') || pm.includes('llave')) return 'auto_ocr';
  if (pm.includes('web admin') || pm.includes('admin')) return 'web_admin';
  return 'manual';
}

async function logValidatedPayment(entry) {
  try {
    await ensureValidatedPaymentsTable();
    const cleanPhone = entry.phone ? String(entry.phone).replace(/\D/g, '') : null;
    const source = entry.validation_source || inferValidationSource(
      entry.payment_method,
      entry.gmail_match_id,
      entry.auto_validated_by_key
    );

    await pool.query(
      `INSERT INTO validated_payments_log (
        phone, user_id, client_name, payment_type, platform, account_email,
        excel_row, amount, duration_months, payment_method, bank,
        destination_key, destination_name, transaction_reference, receipt_date,
        gmail_match_id, new_expiration, validation_source, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cleanPhone,
        entry.user_id || null,
        entry.client_name || null,
        entry.payment_type || 'new_sale',
        String(entry.platform || 'DESCONOCIDA').slice(0, 120),
        entry.account_email || null,
        entry.excel_row ? Number(entry.excel_row) : null,
        Number(entry.amount || 0),
        Number(entry.duration_months || 1),
        entry.payment_method || null,
        entry.bank || null,
        entry.destination_key || null,
        entry.destination_name || null,
        entry.transaction_reference || null,
        entry.receipt_date || null,
        entry.gmail_match_id || null,
        entry.new_expiration || null,
        source,
        entry.details || null
      ]
    );
  } catch (err) {
    console.warn('[PaymentLog] Error registrando pago validado:', err.message);
  }
}

async function getValidatedPayments({ limit = 200, type = 'all', source = 'all', search = '' } = {}) {
  await ensureValidatedPaymentsTable();

  const where = [];
  const params = [];

  if (type && type !== 'all') {
    where.push('payment_type = ?');
    params.push(type);
  }
  if (source && source !== 'all') {
    where.push('validation_source = ?');
    params.push(source);
  }
  if (search && search.trim()) {
    const term = `%${search.trim()}%`;
    where.push(`(
      phone LIKE ? OR client_name LIKE ? OR platform LIKE ? OR
      account_email LIKE ? OR transaction_reference LIKE ? OR
      destination_key LIKE ? OR payment_method LIKE ? OR bank LIKE ?
    )`);
    params.push(term, term, term, term, term, term, term, term);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  const [rows] = await pool.query(
    `SELECT * FROM validated_payments_log ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, safeLimit]
  );

  const [summaryRows] = await pool.query(`
    SELECT
      COUNT(*) AS totalCount,
      COALESCE(SUM(amount), 0) AS totalAmount,
      SUM(CASE WHEN payment_type = 'renewal' THEN 1 ELSE 0 END) AS renewalsCount,
      SUM(CASE WHEN payment_type = 'new_sale' THEN 1 ELSE 0 END) AS newSalesCount,
      SUM(CASE WHEN validation_source IN ('auto_ocr', 'gmail_match') THEN 1 ELSE 0 END) AS autoValidatedCount,
      COALESCE(SUM(CASE WHEN validation_source IN ('auto_ocr', 'gmail_match') THEN amount ELSE 0 END), 0) AS autoValidatedAmount
    FROM validated_payments_log
  `);

  return {
    payments: rows || [],
    summary: summaryRows && summaryRows[0] ? summaryRows[0] : {
      totalCount: 0,
      totalAmount: 0,
      renewalsCount: 0,
      newSalesCount: 0,
      autoValidatedCount: 0,
      autoValidatedAmount: 0
    }
  };
}

async function getClientValidatedPayments(phoneOrTail) {
  await ensureValidatedPaymentsTable();
  const digits = String(phoneOrTail || '').replace(/\D/g, '');
  if (digits.length < 7) return [];
  const tail = digits.slice(-10);

  const [rows] = await pool.query(
    `SELECT * FROM validated_payments_log
     WHERE phone LIKE ? OR phone = ? OR user_id LIKE ?
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [`%${tail}`, digits, `%${tail}%`]
  );
  return rows || [];
}

module.exports = {
  ensureValidatedPaymentsTable,
  logValidatedPayment,
  getValidatedPayments,
  getClientValidatedPayments
};
