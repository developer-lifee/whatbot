const { getAccountsByPhone, generateCredentialsResponse } = require('./apiService');

/**
 * Procesa la solicitud de credenciales de un usuario y le envía la respuesta.
 * @param {string} userId - ID de WhatsApp del usuario.
 * @param {object} client - Instancia de whatsapp-web.js.
 * @param {string} triggerMessage - El mensaje que activó la solicitud (opcional).
 * @param {string} history - Historial de chat (opcional).
 */
async function processCheckCredentials(userId, client, triggerMessage = "", history = "") {
    try {
        const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); 
        let userAccounts = await getAccountsByPhone(phoneNumber);

        if (userAccounts.length === 0) {
            await client.sendMessage(userId, "🤖 No encontré servicios activos vinculados a este número. Si compraste desde otro número, por favor dímelo para ayudarte a buscar o contacta a un asesor.");
            return;
        }

        const aiResponse = await generateCredentialsResponse(userAccounts, triggerMessage, history);
        await client.sendMessage(userId, aiResponse);

    } catch (error) {
        console.error('[Billing Service] Error al procesar credenciales:', error);
        await client.sendMessage(userId, "🤖 Hubo un error al recuperar tus credenciales. Por favor, inténtalo de nuevo en un momento o contacta a un asesor.");
    }
}

module.exports = {
    processCheckCredentials
};
