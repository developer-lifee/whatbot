const mysql = require('mysql2/promise');

async function connectToDatabase() {
  const connection = await mysql.createConnection({
    host: 'mysql.freehostia.com',
    user: 'estavi0_sheerit',
    password: '26o6ssCOA^',
    database: 'estavi0_sheerit'
  });
  return connection;
}

async function getExpiredAccounts(date) {
  const connection = await connectToDatabase();
  try {
    const [results] = await connection.query('SELECT correo, streaming FROM datoscuenta WHERE fechaCuenta = ?', [date]);
    return results;
  } finally {
    await connection.end();
  }
}

async function checkCredentials(userId) {
  const phoneNumber = userId.replace('@c.us', '');
  const connection = await connectToDatabase();
  try {
    const [clients] = await connection.query('SELECT clienteID, nombre FROM datos_de_cliente WHERE numero = ?', [phoneNumber]);
    if (clients.length === 0) {
      return null;
    }
    return clients.map(async client => {
      const [profiles] = await connection.query('SELECT idCuenta, pinPerfil FROM perfil WHERE clienteID = ?', [client.clienteID]);
      return profiles.map(async profile => {
        const [accounts] = await connection.query(`
          SELECT c.correo, c.clave, c.fechaCuenta, lm.nombre_cuenta
          FROM datosCuenta c
          JOIN lista_maestra lm ON c.id_streaming = lm.id_streaming
          WHERE c.idCuenta = ?
        `, [profile.idCuenta]);
        return { client, profile, accounts };
      });
    });
  } finally {
    await connection.end();
  }
}

module.exports = {
  getExpiredAccounts,
  checkCredentials
};
