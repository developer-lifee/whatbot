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
                const { safeFetchMessages } = require('./salesService');
                const unreadCount = chat.unreadCount || 0;
                const fetchLimit = Math.max(unreadCount, 5);
                const messages = await safeFetchMessages(chat, fetchLimit);
                
                if (messages.length > 0) {
                    const chatId = chat.id._serialized;
                    const currentState = userStates.get(chatId);
                    const isSilenced = currentState && typeof currentState === 'object' && currentState.state === 'waiting_human';
                    
                    console.log(`[BATCH] Escaneando chat: ${chatId} (Unread: ${unreadCount}${isSilenced ? ', Silenced' : ''})`);

                    // Procesar todos los mensajes no leídos
                    const unreadMessages = unreadCount > 0 ? messages.slice(-unreadCount) : [];
                    // Si no hay no leídos (pero estaba en waiting_human), procesar al menos el último
                    const toProcess = unreadMessages.length > 0 ? unreadMessages : [messages[messages.length - 1]];

                    for (const m of toProcess) {
                        m._unreadCount = unreadCount; // Referencia para el procesador
                    }
                    await processIncomingMessage(toProcess);
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
    const funciones = `🤖 *CENTRO DE MANDO (Dashboard Conversacional)*

1. *Simulación:* \`@bot simula cliente\` (Prueba flujos)
2. *Búsqueda:* \`@bot busca a [nombre]\` (Fuzzy: Nombre/WA/Email)
3. *Ventas:* \`@bot haz una venta de [netflix] a [nombre]\`
4. *Pausar:* \`@bot duermete / despiertate\`
5. *Liberar:* \`@bot libera a [nombre]\` o \`liberar [tel]\`
6. *Pagar:* \`confirmar [tel]\` o \`si me llego [tel]\`
7. *Cobros:* \`@bot cobros automáticos\`

✨ *Tip:* Puedes preguntarme cosas como:
- "¿Qué acabaste de hacer?"
- "¿A quién le toca pagar mañana?"
- "Cambia el correo de Juan por pedro@mail.com"

Escribe *@bot ayuda* para el manual detallado.`;
    await message.reply(funciones);
}


/**
 * Muestra el manual detallado de funciones inteligentes.
 */
