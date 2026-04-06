const { fetchRawData, updateExcelData } = require('./apiService');
const { recordNewSale } = require('./salesRegistryService');

/**
 * Función central para procesar chats con mensajes sin leer.
 * Puede ser llamada por un comando o por un proceso automático.
 */
async function processPendingChats(client, userStates, processIncomingMessage) {
    let count = 0;
    try {
        const chats = await client.getChats();
        const pendingChats = chats.filter(chat => {
            if (chat.isGroup || chat.id._serialized.includes('@broadcast')) return false;
            
            // Criterio 1: Mensajes sin leer
            if (chat.unreadCount > 0) return true;
            
            // Criterio 2: Marcado explícitamente en memoria como esperando humano
            const state = userStates.get(chat.id._serialized);
            const stateStr = typeof state === 'object' ? state.state : state;
            if (stateStr === 'waiting_human') return true;
            
            return false;
        });

        for (const chat of pendingChats) {
            try {
                const messages = await chat.fetchMessages({ limit: 1 });
                if (messages.length > 0) {
                    const lastMsg = messages[0];
                    if (!lastMsg.fromMe) {
                        console.log(`[BATCH] Procesando chat: ${chat.id._serialized}`);
                        userStates.delete(chat.id._serialized);
                        await processIncomingMessage(lastMsg);
                        count++;
                    }
                }
            } catch (err) {
                console.error(`Error procesando chat ${chat.id._serialized} en batch:`, err.message);
            }
            await new Promise(r => setTimeout(r, 2000)); // Delay sutil
        }
    } catch (err) {
        console.error('Error en processPendingChats:', err);
    }
    return count;
}

/**
 * Busca todos los chats individuales con mensajes sin leer o en estado waiting_human y los procesa.
 */
async function handleBatchUnanswered(adminMessage, client, userStates, processIncomingMessage) {
  await adminMessage.reply('⏳ Escaneando todos tus chats en busca de mensajes no leídos o casos pendientes...');
  const count = await processPendingChats(client, userStates, processIncomingMessage);
  
  if (count === 0) {
    await adminMessage.reply('🤖 No encontré ningún chat sin leer ni clientes marcados en "espera de asesor" que requirieran acción inmediata.');
  } else {
    await adminMessage.reply(`✅ *Proceso Finalizado*\nSe atendieron exitosamente ${count} chats que estaban pendientes.`);
  }
}

/**
 * Muestra el menú de funciones administrativas.
 */
async function showAdminFunctions(message) {
    const funciones = `🤖 *Comandos Administrativos:*

1. *Atención Pendientes:* \`@bot atiende pendientes\` (Escanea y responde).
2. *Dormir/Despertar:* \`@bot duermete\` o \`@bot despiertate\`.
3. *Liberar Masivo:* \`liberar masivo\` (Reactiva a todos los bloqueados).
4. *Cobros Automáticos:* \`@bot cobros automáticos\`.`;
    await message.reply(funciones);
}

/**
 * Maneja el envío de credenciales masivo desde el grupo de administración.
 */
