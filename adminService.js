const { fetchRawData, updateExcelData } = require('./apiService');
const { recordNewSale } = require('./salesRegistryService');

function isCriticalBrowserError(err) {
    if (!err || !err.message) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('detached frame') || 
           msg.includes('execution context was destroyed') || 
           msg.includes('navigation failed') ||
           msg.includes('connection closed');
}

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
            
            const chatId = chat.id._serialized;
            if (chat.isGroup || chatId.includes('@broadcast')) return false;
            
            // Criterio 1: Mensajes sin leer
            if (chat.unreadCount > 0) return true;
            
            // Criterio 2: Marcado explícitamente en memoria como esperando humano
            const state = userStates.get(chatId);
            const stateStr = typeof state === 'object' ? state.state : state;
            if (stateStr === 'waiting_human') return true;
            
            return false;
        });

        for (const chat of pendingChats) {
            try {
                // Obtenemos más mensajes para tener mejor contexto (especialmente útil en waiting_human)
                const messages = await chat.fetchMessages({ limit: 10 });
                if (messages.length > 0) {
                    const lastMsg = messages[messages.length - 1]; 
                    
                    if (chat && chat.id && chat.id._serialized) {
                        const isSilenced = userStates.get(chat.id._serialized) === 'waiting_human';
                        console.log(`[BATCH] Escaneando chat: ${chat.id._serialized} (Unread: ${chat.unreadCount}${isSilenced ? ', Silenced' : ''})`);
                        
                        // Adjuntamos el conteo de no leídos para que el procesador lo sepa
                        lastMsg._unreadCount = chat.unreadCount;
                        
                        // Pasamos al procesador normal. Si el bot está en waiting_human, 
                        // la IA en processIncomingMessage decidirá si debe reactivarse.
                        await processIncomingMessage(lastMsg);
                        count++;
                    }
                }
            } catch (err) {
                if (isCriticalBrowserError(err)) throw err; // Re-lanzar para que index.js reinicie
                const chatId = (chat && chat.id && chat.id._serialized) ? chat.id._serialized : 'ID DESCONOCIDO';
                if (!err.message.includes('waitForChatLoading')) {
                    console.error(`Error procesando chat ${chatId} en batch:`, err.message);
                }
            }
            await new Promise(r => setTimeout(r, 2000)); // Delay sutil
        }
    } catch (err) {
        if (isCriticalBrowserError(err)) {
            console.error('❌ CRITICAL BROWSER FAILURE IN BATCH SCAN:', err.message);
            throw err; // El caller en index.js debe forzar process.exit()
        }
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
5. *Liberar:* \`@bot libera a [Nombre]\` o \`liberar [tel]\`
6. *Pagar:* \`confirmar [tel]\` o \`si me llego [tel]\`
7. *Cobros Automáticos:* \`@bot cobros automáticos\`

Para leer el manual completo o ver cómo hablarme en lenguaje natural, escribe *@bot ayuda*.`;
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

📱 *3. Soporte en Grupos (Conversacional)*
Ahora puedes darme órdenes directas en el grupo usando *@bot*. No necesitas comandos rígidos, puedes decirme:
- *"@bot libera a Carlos Laura"*
- *"@bot cuánto saldo tiene pendiente el celular 573..."*
- *"@bot ¿cuántas netflix libres tenemos?"*

🤫 *4. Silencio Inteligente*
Si tú hablas manualmente, el bot se calla para no interrumpir. Solo intervendrá si tú cierras un trato comercial para ayudar con la logística del pago.
---

*Comandos Útiles:*
- \`@bot medios 573...\`: Envía datos bancarios a un cliente.
- \`@bot atiende pendientes\`: El bot toma el control de los chats sin leer.
- \`@bot libera a [Nombre]\`: Reactiva al bot para un cliente específico buscándolo por nombre.`;
    await message.reply(manual);
}

/**
 * Maneja el envío de credenciales masivo desde el grupo de administración.
 */
