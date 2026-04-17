const schedule = require('node-schedule');
const { handleAutoCobros } = require('./billingService');
const { getUpcomingExpirationsReport, notifyProviderExpiringAccounts } = require('./adminService');

let automationInitialized = false;

/**
 * Inicializa las tareas automáticas del día.
 * @param {object} client - El cliente de WhatsApp.
 * @param {Map} userStates - Los estados actuales de los usuarios.
 * @param {Map} pendingConfirmations - Las confirmaciones de cobro pendientes.
 * @param {string} groupId - El ID del grupo de administración para reportes.
 */
function initDailyAutomation(client, userStates, pendingConfirmations, groupId) {
    if (automationInitialized) {
        console.log('⏰ [AUTOMATION] Tareas ya inicializadas previamente. Ignorando reprogramación.');
        return;
    }
    automationInitialized = true;
    
    console.log('⏰ [AUTOMATION] Inicializando tareas diarias (9:00 AM y 2:00 PM)...');

    // 1. COBROS AUTOMÁTICOS (9:00 AM)
    // Se ejecuta de Lunes a Domingo a las 9:00
    schedule.scheduleJob('0 9 * * *', async () => {
        console.log('🚀 [9:00 AM] Iniciando proceso automático de cobros...');
        try {
            // Simulamos un mensaje del admin al bot para disparar el flujo de cobros
            // El bot analizará el Excel y mandará el resumen al grupo
            const fakeMessage = {
                from: groupId,
                body: '@bot cobros automáticos',
                reply: async (text) => {
                    const chat = await client.getChatById(groupId);
                    await chat.sendMessage(text);
                }
            };
            
            await handleAutoCobros(fakeMessage, groupId, userStates, pendingConfirmations, client);
            
        } catch (err) {
            console.error('❌ Error en tarea automática de las 9:00 AM:', err);
        }
    });

    // 2. REPORTE DE VENCIMIENTOS (2:00 PM)
    // Se ejecuta de Lunes a Domingo a las 14:00
    schedule.scheduleJob('0 14 * * *', async () => {
        console.log('🚀 [2:00 PM] Generando reporte de vecimientos próximos...');
        try {
            const report = await getUpcomingExpirationsReport();
            const chat = await client.getChatById(groupId);
            if (chat) {
                await chat.sendMessage(`🤖 *REPORTE AUTOMÁTICO DE LAS 2:00 PM*\n\n${report}`);
            }
            
            // Notificamos al proveedor de forma automática
            await notifyProviderExpiringAccounts(client);
            
        } catch (err) {
            console.error('❌ Error en tarea automática de las 2:00 PM:', err);
        }
    });

    console.log('✅ [AUTOMATION] Tareas programadas con éxito.');
}

module.exports = {
    initDailyAutomation
};
