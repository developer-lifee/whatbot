require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql.freehostia.com',
  user: process.env.DB_USER || 'estavi0_sheerit',
  password: process.env.DB_PASSWORD || '26o6ssCOA^',
  database: process.env.DB_NAME || 'estavi0_sheerit',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0
});

async function getExpiredAccounts(date) {
  const [results] = await pool.query('SELECT correo, streaming FROM datoscuenta WHERE fechaCuenta = ?', [date]);
  return results;
}

module.exports = {
  pool,
  getExpiredAccounts
};