async function showDetailedHelp(message) {
    const manual = `📖 *MANUAL DE INTELIGENCIA ADMINISTRATIVA*

*1. MODO SIMULACIÓN* 🎭
- Di \`@bot simula que soy un cliente\`. El bot te tratará como usuario nuevo durante 5 mensajes. Ideal para probar menús y precios sin salir de tu chat.

*2. BÚSQUEDA Y EDICIÓN INTELIGENTE* 📝
- *Búsqueda:* Busca por nombre real o por nombre de WhatsApp.
- *Edición:* "Ponle de correo x@y.com a Maria", "Cambia la clave de netflix de Pedro".
- *Transparencia:* Si algo cambia, puedes preguntar "¿Qué hiciste?" para ver el detalle de filas y columnas.

*3. VENTAS AUTOMATIZADAS* 🚀
- "Registra una venta de Disney a Carlos". El bot buscará cupos libres en el Excel y los asignará solo.

*4. BROADCASTING (ENVÍO MASIVO)* 📡
- "Avisa a todos los de Disney que les toca cambiar de cuenta".
- "Manda credenciales a los de Netflix".

*5. CONTROL DE FLUJO* ⏳
- \`atiende a [tel]\`: Silencia al bot para ese cliente.
- \`@bot atiende pendientes\`: Escanea y procesa todos los chats sin leer.

_Versión 2.5 - Abril 2026_`;
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
    const phones = listText.match(regex);
    
    if (!requestedPlatform) {
        await message.reply('❌ No identifiqué la plataforma (netflix, disney, etc.)');
        return;
    }
    
    if (!phones || phones.length === 0) {
        if (!isReply) {
            userStates.set(GROUP_ID, { state: 'awaiting_target_for_credentials', platform: requestedPlatform });
            await message.reply(`🔍 No detecté números de teléfono en el mensaje.\n\n*Responde a este mensaje con los números o nombres de los clientes a los que quieres enviar las credenciales de ${requestedPlatform.toUpperCase()}.*`);
        } else {
            await message.reply('❌ No detecté números válidos para enviar.');
        }
        return;
    }

    await message.reply(`📡 Iniciando envío masivo de credenciales de *${requestedPlatform.toUpperCase()}* a ${phones.length} números...`);
    
    let success = 0;
    for (const phone of phones) {
        try {
            const cleanPhone = phone.replace(/\s+/g, '');
            const accounts = await getAccountsByPhone(cleanPhone);
            const targetAccount = accounts.find(a => (a.Streaming || '').toLowerCase().includes(requestedPlatform));
            
            if (targetAccount) {
                const creds = `🔐 *CREDENCIALES ${requestedPlatform.toUpperCase()}*\n\n📧 Correo: ${targetAccount.correo}\n🔒 Clave: ${targetAccount.contraseña}${targetAccount['pin perfil'] ? `\n🔢 PIN: ${targetAccount['pin perfil']}` : ''}`;
                await client.sendMessage(cleanPhone + '@c.us', creds);
                success++;
            }
        } catch (e) {
            console.error(`Error enviando a ${phone}:`, e.message);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    await message.reply(`✅ Envío finalizado. Se entregaron ${success} de ${phones.length} credenciales.`);
}

/**
 * Valida un pago comparándolo con Gmail y registrando la venta.
 */
async function executePaymentValidation(userId, userState, client, userStates, adminMessage = null) {
    const { findMatchingPayment } = require('./gmailService');
    const { recordNewSale } = require('./salesRegistryService');
    
    const amount = userState.total || 0;
    if (amount <= 0) return { success: false, message: "Monto no válido" };

    const match = await findMatchingPayment(amount, 60);
    if (!match) return { success: false, message: "No se encontró el pago en Gmail" };

    const results = await recordNewSale(userId, userState, `Gmail Match (${match.id})`);
    
    let report = `✅ *PAGO VALIDADO AUTOMÁTICAMENTE*\n\n`;
    results.forEach(res => {
        report += `- *${res.name}*: ${res.status === 'success' ? 'Asignada ✅' : 'Manual ⚠️'}\n`;
    });
    
    if (adminMessage) await adminMessage.reply(report);
    else await client.sendMessage(userId, "🤖 ¡Pago confirmado! Tus servicios han sido activados. 🎉");
    
    userStates.set(userId, { state: 'main_menu', nombre: userState.nombre });
    return { success: true };
}

/**
 * Realiza una prueba de escritura en el Excel.
 */
async function executeTestMode(message, client) {
    const { updateExcelData } = require('./apiService');
    const now = new Date().toLocaleString('es-CO');
    const testData = { "operador": `TEST EXITOSO: ${now}` };
    
    try {
        await updateExcelData(2, testData);
        await message.reply(`✅ *Prueba de Escritura Realizada*\n\nHe inyectado un timestamp en la *Fila 2, Columna Operador*. Por favor revisa tu Excel para confirmar que el cambio es visible.`);
    } catch (e) {
        await message.reply(`❌ *Error en la prueba de escritura:* ${e.message}`);
    }
}

/**
 * Maneja el reporte de próximas expiraciones.
 */
async function getUpcomingExpirationsReport() {
    const { fetchCustomersData, getTodayInBogota, getJsDateFromExcel } = require('./apiService');
    const today = getTodayInBogota();
    const next3Days = new Date(today);
    next3Days.setDate(today.getDate() + 3);
    
    try {
        const data = await fetchCustomersData();
        const upcoming = data.filter(c => {
            const expDate = getJsDateFromExcel(c.vencimiento);
            return expDate && expDate >= today && expDate <= next3Days;
        });
        
        if (upcoming.length === 0) return "No hay vencimientos programados para los próximos 3 días. ✅";
        
        let report = `📅 *VENCIMIENTOS PRÓXIMOS (3 DÍAS)*\n\n`;
        upcoming.forEach(c => {
            report += `- *${c.Nombre}* (${c.Streaming}): ${c.vencimiento}\n`;
        });
        return report;
    } catch (e) {
        return "Error generando reporte de vencimientos.";
    }
}

/**
 * Maneja el reporte de cuentas Netflix libres.
 */
async function getNetflixMatchReport(ispInfo = '') {
    const { fetchRawData } = require('./apiService');
    try {
        const data = await fetchRawData();
        const netflixLibres = data.filter(row => {
            const plat = (row['Streaming'] || '').toString().toLowerCase();
            const status = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
            const nombre = (row['Nombre'] || '').toString().toLowerCase();
            return plat.includes('netflix') && (status.includes('libre') || nombre === 'libre' || nombre === '');
        });
        
        const hasStock = netflixLibres.length > 0;
        let report = "";
        
        if (!hasStock) {
            report = "No hay cuentas de Netflix libres en este momento. ❌";
            return { rawReport: report, hasStock: false };
        }
        
        report = `📺 *CUENTAS NETFLIX DISPONIBLES*\n\n`;
        if (ispInfo) {
            report += `*🔍 Referencia operador cliente: ${ispInfo}*\n\n`;
        }
        
        netflixLibres.forEach(c => {
            report += `- ${c.correo} (${c['pin perfil'] || 'Sin PIN'})\n`;
        });
        
        return { rawReport: report, hasStock: true };
    } catch (e) {
        return { rawReport: "Error buscando cuentas de Netflix.", hasStock: false };
    }
}

/**
 * Maneja consultas genéricas del administrador usando IA y contexto del README.
 */
async function handleAdminSuggestions(message, userStates) {
    const fs = require('fs');
    const path = require('path');
    const { suggestAdminActions } = require('./aiService');
    
    // Leer arquitectura del README para darle "cerebro" técnico a la IA
    let readmeContext = "";
    try {
        const readmePath = path.join(__dirname, 'README.md');
        const readme = fs.readFileSync(readmePath, 'utf8');
        const start = readme.indexOf('# 🛠️ Arquitectura');
        if (start !== -1) readmeContext = readme.substring(start);
    } catch(e) {}

    const adminState = userStates.get(message.from) || {};
    const lastAction = adminState.lastAction ? JSON.stringify(adminState.lastAction, null, 2) : "No hay acciones recientes registradas.";

    const context = `
    ARQUITECTURA TÉCNICA:
    ${readmeContext}
    
    ÚLTIMA ACCIÓN REALIZADA:
    ${lastAction}
    
    INSTRUCCIÓN: Responde de forma conversacional (tipo Alexa/Asistente inteligente). 
    Si el usuario pide detalles técnicos o pregunta qué pasó, usa la información de ARQUITECTURA y ÚLTIMA ACCIÓN para explicar EXACTAMENTE qué filas o columnas se tocaron.
    Si algo no cambió, sugiere revisar los nombres de las columnas mencionados en el README.
    `;

    const result = await suggestAdminActions(message.body, context);
    
    if (result && result.replyMessage) {
        await message.reply(result.replyMessage + " 🤖");
    }
}

/**
 * Confirma manualmente un pago desde el grupo administrativo.
 */
async function handleAdminPaymentConfirmation(message, command, client, userStates, overridePhone = null) {
    let phone = overridePhone;
    if (!phone) {
        const regex = /57\s*3\d{2}\s*\d{7}|3\d{9}/g;
        const matches = command.match(regex);
        if (matches && matches.length > 0) {
            phone = matches[0].replace(/\s+/g, '');
            if (!phone.startsWith('57') && phone.length === 10) phone = '57' + phone;
        }
    }

    if (!phone) {
        await message.reply('❌ No pude identificar el número de teléfono en el comando.');
        return;
    }

    const userId = phone.includes('@') ? phone : phone + '@c.us';
    const displayPhone = userId.replace('@c.us', '');
    const stateData = userStates.get(userId);

    if (!stateData || !stateData.items) {
        await message.reply(`⚠️ No encontré una sesión de pago activa para el número ${displayPhone}. Asegúrate de que el bot le haya mostrado el total recientemente.`);
        return;
    }

    await message.reply(`⏳ Procesando confirmación manual para ${phone}...`);
    
    // Detectar meses si se especifican (ej: "2 meses", "3 mes")
    let overrideMonths = null;
    const monthsMatch = command.match(/(\d+)\s*mes/i);
    if (monthsMatch) {
        overrideMonths = parseInt(monthsMatch[1]);
        console.log(`[Admin] Se detectaron ${overrideMonths} meses en el comando.`);
    }

    try {
        const results = await recordNewSale(userId, stateData, "Confirmado por Admin", overrideMonths);
        
        let report = `✅ *PAGO PROCESADO*\nCliente: ${stateData.nombre || displayPhone}\n\n`;
        let someFailed = false;

        results.forEach(res => {
            if (res.status === 'success') {
                report += `- *${res.name}*: Auto-asignada (Fila ${res.rowNumber}) ✅\n`;
            } else if (res.status === 'no_slots_found') {
                report += `- *${res.name}*: SIN STOCK (Manual) ⚠️\n`;
                someFailed = true;
            } else {
                report += `- *${res.name}*: Registro Manual Requerido ⚠️\n`;
                someFailed = true;
            }
        });
        
        await message.reply(report);

        if (someFailed) {
            await client.sendMessage(userId, "🤖 ¡Tu pago ha sido verificado! 🎉\n\nSin embargo, para uno de tus servicios estamos preparando una cuenta nueva para ti. *Por favor danos unos 20 minutos* mientras un asesor completa la entrega. ¡Gracias por tu paciencia! 😊");
        } else {
            await client.sendMessage(userId, "🤖 ¡Tu pago ha sido verificado! Tus servicios han sido activados. 🎉\n\nYa puedes revisar tus credenciales actualizadas escribiendo *2* en el chat principal. ¡Disfruta! 😊");
        }
        
        // Limpiar estado
        userStates.set(userId, { state: 'main_menu', nombre: stateData.nombre });
    } catch (error) {
        console.error("[Admin Service] Error en confirmación manual:", error.message);
        await message.reply(`❌ Error al registrar: ${error.message}`);
    }
}

/**
 * Envía los métodos de pago de forma manual a un cliente.
 */
async function handleSendManualPaymentMethods(message, command, client, userStates) {
    const regex = /57\s*3\d{2}\s*\d{7}|3\d{9}/g;
    const matches = command.match(regex);
    if (!matches || matches.length === 0) {
        await message.reply('❌ No identifiqué el número del cliente.');
        return;
    }
    const phone = matches[0].replace(/\s+/g, '');
    const dest = (phone.startsWith('57') ? phone : '57' + phone) + '@c.us';

    const msg = `🤖 Hola, aquí tienes nuestros métodos de pago:\n\n⭐ *Nequi / Daviplata / Transfiya:* 3118587974\n⭐ *Bancolombia:* Ahorros 46772753713\n⭐ *Banco Caja Social:* 24111572331\n\nPor favor envía el comprobante por aquí una vez realices la transferencia.`;
    await client.sendMessage(dest, msg);
    await message.reply(`✅ Métodos de pago enviados a ${phone}.`);
}

/**
 * Recupera forzosamente una cuenta para el administrador, sin importar el stock.
 */
async function handleAdminForceRetrieve(message, command, client) {
    const platformName = command.replace('dame una de', '').replace('@bot', '').trim().toLowerCase();
    if (!platformName) {
        await message.reply("🤖 Jefe, dime de qué plataforma quieres la cuenta. Ej: `@bot dame una de Netflix`.");
        return;
    }

    await message.reply(`🤖 Buscando cualquier cuenta disponible de *${platformName}* para ti, jefe...`);

    try {
        const { fetchRawData } = require('./apiService');
        const allRows = await fetchRawData();
        const targetSearch = platformName.replace(/[^a-z0-9]/g, '');

        // Buscamos: 1. Libres, 2. Vencidas, 3. Cualquiera (aunque esté usada)
        let match = null;
        const rows = allRows.filter(r => {
            const rowStreaming = (r.Streaming || r.Plataforma || "").toString().toLowerCase().replace(/[^a-z0-9]/g, '');
            return rowStreaming.includes(targetSearch) || targetSearch.includes(rowStreaming);
        });

        if (rows.length === 0) {
            await message.reply(`❌ Jefe, no encontré ninguna fila que coincida con "${platformName}" en el Excel.`);
            return;
        }

        // 1. Intentar libre
        match = rows.find(r => !(r.whatsapp || r.whatsapp) || (r.Nombre || "").toLowerCase() === 'libre');
        
        // 2. Intentar vencida (si no hay libre)
        if (!match) {
            const { parseExcelDate } = require('./salesRegistryService');
            const now = new Date();
            match = rows.find(r => {
                const date = parseExcelDate(r.deben || r.Deben);
                return date && date < now;
            });
        }

        // 3. LA QUE SEA (si no hay ni libres ni vencidas)
        if (!match) {
            match = rows[0]; // La primera que aparezca
            await message.reply(`⚠️ Jefe, no hay cuentas libres ni vencidas de ${platformName}. Te paso una que está en uso actualmente:`);
        }

        // Formatear respuesta
        const correo = match.correo || match.Correo || match["E-mail"] || "N/A";
        const clave = match.contraseña || match.Clave || match.clave || "N/A";
        const pin = match["pin perfil"] || match.pin || "";
        const perfil = match.Nombre || match.nombre || match.Perfil || "";

        let response = `✅ *AQUÍ TIENES TU CUENTA, JEFE*\n\n`;
        response += `*Plataforma:* ${platformName.toUpperCase()}\n`;
        response += `*Correo:* ${correo}\n`;
        response += `*Clave:* ${clave}\n`;
        if (perfil) response += `*Perfil:* ${perfil}\n`;
        if (pin) response += `*PIN:* ${pin}\n`;
        
        await message.reply(response);

    } catch (error) {
        console.error("[Admin Force] Error:", error);
        await message.reply("❌ Error interno buscando la cuenta jefe.");
    }
}

module.exports = {
  processPendingChats,
  handleBatchUnanswered,
  showAdminFunctions,
  showDetailedHelp,
  handleSendBulkCredentials,
  executePaymentValidation,
  executeTestMode,
  getUpcomingExpirationsReport,
  getNetflixMatchReport,
  handleAdminSuggestions,
  handleAdminPaymentConfirmation,
  handleSendManualPaymentMethods,
  handleAdminForceRetrieve
};
