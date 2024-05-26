const schedule = require('node-schedule');
const { getExpiredAccounts } = require('./database');
const { sendMessage } = require('./whatsapp');

// Tarea programada para verificar y notificar sobre cuentas vencidas
const scheduleExpiredAccountsCheck = () => {
    schedule.scheduleJob('0 0 * * *', async () => {
        const today = new Date().toISOString().slice(0, 10);
        console.log('Verificando cuentas vencidas...');
        try {
            const expiredAccounts = await getExpiredAccounts(today);
            expiredAccounts.forEach(async account => {
                const message = `Recordatorio: La cuenta ${account.streaming} asociada al correo ${account.correo} vence hoy.`;
                sendMessage('573133890800', message);
            });
        } catch (error) {
            console.error('Error al buscar cuentas vencidas:', error);
        }
    });
};

module.exports = {
    scheduleExpiredAccountsCheck
};