async function handleSendBulkCredentials(message, command, client, getAccountsByPhone) {
    const knownPlatforms = ['disney', 'netflix', 'amazon', 'spotify', 'max', 'paramount', 'crunchyroll', 'vix', 'youtube', 'canva', 'apple', 'plex', 'iptv', 'magis'];
    let requestedPlatform = null;
    for (const plat of knownPlatforms) {
        if (command.includes(plat)) { requestedPlatform = plat; break; }
    }
    
    await message.reply(requestedPlatform ? `⏳ Enviando credenciales de *${requestedPlatform.toUpperCase()}*...` : '⏳ Enviando TODAS las credenciales...');
    
    const listText = message.body.split('\n').length > 1 ? message.body.split('\n').slice(1).join('\n') : command;
    const regex = /57\s*3\d{2}\s*\d{7}|57\s*3\d{9}/g;
    const matches = listText.match(regex);
    
    if (!matches) {
       await message.reply('❌ No encontré números válidos en el mensaje o lista.');
       return;
    }
    
    let enviados = 0, fallidos = 0;
    const { formatDirectCredentials } = require('./aiService');
    for (const phoneStr of matches) {
        const cleanPhone = phoneStr.replace(/\s+/g, '');
        try {
            const accounts = await getAccountsByPhone(cleanPhone);
            const formattedMsg = formatDirectCredentials(accounts, requestedPlatform);
            if (formattedMsg) {
                await client.sendMessage(cleanPhone + '@c.us', formattedMsg);
                enviados++;
            } else { fallidos++; }
        } catch(err) { fallidos++; }
        // Pausa anti-spam
        await new Promise(r => setTimeout(r, 3000));
    }
    await message.reply(`✅ *Proceso Finalizado*\nÉxito: ${enviados} | Fallidos: ${fallidos}`);
}

/**
 * Procesa la confirmación manual de un administrador en el grupo.
 * Puede recibir el comando directamente o un teléfono extraído (si es una respuesta/reply).
 */
async function handleAdminPaymentConfirmation(message, command, client, userStates, overridePhone = null) {
    // Patrones: "confirmar 57311...", "si me llego 57311...", "si la recibi 57311..."
    let phoneNumber = overridePhone;
    
    if (!phoneNumber) {
        const cleanCommand = command.toLowerCase();
        const phoneRegex = /57\d{10}/;
        const match = cleanCommand.match(phoneRegex);
        if (!match) return; 
        phoneNumber = match[0];
    }

    const userId = `${phoneNumber}@c.us`;
    const userState = userStates.get(userId);

    if (!userState || (userState.state !== 'waiting_admin_confirmation' && userState.state !== 'waiting_human')) {
        await message.reply(`🤖 El usuario @${phoneNumber} no tiene un pago pendiente de validación en este momento.`);
        return;
    }

    await message.reply(`✅ *Validando pago de @${phoneNumber}...*`);

    try {
        const paymentMethod = userState.paymentMethod || "Confirmado por Admin";
        
        // Registrar en Excel inteligente (retorna array de resultados por item)
        const results = await recordNewSale(userId, userState, paymentMethod);
        
        let report = `✅ *Venta Registrada con éxito*\n\n`;
        let userMsg = "🤖 ¡Tu pago ha sido validado! Gracias por tu compra.\n\n";
        let hasFamily = false;

        for (const res of results) {
            if (res.status === 'success') {
                report += `- ${res.name}: Fila ${res.index} ✅\n`;
                userMsg += `- *${res.name}*: Ya tienes el cupo asignado.\n`;
            } else if (res.status === 'manual_invitation_required') {
                report += `- ${res.name}: ⚠️ *PLAN FAMILIAR*. Requiere invitación manual.\n`;
                userMsg += `- *${res.name}*: Un asesor te enviará la invitación manual en un momento.\n`;
                hasFamily = true;
            } else {
                report += `- ${res.name}: ❌ Sin cupos disponibles.\n`;
                userMsg += `- *${res.name}*: Estamos agotados en este momento. Un asesor te contactará para darte una solución.\n`;
            }
        }

        // Notificar al cliente
        await client.sendMessage(userId, userMsg);
        
        // Limpiar estado o mover a menú principal
        userStates.set(userId, { state: 'main_menu', nombre: userState.nombre });
        
        if (hasFamily) report += `\n🚨 @${phoneNumber} requiere invitación manual para los planes familiares marcados arriba.`;
        
        await message.reply(report);
    } catch (err) {
        console.error('Error en confirmación manual:', err);
        await message.reply(`❌ Error al registrar la venta de @${phoneNumber}: ${err.message}`);
    }
}

module.exports = {
  processPendingChats,
  handleBatchUnanswered,
  handleSendBulkCredentials,
  handleAdminPaymentConfirmation,
  showAdminFunctions
};