async function handleSendBulkCredentials(message, command, client, getAccountsByPhone, userStates, isReply = false) {
    const knownPlatforms = ['disney', 'netflix', 'amazon', 'spotify', 'max', 'paramount', 'crunchyroll', 'vix', 'youtube', 'canva', 'apple', 'plex', 'iptv', 'magis'];
    let requestedPlatform = null;
    for (const plat of knownPlatforms) {
        if (command.includes(plat)) { requestedPlatform = plat; break; }
    }
    
    let listText = command;
    if (!isReply && message.body.split('\n').length > 1) {
        listText = message.body.split('\n').slice(1).join('\n');
    }
    const regex = /57\s*3\d{2}\s*\d{7}|57\s*3\d{9}/g;
    const matches = listText.match(regex);
    
    if (!matches) {
       // Modo conversacional: pedir el número
       await message.reply(`🤖 ¿A qué número (incluyendo 57) deseas enviarle las credenciales${requestedPlatform ? ` de ${requestedPlatform.toUpperCase()}` : ''}?`);
       if (userStates) {
           userStates.set(message.from, { 
               state: 'awaiting_target_for_credentials', 
               platform: requestedPlatform || '' 
           });
       }
       return;
    }

    await message.reply(requestedPlatform ? `⏳ Enviando credenciales de *${requestedPlatform.toUpperCase()}*...` : '⏳ Enviando TODAS las credenciales...');
    
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
async function handleSendManualPaymentMethods(message, command, client, userStates, isReply = false) {
    const phoneRegex = /57\d{10}/;
    const match = command.match(phoneRegex);
    if (!match) {
        // Conversational Mode
        await message.reply('🤖 ¿A qué número (incluyendo 57) debo enviarle los canales de pago oficiales?');
        if (userStates) {
           userStates.set(message.from, { 
               state: 'awaiting_target_for_payment_methods'
           });
        }
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

/**
 * Analiza la base de clientes y sugiere qué cuentas de Netflix tienen cupos disponibles 
 * y coinciden (o son compatibles) con el operador del nuevo cliente.
 */
async function getNetflixMatchReport(targetIspInfo) {
    try {
        const { fetchCustomersData } = require('./apiService');
        const clientes = await fetchCustomersData();
        
        let report = `\n\n🚨 *MATCH PREDICTIVO PARA NETFLIX* 🚨\nInfo/Operador Cliente: ${targetIspInfo || 'N/A'}\n\n`;
        
        // Agrupar por correo de Netflix
        const netflixAccounts = new Map(); // correo -> { perfiles_activos: 0, perfiles_vencidos: 0, operadores: [] }
        
        for (const c of clientes) {
            const servicio = (c.Streaming || "").toLowerCase();
            if (servicio.includes("netflix") && !servicio.includes("extra")) {
                const correo = (c.correo || "Sin correo asignado").trim().toLowerCase();
                const operadorStr = (c.Operador || c.operador || c.observaciones || "").toString().toLowerCase();
                
                let isExpired = false;
                if (c.deben && !isNaN(parseFloat(c.deben))) {
                    const excelDate = parseFloat(c.deben);
                    const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    const compareDate = new Date(jsDate);
                    compareDate.setHours(0,0,0,0);
                    if (compareDate.getTime() < today.getTime()) isExpired = true;
                }
                
                if (!netflixAccounts.has(correo)) {
                    netflixAccounts.set(correo, { perfiles_activos: 0, perfiles_vencidos: 0, operadores: [] });
                }
                
                const accountData = netflixAccounts.get(correo);
                if (isExpired) {
                    accountData.perfiles_vencidos++;
                } else {
                    accountData.perfiles_activos++;
                }

                if (operadorStr) {
                    accountData.operadores.push(operadorStr + (isExpired ? " (vencido)" : ""));
                }
            }
        }
        
        const availableAccounts = [];
        netflixAccounts.forEach((data, correo) => {
            const total = data.perfiles_activos + data.perfiles_vencidos;
            // Asumimos máximo 4 perfiles simultáneos (sin contar extra)
            if ((total < 4 || data.perfiles_vencidos > 0) && correo !== "sin correo asignado") {
                availableAccounts.push({ 
                    correo, 
                    perfiles_activos: data.perfiles_activos,
                    perfiles_vencidos: data.perfiles_vencidos,
                    cupos_libres: Math.max(0, 4 - total),
                    operadores: data.operadores 
                });
            }
        });
        
        if (availableAccounts.length === 0) {
            report += "No hay cuentas de Netflix con cupos libres ni perfiles vencidos para cortar. Se requiere crear/adquirir una nueva cuenta.\n";
            return { rawReport: report, hasStock: false };
        }

        // Ordenar por afinidad al targetIspInfo, o simplemente listarlas
        let targetLower = (targetIspInfo || "").toLowerCase();
        
        availableAccounts.sort((a, b) => {
            const aHasMatch = targetLower && a.operadores.some(op => op.includes(targetLower) || targetLower.includes(op)) ? 1 : 0;
            const bHasMatch = targetLower && b.operadores.some(op => op.includes(targetLower) || targetLower.includes(op)) ? 1 : 0;
            if (aHasMatch > bHasMatch) return -1;
            if (aHasMatch < bHasMatch) return 1;
            
            // Priorizar si tiene cupos libres directos
            if (a.cupos_libres > 0 && b.cupos_libres === 0) return -1;
            if (a.cupos_libres === 0 && b.cupos_libres > 0) return 1;

            // Secundariamente, priorizar los que están más llenos para no desperdiciar cuentas a medias
            return (b.perfiles_activos + b.perfiles_vencidos) - (a.perfiles_activos + a.perfiles_vencidos);
        });

        report += `Cuentas sugeridas para emparejar (Libres o Cortables):\n`;
        availableAccounts.slice(0, 5).forEach((acc, i) => {
            const cleanOps = acc.operadores.filter(op => op.trim() !== "");
            let opsStr = cleanOps.length > 0 ? cleanOps.join(", ") : "Ninguno registrado";
            if (opsStr.length > 45) opsStr = opsStr.substring(0, 42) + "...";
            
            let status = "";
            if (acc.cupos_libres > 0) status += `${acc.cupos_libres} libres`;
            if (acc.perfiles_vencidos > 0) status += (status ? ", " : "") + `${acc.perfiles_vencidos} vencido(s) (cortables)`;
            
            report += `${i + 1}. *${acc.correo}*\n   - Estado: ${status} (${acc.perfiles_activos} activos)\n   - Ref: ${opsStr}\n`;
        });
        
        return { rawReport: report, hasStock: true };
    } catch (err) {
        console.error("Error generando match de Netflix:", err);
        return { rawReport: "\n\n⚠️ No se pudo generar reporte predictivo de Netflix.", hasStock: false };
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
  getUpcomingExpirationsReport,
  getNetflixMatchReport
};
