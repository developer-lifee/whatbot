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
            if (!chat || !chat.id || !chat.id._serialized) return false;
            
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
                const messages = await chat.fetchMessages({ limit: 4 });
                if (messages.length > 0) {
                    const lastMsg = messages[messages.length - 1]; // El último de los recuperados
                    
                    if (chat && chat.id && chat.id._serialized) {
                        console.log(`[BATCH] Evaluando chat: ${chat.id._serialized}`);
                        // Pasamos al procesador normal para que la IA decida si interviene o se calla
                        await processIncomingMessage(lastMsg);
                        count++;
                    } else {
                        console.warn(`[BATCH] Omitiendo chat mal formado o sin ID.`);
                    }
                }
            } catch (err) {
                const chatId = (chat && chat.id) ? chat.id._serialized : 'ID DESCONOCIDO';
                console.error(`Error procesando chat ${chatId} en batch:`, err.message);
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
 * Muestra el menú corto de comandos administrativos.
 */
async function showAdminFunctions(message) {
    const funciones = `🤖 *Comandos Administrativos Rápido:*

1. *Pendientes:* \`@bot atiende pendientes\`
2. *Medios Pago:* \`@bot medios 573...\`
3. *Credenciales:* \`@bot credenciales [plat] [tel]\`
4. *Pausar Bot:* \`@bot duermete / despiertate\`
5. *Liberar:* \`liberar masivo\` o \`liberar [tel]\`
6. *Pagar:* \`confirmar [tel]\` o \`si me llego [tel]\`

Para leer el manual completo de funciones inteligentes, escribe *@bot ayuda* o *@bot manual*.`;
    await message.reply(funciones);
}

/**
 * Muestra el manual detallado de funciones inteligentes.
 */
async function showDetailedHelp(message) {
    const manual = `📖 *Manual Maestro 🤖 Sheerit Bot (Abril 2026)*

Tu bot ahora cuenta con herramientas de "Inteligencia Colaborativa":

---
🤝 *1. Flujo Híbrido Colaborativo*
Si negocias un precio manualmente (ej: "Te queda en 21") y el cliente dice "Listo", el bot detecta el acuerdo y salta directamente a ofrecer los **Medios de Pago** (Nequi, etc.) para que tú no tengas que hacerlo.

📸 *2. Interceptor Global de Pagos*
El bot vigila todas las fotos. Si el cliente envía un comprobante bancario, Gemini Vision lo identifica, te avisa al grupo y le confirma al cliente de inmediato.

📱 *3. Corrección de ID (LID Fix)*
Resuelve el número real de los clientes con IDs migrados (números largos), asegurando que siempre se encuentren sus deudas en el Excel.

🤫 *4. Silencio Inteligente*
Si tú hablas manualmente, el bot se calla para no interrumpir. Solo intervendrá si tú cierras un trato comercial para ayudar con la logística del pago.
---

*Comandos Útiles:*
- \`@bot medios 573...\`: Envía datos bancarios a un cliente.
- \`@bot atiende pendientes\`: El bot toma el control de los chats sin leer.`;
    await message.reply(manual);
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

/**
 * Envía los medios de pago manualmente a un usuario desde el grupo de administración.
 */
async function handleSendManualPaymentMethods(message, command, client, userStates) {
    const phoneRegex = /57\d{10}/;
    const match = command.match(phoneRegex);
    if (!match) {
        await message.reply('❌ No encontré un número de teléfono válido (ej: 57311...) en el comando.');
        return;
    }
    
    const phoneNumber = match[0];
    const userId = `${phoneNumber}@c.us`;
    
    const paymentMsg = `🤖 *MEDIOS DE PAGO SHEERIT*\n\nHola, un asesor me ha pedido enviarte nuestros canales de pago oficiales para completar tu compra:\n\n⭐ *Nequi*\n⭐ *Llaves Bre-B*\n⭐ *Daviplata*\n⭐ *Banco Caja Social*\n⭐ *Bancolombia*\n\n¿Por cuál de estos medios prefieres realizar la transferencia? Una vez la hagas, por favor envíame la captura de pantalla por este chat. 😊`;

    try {
        await client.sendMessage(userId, paymentMsg);
        // Actualizar estado del usuario para que el bot espere el comprobante
        const existing = userStates.get(userId);
        const stateData = typeof existing === 'object' ? { ...existing } : {};
        userStates.set(userId, { ...stateData, state: 'awaiting_payment_method' });
        
        await message.reply(`✅ Medios de pago enviados a @${phoneNumber}. El bot ahora está esperando su comprobante.`);
    } catch (err) {
        console.error('Error enviando medios de pago:', err);
        await message.reply(`❌ No pude enviarle mensaje a @${phoneNumber}. Verifica el número.`);
    }
}

/**
 * Obtiene un reporte de cuentas que están próximas a vencerse (próximos 3 días)
 * para publicar en el grupo administrativo.
 */
async function getUpcomingExpirationsReport() {
    try {
        const { fetchCustomersData } = require('./apiService');
        const clientes = await fetchCustomersData();
        
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        // Rango: próximos 3 días
        const limit = new Date(today);
        limit.setDate(limit.getDate() + 3);
        
        let report = `📅 *REPORTE DE VENCIMIENTOS PRÓXIMOS* (Siguientes 3 días)\n\n`;
        let found = 0;
        
        for (const account of clientes) {
            let vencimientoDate = null;
            
            // La columna 'deben' contiene la fecha de vencimiento en formato Excel serial
            if (account.deben && !isNaN(parseFloat(account.deben))) {
                const excelDate = parseFloat(account.deben);
                const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
                vencimientoDate = new Date(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
            }
            
            if (vencimientoDate && vencimientoDate >= today && vencimientoDate <= limit) {
                const diffDays = Math.ceil((vencimientoDate - today) / (1000 * 60 * 60 * 24));
                const timeStr = diffDays === 0 ? "¡HOY!" : (diffDays === 1 ? "MAÑANA" : `en ${diffDays} días`);
                
                report += `• *${account.Nombre || 'Cliente'}*: ${account.Streaming || 'Servicio'} - Vence ${timeStr} (${vencimientoDate.toLocaleDateString('es-ES')})\n`;
                found++;
            }
        }
        
        if (found === 0) {
            return "🤖 No se encontraron cuentas que venzan en los próximos 3 días. ¡Todo al día! ✨";
        }
        
        return report + `\nTotal: ${found} cuentas próximas a expirar.`;
    } catch (err) {
        console.error("Error generando reporte de vencimientos:", err);
        return "❌ Error al generar el reporte de vencimientos.";
    }
}

module.exports = {
  processPendingChats,
  handleBatchUnanswered,
  handleSendBulkCredentials,
  handleAdminPaymentConfirmation,
  handleSendManualPaymentMethods,
  showAdminFunctions,
  showDetailedHelp,
  getUpcomingExpirationsReport
};
