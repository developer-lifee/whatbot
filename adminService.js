const { fetchRawData, updateExcelData } = require('./apiService');

/**
 * Busca todos los chats individuales con mensajes sin leer o en estado waiting_human y los procesa.
 */
async function handleBatchUnanswered(adminMessage, client, userStates, processIncomingMessage) {
  let count = 0;
  await adminMessage.reply('⏳ Escaneando todos tus chats en busca de mensajes no leídos o casos pendientes...');
  
  try {
    const chats = await client.getChats();
    const pendingChats = chats.filter(chat => {
        // No procesar grupos ni anuncios
        if (chat.isGroup || chat.id._serialized.includes('@broadcast')) return false;

        // Criterio 1: Mensajes sin leer
        if (chat.unreadCount > 0) return true;
        
        // Criterio 2: Marcado explícitamente en memoria como esperando humano
        const state = userStates.get(chat.id._serialized);
        const stateStr = typeof state === 'object' ? state.state : state;
        if (stateStr === 'waiting_human') return true;
        
        return false;
    });

    if (pendingChats.length === 0) {
      await adminMessage.reply('🤖 No encontré ningún chat sin leer ni clientes marcados en "espera de asesor".');
      return;
    }

    await adminMessage.reply(`🤖 He detectado *${pendingChats.length}* chats que requieren atención. Iniciando respuestas automáticas...`);

    for (const chat of pendingChats) {
      try {
        const messages = await chat.fetchMessages({ limit: 1 });
        if (messages.length > 0) {
          const lastMsg = messages[0];
          // Solo procesar si el último mensaje es del cliente
          if (!lastMsg.fromMe) {
            console.log(`[BATCH] Procesando chat: ${chat.id._serialized}`);
            userStates.delete(chat.id._serialized); // Reactivar bot para este chat
            await processIncomingMessage(lastMsg);
            count++;
          }
        }
      } catch (err) {
        console.error(`Error procesando chat ${chat.id._serialized} en batch:`, err.message);
      }
      // Pausa de seguridad para evitar spam/bloqueos
      await new Promise(r => setTimeout(r, 3500));
    }

    await adminMessage.reply(`✅ *Proceso Finalizado*\nSe atendieron exitosamente ${count} chats que estaban pendientes.`);

  } catch (err) {
    console.error('Error en handleBatchUnanswered:', err);
    await adminMessage.reply('❌ Lo siento, hubo un problema al intentar escanear los chats.');
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

module.exports = {
  handleBatchUnanswered,
  showAdminFunctions
};
