const { fetchRawData, updateExcelData } = require('./apiService');
const { recordNewSale } = require('./salesRegistryService');
const GROUP_ID = process.env.GROUP_ID || '120363102144405222@g.us';

function isCriticalBrowserError(err) {
    if (!err || !err.message) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('detached frame') ||
        msg.includes('execution context was destroyed') ||
        msg.includes('navigation failed') ||
        msg.includes('connection closed') ||
        msg.includes('cannot read properties of undefined') ||
        msg.includes('getchats');
}

function formatVencimientoDate(vencimiento) {
    if (!vencimiento) return "";
    try {
        const { getJsDateFromExcel } = require('./apiService');
        const jsDate = getJsDateFromExcel(vencimiento);
        if (jsDate && !isNaN(jsDate.getTime())) {
            const day = jsDate.getDate();
            const monthMatch = jsDate.toLocaleDateString('es-ES', { month: 'long' });
            const month = monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1);
            return `${day} de ${month}`;
        }
    } catch (e) {
        console.error("Error formatting date:", e);
    }
    return vencimiento;
}

/**
 * Función central para procesar chats con mensajes sin leer.
 * Puede ser llamada por un comando o por un proceso automático.
 */
async function processPendingChats(client, userStates, processIncomingMessage) {
    let count = 0;
    try {
        if (!client || !client.info) {
            console.log('[BATCH] Escaneo omitido: El cliente de WhatsApp no está listo.');
            return count;
        }
        const chats = await client.getChats();
        console.log(`[BATCH] Escaneo iniciado. Total chats recuperados: ${chats.length}`);

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

        console.log(`[BATCH] Chats pendientes detectados: ${pendingChats.length}`);

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

                    // Procesar solo mensajes que NO sean del bot y que no sean extremadamente antiguos (máximo 2 horas de antigüedad)
                    const twoHoursAgo = Math.floor(Date.now() / 1000) - (2 * 60 * 60);
                    const filteredMessages = toProcess.filter(m => !m.fromMe && m.timestamp > twoHoursAgo);

                    if (filteredMessages.length > 0) {
                        await processIncomingMessage(filteredMessages);
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

function getDynamicSupportExpectationMessage() {
    const { getTodayInBogota } = require('./apiService');
    const now = getTodayInBogota();
    const day = now.getDay(); // 0 is Sunday, 6 is Saturday
    const hours = now.getHours();
    const mins = now.getMinutes();
    const timeValue = hours + mins / 60;

    let isWorking = false;
    let nextShift = "";

    if (day >= 1 && day <= 5) { // Weekdays (Lunes a Viernes)
        // Katherine de 10 a 6 (10 a 18), Camilo de 6 a 10 (18 a 22) -> total de 10 a 22
        if (timeValue >= 10 && timeValue < 22) {
            isWorking = true;
        } else {
            nextShift = "mañana a partir de las 10:00 AM";
        }
    } else { // Weekend (Sat & Sun)
        // Esteban de 4 a 10 (16 a 22)
        if (timeValue >= 16 && timeValue < 22) {
            isWorking = true;
        } else {
            nextShift = day === 6 ? "hoy a partir de las 4:00 PM" : "mañana a partir de las 4:00 PM";
            if (day === 0 && timeValue >= 22) {
                nextShift = "el Lunes a partir de las 10:00 AM";
            }
        }
    }

    if (isWorking) {
        return "Un asesor está activo en este momento y te enviará la invitación por este chat en unos minutos. ¡Gracias por tu paciencia! 😊";
    } else {
        return `Ten en cuenta que nuestro horario de soporte es de Lunes a Viernes de 10:00 AM a 10:00 PM, y Sábados y Domingos de 4:00 PM a 10:00 PM. Un asesor te enviará la invitación ${nextShift}. ¡Muchas gracias por tu comprensión! 😊`;
    }
}

/**
 * Valida un pago comparándolo con Gmail y registrando la venta.
 */
async function executePaymentValidation(userId, userState, client, userStates, adminMessage = null, preMatchedId = null) {
    const { findMatchingPayment } = require('./gmailService');
    const { recordNewSale } = require('./salesRegistryService');

    const amount = userState.total || 0;
    if (amount <= 0) return { success: false, message: "Monto no válido" };

    let matchId = preMatchedId;
    if (!matchId) {
        const match = await findMatchingPayment(amount, 60);
        if (!match) return { success: false, message: "No se encontró el pago en Gmail" };
        matchId = match.id;
    }

    const results = await recordNewSale(userId, userState, `Gmail Match (${matchId})`);

    let report = `✅ *PAGO VALIDADO AUTOMÁTICAMENTE*\n\n`;
    results.forEach(res => {
        report += `- *${res.name}*: ${res.status === 'success' ? 'Asignada ✅' : 'Manual ⚠️'}\n`;
    });
    console.log(`[Payment Auto-Validate] ✅ Registro en Excel completado para ${userId}`);

    const targetJid = userState.chatJid || userId;

    if (adminMessage) {
        await adminMessage.reply(report);
    } else {
        try {
            let credentialsMsg = "🤖 ¡Tu pago ha sido verificado! Tus servicios han sido activados. 🎉\n\n";
            if (userState.leftoverAmount && userState.leftoverAmount > 0) {
                const originalTotal = (userState.total || 0) - userState.leftoverAmount;
                credentialsMsg += `💰 *Nota:* Tu transferencia fue por *$${(userState.total || 0).toLocaleString('es-CO')}*, superando el total del pedido que era de *$${originalTotal.toLocaleString('es-CO')}*. Te quedó un *saldo a favor de *$${userState.leftoverAmount.toLocaleString('es-CO')}* COP*. Un asesor revisará esto más tarde. 😊\n\n`;
            }
            credentialsMsg += "Aquí tienes tus credenciales:\n\n";
            let hasAnyCredentials = false;
            const { getMaskedAccessData } = require('./aiService');
            results.forEach(res => {
                if (res.status === 'success' && res.correo) {
                    hasAnyCredentials = true;
                    // res contiene la fila/datos de la cuenta en Excel. getMaskedAccessData espera los mismos campos.
                    const masked = getMaskedAccessData({
                        Streaming: res.name,
                        correo: res.correo,
                        contraseña: res.contraseña
                    });
                    
                    const labelPin = (res.name || "").toLowerCase().includes('spotify') ? "DIRECCIÓN/LINK" : "PIN";
                    const pinLine = res.pin ? `📌 ${labelPin}: \`${res.pin}\`\n` : "";
                    const vencStr = formatVencimientoDate(res.vencimiento);
                    const vencLine = vencStr ? `📅 Vence: *${vencStr}*\n` : "";
                    
                    credentialsMsg += `📺 *${masked.streamingName}*\n📧 Usuario: \`${masked.correo}\`\n🔑 Contraseña: \`${masked.clave}\`\n${pinLine}${vencLine}\n`;
                }
            });

            const manualItems = results.filter(res => res.status !== 'success');

            if (hasAnyCredentials) {
                const customerName = userState.nombre ? userState.nombre.split(' ')[0] : "";
                const profileTip = customerName ? `\n💡 *Importante:* Por favor crea tu perfil usando exactamente el nombre *${customerName}* (como está registrado en nuestro sistema) para poder llevar el control de tu cuenta. 😊` : `\n💡 *Importante:* Por favor crea tu perfil usando tu nombre registrado en nuestro sistema para poder llevar el control de tu cuenta. 😊`;
                credentialsMsg += profileTip;

                if (manualItems.length > 0) {
                    const manualPlats = manualItems.map(item => item.name.toUpperCase()).join(', ');
                    const expectation = getDynamicSupportExpectationMessage();
                    credentialsMsg += `\n\n⚠️ *Nota:* Tu servicio de *${manualPlats}* requiere activación manual o invitación familiar. ${expectation}`;
                    // Notificar al grupo de administración de la parte manual
                    try {
                        const groupChat = await client.getChatById(GROUP_ID);
                        if (groupChat) {
                            await groupChat.sendMessage(`🚨 *ACTIVACIÓN MANUAL PARCIAL REQUERIDA* (@${userId.replace('@c.us', '')})\n` +
                                `Servicios manuales: ${manualPlats}\n` +
                                `Por favor, envíale la invitación manualmente.`);
                        }
                    } catch (e) { }
                }

                await client.sendMessage(targetJid, credentialsMsg);

                if (manualItems.length > 0) {
                    const hasAppleOne = manualItems.some(item => (item.name || "").toLowerCase().includes('apple one'));
                    if (hasAppleOne) {
                        const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                            `Para poder enviarte la invitación familiar, por favor envíame en un solo mensaje:\n` +
                            `1. Tu número de teléfono celular\n` +
                            `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                            `*(Ejemplo: 3101234567, miusuario@gmail.com)*`;
                        await client.sendMessage(targetJid, appleMsg);

                        const otherManuals = manualItems.filter(item => !(item.name || "").toLowerCase().includes('apple one'));
                        if (otherManuals.length > 0) {
                            const otherPlats = otherManuals.map(item => item.name.toUpperCase()).join(', ');
                            const expectation = getDynamicSupportExpectationMessage();
                            await client.sendMessage(targetJid, `⚠️ *Nota:* Tus otros servicios (*${otherPlats}*) requieren activación manual por parte de un asesor. ${expectation}`);
                        }

                        userStates.set(userId, { state: 'awaiting_apple_one_details', chatJid: targetJid, lastPaymentValidated: Date.now() });
                    } else {
                        userStates.set(userId, { state: 'waiting_human', waitingCount: 1, chatJid: targetJid, lastPaymentValidated: Date.now() });
                    }
                    await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);
                    return { success: true };
                }
            } else {
                if (manualItems.length > 0) {
                    const hasAppleOne = manualItems.some(item => (item.name || "").toLowerCase().includes('apple one'));
                    if (hasAppleOne) {
                        const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                            `Para poder enviarte la invitación familiar, por favor envíame en un solo mensaje:\n` +
                            `1. Tu número de teléfono celular\n` +
                            `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                            `*(Ejemplo: 3101234567, miusuario@icloud.com)*`;
                        await client.sendMessage(targetJid, appleMsg);

                        const otherManuals = manualItems.filter(item => !(item.name || "").toLowerCase().includes('apple one'));
                        if (otherManuals.length > 0) {
                            const otherPlats = otherManuals.map(item => item.name.toUpperCase()).join(', ');
                            const expectation = getDynamicSupportExpectationMessage();
                            await client.sendMessage(targetJid, `⚠️ *Nota:* Tus otros servicios (*${otherPlats}*) requieren de una activación personalizada. ${expectation}`);
                        }

                        userStates.set(userId, { state: 'awaiting_apple_one_details', chatJid: targetJid, lastPaymentValidated: Date.now() });
                    } else {
                        let manualMsg = `🤖 ¡Tu pago ha sido verificado con éxito! 🎉\n\n`;
                        const platformsStr = manualItems.map(item => item.name.toUpperCase()).join(', ');
                        const expectation = getDynamicSupportExpectationMessage();
                        manualMsg += `Noté que tu servicio de *${platformsStr}* requiere de una activación personalizada, invitación de plan familiar o asignación manual.\n\n` +
                            `${expectation}`;
                        await client.sendMessage(targetJid, manualMsg);

                        // Notificar al grupo de administración de la venta manual
                        try {
                            const groupChat = await client.getChatById(GROUP_ID);
                            if (groupChat) {
                                await groupChat.sendMessage(`🚨 *ACTIVACIÓN MANUAL REQUERIDA* (@${userId.replace('@c.us', '')})\n` +
                                    `Servicios: ${platformsStr}\n` +
                                    `Monto: $${amount}\n` +
                                    `Por favor, un asesor debe enviarle la invitación o acceso manualmente.`);
                            }
                        } catch (e) { }

                        userStates.set(userId, { state: 'waiting_human', waitingCount: 1, chatJid: targetJid, lastPaymentValidated: Date.now() });
                    }
                    await applyLabelToChat(userId, client, ['pago', 'revisión', 'manual']);
                    return { success: true };
                }

                const successMsg = "🤖 ¡Tu pago ha sido verificado! Tus servicios han sido activados. 🎉\n\n" +
                    "Aquí tienes tus credenciales actualizadas:";
                await client.sendMessage(targetJid, successMsg);

                // --- ENTREGA AUTOMÁTICA (con delay de gracia de 6 segundos para permitir la sincronización de Azure/Excel) ---
                await new Promise(r => setTimeout(r, 6000));
                const { processCheckCredentials } = require('./billingService');
                await processCheckCredentials(targetJid, client, "Entrega automática tras pago", "");
            }
        } catch (deliveryErr) {
            console.error(`[Payment Auto-Validate] ❌ Error entregando credenciales a ${targetJid}:`, deliveryErr.message);
            await client.sendMessage(targetJid, "🤖 Tu pago fue validado con éxito, pero tuve un problema al enviarte las credenciales automáticamente. Por favor escribe *credenciales* en unos minutos o espera a que un asesor te ayude. 😊");
        }
    }

    await removeLabelFromChat(userId, client, ['pago', 'revisión', 'manual']);
    userStates.set(userId, { state: 'main_menu', nombre: userState.nombre, chatJid: userState.chatJid, lastPaymentValidated: Date.now() });
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
async function getUpcomingExpirationsReport(targetEmailsArray = null) {
    const { fetchCustomersData, getTodayInBogota, getJsDateFromExcel } = require('./apiService');
    const today = getTodayInBogota();

    // Ventana: Desde hace 2 días (ayer y antier) hasta dentro de 3 días
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 2);

    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 3);

    const fs = require('fs');
    const path = require('path');
    let managedEmails = [];

    // Cargar desde managed_emails.json (el listado completo de correos propios)
    const managedEmailsPath = path.join(__dirname, 'managed_emails.json');
    if (fs.existsSync(managedEmailsPath)) {
        try {
            const content = fs.readFileSync(managedEmailsPath, 'utf8');
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
                managedEmails = data.map(email => email.toLowerCase().trim());
            }
        } catch (err) {
            console.error("Error reading managed_emails.json for report:", err.message);
        }
    }

    // Cargar también desde la carpeta tokens/ (tokens de bandejas activas)
    const tokensDir = path.join(__dirname, 'tokens');
    if (fs.existsSync(tokensDir)) {
        try {
            const files = fs.readdirSync(tokensDir);
            files
                .filter(f => f.startsWith('token_') && f.endsWith('.json'))
                .map(f => f.replace('token_', '').replace('.json', '').toLowerCase().trim())
                .filter(email => email.includes('@') && email !== 'contacts')
                .forEach(email => {
                    if (!managedEmails.includes(email)) {
                        managedEmails.push(email);
                    }
                });
        } catch (err) {
            console.error("Error reading managed emails tokens for report:", err.message);
        }
    }

    try {
        const data = await fetchCustomersData();

        // 1. Filtrar por fecha y por la regla de Netflix (solo 'net' en método de pago)
        const upcoming = data.filter(c => {
            const expDate = getJsDateFromExcel(c.vencimiento);
            const isWithinWindow = expDate && expDate >= startDate && expDate <= endDate;
            if (!isWithinWindow) return false;

            const clientEmail = (c.correo || "").toString().toLowerCase().trim();
            
            // Omit target emails if they belong to our managed accounts (direct keys)
            if (managedEmails.includes(clientEmail)) return false;

            // If a specific list of provider emails is requested, restrict strictly to it
            if (targetEmailsArray && !targetEmailsArray.includes(clientEmail)) {
                return false;
            }

            return true;
        });

        if (upcoming.length === 0) return "No hay vencimientos programados para el periodo reportado. ✅";

        // 2. Agrupar por correo para evitar duplicados y mostrar el correo en lugar del nombre
        const uniqueAccounts = new Map();
        upcoming.forEach(c => {
            const email = (c.correo || "Sin Correo").trim();
            const streaming = (c.Streaming || "Servicio").toUpperCase();
            const key = `${email}|${streaming}`;

            if (!uniqueAccounts.has(key)) {
                uniqueAccounts.set(key, {
                    email,
                    streaming,
                    vencimiento: c.vencimiento
                });
            }
        });

        let report = `📅 *VENCIMIENTOS PRÓXIMOS (Ventana extendida)*\n\n`;
        uniqueAccounts.forEach(acc => {
            report += `• ${acc.email} (${acc.streaming}): ${acc.vencimiento}\n`;
        });

        return report;
    } catch (e) {
        console.error("Error generating expiration report:", e);
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
        const netflixLibres = data.filter((row, idx) => {
            const plat = (row['Streaming'] || '').toString().toLowerCase();
            const status = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
            const nombre = (row['Nombre'] || '').toString().toLowerCase();
            row._rowNumber = idx + 2; // store row index
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
            report += `*🔍 Referencia operador cliente buscado: ${ispInfo}*\n\n`;
        }

        netflixLibres.forEach(c => {
            const currentEmail = (c.correo || '').toString().trim().toLowerCase();
            report += `📧 *Cuenta: ${c.correo}* (PIN/Perfil Libre: ${c['pin perfil'] || c['perfil'] || 'Sin PIN'})\n`;
            
            // Find other active profiles in this same account
            const compañeros = data.filter((row, idx) => {
                const rowMail = (row['correo'] || row['Correo'] || '').toString().trim().toLowerCase();
                const rowPlat = (row['Streaming'] || row['streaming'] || '').toString().toLowerCase();
                const rowName = (row['Nombre'] || row['nombre'] || '').toString().trim().toLowerCase();
                const rowNum = idx + 2;
                return rowMail === currentEmail && 
                       rowPlat.includes('netflix') && 
                       rowName !== '' && 
                       rowName !== 'libre' &&
                       rowNum !== c._rowNumber;
            });
            
            if (compañeros.length > 0) {
                report += `   👥 *Compañeros activos en esta cuenta:*\n`;
                compañeros.forEach(comp => {
                    const compName = comp.Nombre || comp.nombre || 'Desconocido';
                    const compPhone = comp.numero || comp.Numero || 'Sin celular';
                    const compProfile = comp['pin perfil'] || comp['perfil'] || 'Sin Perfil';
                    const compIsp = comp.operador || comp.Operador || 'Sin operador/IP';
                    report += `   • Perfil: ${compProfile} | ${compName} (${compPhone}) | ISP: ${compIsp}\n`;
                });
            } else {
                report += `   👥 *Compañeros:* Ninguno activo aún en el Excel.\n`;
            }
            report += `\n`;
        });

        return { rawReport: report, hasStock: true };
    } catch (e) {
        return { rawReport: "Error buscando cuentas de Netflix: " + e.message, hasStock: false };
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
    } catch (e) { }

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

    // Detectar si el admin especificó una plataforma en el comando (ej: "confirmar 57... netflix")
    const platformWords = ['netflix', 'spotify', 'amazon', 'prime', 'hbo', 'max', 'disney', 'star', 'microsoft', 'crunchyroll', 'paramount', 'vix', 'apple', 'youtube', 'canva', 'magis', 'iptv', 'plex'];
    const mentionedPlatform = platformWords.find(p => command.toLowerCase().includes(p));

    let activeStateData = stateData;

    if (!activeStateData || !activeStateData.items || activeStateData.items.length === 0) {
        if (mentionedPlatform) {
            const newItem = { Streaming: mentionedPlatform, platform: { name: mentionedPlatform } };
            if (!activeStateData) {
                activeStateData = { state: 'awaiting_payment_confirmation', nombre: "Cliente", items: [newItem] };
            } else {
                activeStateData.items = [newItem];
            }
            userStates.set(userId, activeStateData);
        } else {
            let foundWebSale = false;
            try {
                const { pool } = require('./database');
                const cleanPhone = phone.replace(/\D/g, '');
                const [pendingRows] = await pool.query(
                    "SELECT * FROM web_sales_pending WHERE whatsapp LIKE ? OR whatsapp = ?",
                    [`%${cleanPhone}%`, cleanPhone]
                );
                if (pendingRows && pendingRows.length > 0) {
                    const webSale = pendingRows[0];
                    const cleanPlat = webSale.platformName;
                    const newItem = { Streaming: cleanPlat, platform: { name: cleanPlat } };
                    
                    await message.reply(`ℹ️ El cliente no tenía pedido activo, pero detecté una compra web pendiente de *${cleanPlat}* por $${webSale.amount} en el panel. Procediendo a confirmar...`);

                    if (!activeStateData) {
                        activeStateData = { 
                            state: 'awaiting_payment_confirmation', 
                            nombre: `${webSale.firstName} ${webSale.lastName}`.trim() || "Cliente", 
                            items: [newItem],
                            total: webSale.amount
                        };
                    } else {
                        activeStateData.items = [newItem];
                        activeStateData.nombre = `${webSale.firstName} ${webSale.lastName}`.trim() || activeStateData.nombre;
                        activeStateData.total = webSale.amount;
                    }
                    userStates.set(userId, activeStateData);
                    
                    activeStateData.webOrderId = webSale.order_id;
                    activeStateData.webSaleData = webSale;
                    foundWebSale = true;
                }
            } catch (webErr) {
                console.error('Error buscando venta web pendiente para confirmación:', webErr.message);
            }

            if (!foundWebSale) {
                // 1. INTENTO INTELIGENTE 1: Leer el historial del chat para ver qué plataforma solicitaba
                let fetchedItems = [];
                try {
                    const chat = await client.getChatById(userId);
                    await chat.syncHistory().catch(() => {});
                    const messages = await chat.fetchMessages({ limit: 15 });

                    if (messages && messages.length > 0) {
                        const chatHistory = messages.map(m => `${m.fromMe ? 'Bot' : 'Cliente'}: ${m.body}`).join('\n');
                        const lastClientMsg = [...messages].reverse().find(m => !m.fromMe && m.body);

                        if (lastClientMsg) {
                            const { parsePurchaseIntent } = require('./aiService');
                            const intent = await parsePurchaseIntent(lastClientMsg.body, chatHistory);

                            if (intent && intent.items && intent.items.length > 0) {
                                fetchedItems = intent.items.map(item => ({
                                    Streaming: item.platform,
                                    platform: { name: item.platform },
                                    plan: item.plan ? { name: item.plan } : null
                                }));
                                console.log(`[Admin Payment Auto-Recover] Recuperados items desde historial:`, fetchedItems);
                            }
                        }
                    }
                } catch (chatErr) {
                    console.error('Error recuperando historial del chat para confirmación:', chatErr.message);
                }

                if (fetchedItems.length > 0) {
                    const plist = fetchedItems.map(i => i.Streaming.toUpperCase()).join(', ');
                    await message.reply(`ℹ️ El cliente no tenía un pedido activo en memoria, pero leí su historial de conversación y detecté que estaba intentando adquirir *${plist}*. Procediendo a confirmar el pago...`);

                    if (!activeStateData) {
                        activeStateData = { state: 'awaiting_payment_confirmation', nombre: "Cliente", items: fetchedItems };
                    } else {
                        activeStateData.items = fetchedItems;
                    }
                    userStates.set(userId, activeStateData);
                } else {
                    // 2. INTENTO INTELIGENTE 2: Buscar en Excel las cuentas de este cliente
                    const { fetchRawData, getJsDateFromExcel, getTodayInBogota } = require('./apiService');
                    try {
                        const rawData = await fetchRawData();
                        const cleanPhone = phone.replace(/\D/g, '');

                        // Filtrar las cuentas de este número de teléfono
                        const clientRows = rawData.filter(row => {
                            const rowNum = (row.numero || row.whatsapp || '').toString().replace(/\D/g, '');
                            return rowNum.includes(cleanPhone) || cleanPhone.includes(rowNum);
                        });

                        if (clientRows.length > 0) {
                            const today = getTodayInBogota();

                            // Buscar cuentas vencidas o próximas a vencer (3 días)
                            const expiredOrExpiring = clientRows.filter(row => {
                                if (!row.deben && !row.vencimiento) return false;
                                const expDate = getJsDateFromExcel(row.deben || row.vencimiento);
                                if (!expDate) return false;
                                const diffDays = (expDate - today) / (1000 * 60 * 60 * 24);
                                return diffDays <= 3; // Vencida o vence en los próximos 3 días
                            });

                            if (expiredOrExpiring.length === 1) {
                                // Caso A: Hay exactamente UNA cuenta vencida o por vencer, ¡asumimos que pagó esa!
                                const targetRow = expiredOrExpiring[0];
                                const platName = (targetRow.Streaming || 'Streaming');
                                const newItem = { Streaming: platName, platform: { name: platName } };

                                await message.reply(`ℹ️ El cliente no tenía un pedido activo en memoria, pero detecté en Excel que su cuenta de *${platName.toUpperCase()}* está vencida o por vencer. Procediendo a confirmar pago para ese servicio...`);

                                if (!activeStateData) {
                                    activeStateData = { state: 'awaiting_payment_confirmation', nombre: targetRow.Nombre || "Cliente", items: [newItem] };
                                } else {
                                    activeStateData.items = [newItem];
                                }
                                userStates.set(userId, activeStateData);
                            } else if (expiredOrExpiring.length > 1) {
                                // Caso B: Múltiples cuentas vencidas
                                const list = expiredOrExpiring.map((r, i) => `${i + 1}. *${(r.Streaming || '').toUpperCase()}* (Vence: ${r.deben || r.vencimiento})`).join('\n');
                                await message.reply(`⚠️ El cliente no tiene un pedido activo y tiene múltiples cuentas vencidas o por vencer en Excel:\n\n${list}\n\nPor favor, especifica cuál pagó repitiendo el comando. Ej:\n*@bot confirmar ${displayPhone} ${(expiredOrExpiring[0].Streaming || 'Netflix')}*`);
                                return;
                            } else {
                                // Caso C: No hay vencidas, pero tiene activas
                                const list = clientRows.map((r, i) => `${i + 1}. *${(r.Streaming || '').toUpperCase()}* (Vence: ${r.deben || r.vencimiento})`).join('\n');
                                await message.reply(`⚠️ El cliente no tiene un pedido activo en el bot, pero tiene estas cuentas activas en Excel:\n\n${list}\n\nPor favor, repite el comando especificando la plataforma. Ej:\n*@bot confirmar ${displayPhone} ${(clientRows[0].Streaming || 'Netflix')}*`);
                                return;
                            }
                        } else {
                            // Sin cuentas en Excel
                            await message.reply(`⚠️ El cliente ${displayPhone} no tiene un pedido activo y no encontramos ninguna cuenta a su nombre en Excel.\n\nPor favor, especifica qué plataforma pagó agregando el nombre al final. Ej: *@bot confirmar ${displayPhone} Netflix*`);
                            return;
                        }
                    } catch (err) {
                        console.error('Error en búsqueda inteligente de confirmación:', err.message);
                        await message.reply(`⚠️ El cliente ${displayPhone} no tiene un pedido activo y falló la búsqueda en Excel. Por favor especifica la plataforma. Ej: *@bot confirmar ${displayPhone} Netflix*`);
                        return;
                    }
                }
            }
        }
    } else if (mentionedPlatform) {
        // Si el cliente tiene varios pendientes pero el admin solo menciona uno, filtramos
        const filtered = activeStateData.items.filter(item => {
            const name = (item.Streaming || item.name || "").toLowerCase();
            return name.includes(mentionedPlatform);
        });
        if (filtered.length > 0) {
            activeStateData.items = filtered;
            console.log(`[Admin Service] Filtrando confirmación solo para: ${mentionedPlatform}`);
        }
    }


    // Detectar meses si se especifican (ej: "2 meses", "3 mes")
    let overrideMonths = null;
    const monthsMatch = command.match(/(\d+)\s*mes/i);
    if (monthsMatch) {
        overrideMonths = parseInt(monthsMatch[1]);
    }

    try {
        const results = await recordNewSale(userId, activeStateData, "Confirmado por Admin", overrideMonths);

        if (activeStateData && activeStateData.webOrderId) {
            try {
                const { pool } = require('./database');
                const orderId = activeStateData.webOrderId;
                const customerData = activeStateData.webSaleData;
                await pool.query(
                    'INSERT INTO web_sales_approved (order_id, firstName, lastName, email, whatsapp, platformName, amount, numbersStr, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        orderId,
                        customerData.firstName || '',
                        customerData.lastName || '',
                        customerData.email || '',
                        customerData.whatsapp || '',
                        customerData.platformName || '',
                        customerData.amount || 0,
                        customerData.numbersStr || '',
                        customerData.createdAt ? new Date(customerData.createdAt) : null
                    ]
                );
                await pool.query('DELETE FROM web_sales_pending WHERE order_id = ?', [orderId]);
                console.log(`[Admin Confirm] Venta web ${orderId} marcada como aprobada en DB.`);
            } catch (dbErr) {
                console.error("Error al aprobar venta web desde confirmación manual:", dbErr.message);
            }
        }

        let report = `✅ *PAGO PROCESADO*\nCliente: ${(activeStateData && activeStateData.nombre) || displayPhone}\n\n`;
        results.forEach(res => {
            if (res.status === 'success') {
                report += `- *${res.name}*: Fila ${res.rowNumber} ✅\n`;
            } else {
                report += `- *${res.name}*: MANUAL ⚠️\n`;
            }
        });
        await message.reply(report);

        const manualItems = results.filter(res => res.status !== 'success');
        const hasAnyCredentials = results.some(res => res.status === 'success' && res.correo);

        if (hasAnyCredentials) {
            let credentialsMsg = "🤖 ¡Tu pago ha sido verificado! Tus servicios han sido activados. 🎉\n\nAquí tienes tus credenciales:\n\n";
            const { getMaskedAccessData } = require('./aiService');
            results.forEach(res => {
                if (res.status === 'success' && res.correo) {
                    const masked = getMaskedAccessData(res);
                    
                    const labelPin = (res.name || "").toLowerCase().includes('spotify') ? "DIRECCIÓN/LINK" : "PIN";
                    const pinLine = res.pin ? `📌 ${labelPin}: \`${res.pin}\`\n` : "";
                    const vencStr = formatVencimientoDate(res.vencimiento);
                    const vencLine = vencStr ? `📅 Vence: *${vencStr}*\n` : "";
                    
                    credentialsMsg += `📺 *${masked.streamingName}*\n📧 Usuario: \`${masked.correo}\`\n🔑 Contraseña: \`${masked.clave}\`\n${pinLine}${vencLine}\n`;
                }
            });

            let customerName = "";
            if (activeStateData && activeStateData.nombre && activeStateData.nombre !== "Cliente" && activeStateData.nombre !== "Cliente WhatsApp") {
                customerName = activeStateData.nombre.split(' ')[0];
            } else {
                try {
                    const { searchContactByPhone } = require('./googleContactsService');
                    const contactName = await searchContactByPhone(phone.replace(/\D/g, ''));
                    if (contactName && contactName !== "Cliente WhatsApp") {
                        customerName = contactName.split(' ')[0];
                    }
                } catch (e) { }
            }
            const profileTip = customerName ? `\n💡 *Importante:* Por favor crea tu perfil usando exactamente el nombre *${customerName}* (como está registrado en nuestro sistema) para poder llevar el control de tu cuenta. 😊` : `\n💡 *Importante:* Por favor crea tu perfil usando tu nombre registrado en nuestro sistema para poder llevar el control de tu cuenta. 😊`;
            credentialsMsg += profileTip;

            if (manualItems.length > 0) {
                const manualPlats = manualItems.map(item => item.name.toUpperCase()).join(', ');
                credentialsMsg += `\n\n⚠️ *Nota:* Para tu servicio de *${manualPlats}*, estamos preparando una cuenta nueva para ti. *Por favor danos unos 20 minutos*. 😊`;
            }

            await client.sendMessage(userId, credentialsMsg);

            const appleOneItem = manualItems.find(item => item.name.toLowerCase().includes('apple one'));
            if (appleOneItem) {
                const appleMsg = `🤖 Para poder enviarte la invitación familiar de *Apple One*, por favor envíame en un solo mensaje:\n` +
                    `1. Tu número de teléfono celular\n` +
                    `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                    `*(Ejemplo: 3101234567, miusuario@icloud.com)*`;
                await client.sendMessage(userId, appleMsg);
                userStates.set(userId, { state: 'awaiting_apple_one_details', chatJid: userId, nombre: (activeStateData && activeStateData.nombre) || "Cliente", lastPaymentValidated: Date.now() });
            } else {
                userStates.set(userId, { state: 'main_menu', nombre: (activeStateData && activeStateData.nombre) || "Cliente", lastPaymentValidated: Date.now() });
            }
        } else {
            // No credentials delivered (all manual or failed)
            const appleOneItem = manualItems.find(item => item.name.toLowerCase().includes('apple one'));
            if (appleOneItem) {
                const appleMsg = `🤖 ¡Tu pago de *Apple One* ha sido verificado con éxito! 🎉\n\n` +
                    `Para poder enviarte la invitación familiar, por favor envíame en un solo mensaje:\n` +
                    `1. Tu número de teléfono celular\n` +
                    `2. Tu correo electrónico (que usas como Apple ID)\n\n` +
                    `*(Ejemplo: 3101234567, miusuario@icloud.com)*`;
                await client.sendMessage(userId, appleMsg);

                const otherFailed = manualItems.filter(item => !item.name.toLowerCase().includes('apple one'));
                if (otherFailed.length > 0) {
                    const manualPlats = otherFailed.map(item => item.name.toUpperCase()).join(', ');
                    await client.sendMessage(userId, `🤖 Para tus otros servicios (*${manualPlats}*), estamos preparando una cuenta nueva para ti. *Por favor danos unos 20 minutos*. 😊`);
                }

                userStates.set(userId, { state: 'awaiting_apple_one_details', chatJid: userId, nombre: (activeStateData && activeStateData.nombre) || "Cliente", lastPaymentValidated: Date.now() });
            } else {
                const manualPlats = manualItems.map(item => item.name.toUpperCase()).join(', ');
                await client.sendMessage(userId, `🤖 ¡Tu pago ha sido verificado! 🎉\n\nSin embargo, para tu servicio de *${manualPlats}* estamos preparando una cuenta nueva para ti. *Por favor danos unos 20 minutos*. 😊`);
                userStates.set(userId, { state: 'main_menu', nombre: (activeStateData && activeStateData.nombre) || "Cliente", lastPaymentValidated: Date.now() });
            }
        }

        // Limpiar estado
        userStates.set(userId, { state: 'main_menu', nombre: (activeStateData && activeStateData.nombre) || "Cliente" });
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

    const msg = `🤖 Hola, aquí tienes nuestros métodos de pago oficiales:\n\n⚡ *METODOS DE VALIDACIÓN AUTOMÁTICA (Entrega Inmediata):*\n⭐ *QR de Negocios (RECOMENDADO)*\n⭐ *Llave Bre-V (Recomendada - Nequi/Daviplata/Ahorro):* *0087387259*\n⭐ *Bancolombia (Abono Directo):* Ahorros *46772753713* (CC: *1032936324*)\n\n⏳ *OTRAS OPCIONES (Verificación Manual por Asesor):*\n⭐ *Llave Bre-B alternativa:* *3118587974*\n⭐ *Banco Caja Social:* Ahorros *24111572331* (CC: *1032936324*)\n\n💡 *Tip:* Si pagas por los métodos automáticos, ¡el bot validará tu transferencia en segundos y te entregará la cuenta al instante! 🤖`;
    await client.sendMessage(dest, msg);
    await message.reply(`✅ Métodos de pago enviados a ${phone}.`);
}

/**
 * Recupera forzosamente una cuenta para el administrador, sin importar el stock.
 */
/**
 * Notifica al proveedor sobre las cuentas que están próximas a vencer.
 */
async function notifyProviderExpiringAccounts(client) {
    try {
        const { pool } = require('./database');
        
        // 1. Get all unique providers that have a phone number registered
        const [providers] = await pool.query(
            "SELECT DISTINCT provider_name, phone FROM provider_credentials WHERE phone IS NOT NULL AND phone != ''"
        );

        if (!providers || providers.length === 0) {
            console.log("[Automation] No se encontraron proveedores con número de WhatsApp registrado para notificaciones.");
            return;
        }

        // 2. Group by phone number (in case a provider has multiple platform accounts under different credentials)
        const groupedProviders = new Map();
        providers.forEach(p => {
            const cleanPhone = p.phone.replace(/\D/g, '');
            if (cleanPhone.length >= 8) {
                const jid = `${cleanPhone.startsWith('57') ? cleanPhone : '57' + cleanPhone}@c.us`;
                if (!groupedProviders.has(jid)) {
                    groupedProviders.set(jid, new Set());
                }
                groupedProviders.get(jid).add(p.provider_name);
            }
        });

        // 3. Process each provider phone number
        for (const [providerJid, providerNamesSet] of groupedProviders.entries()) {
            const providerNames = Array.from(providerNamesSet);
            console.log(`[Automation] Generando reporte de vencimientos para proveedores: [${providerNames.join(', ')}] -> ${providerJid}`);

            // Fetch all account emails assigned to these provider names
            const [accounts] = await pool.query(
                "SELECT account_email FROM stream_accounts WHERE provider_name IN (?)",
                [providerNames]
            );

            if (!accounts || accounts.length === 0) {
                console.log(`[Automation] Proveedores [${providerNames.join(', ')}] no tienen cuentas asociadas activas.`);
                continue;
            }

            const targetEmails = accounts.map(a => a.account_email.toLowerCase().trim());

            // Generate targeted report containing only this provider's emails
            const report = await getUpcomingExpirationsReport(targetEmails);
            if (report.includes("No hay vencimientos programados") || report.includes("Error generando reporte")) {
                console.log(`[Automation] No hay vencimientos próximos para el proveedor ${providerJid}.`);
                continue;
            }

            const msg = `🤖 *AVISO DE RENOVACIONES PRÓXIMAS*\n\nHola, te paso el reporte de las cuentas que vencen pronto para gestionar las renovaciones:\n\n${report}`;

            await client.sendMessage(providerJid, msg);
            console.log(`[Automation] Reporte de vencimientos enviado con éxito a ${providerJid} (${providerNames.join(', ')}).`);
        }
    } catch (error) {
        console.error("Error en notifyProviderExpiringAccounts:", error);
    }
}

async function handleAdminForceRetrieve(message, command, client, targetUser = null) {
    // Regex para extraer la plataforma de forma más precisa
    const platformMatch = command.match(/(?:dame una de|pásame|pasa cuenta de|pasa la de|cuenta de|dame la de)\s+([a-zA-Z0-9\s.]+)/i);
    const platformName = platformMatch ? platformMatch[1].trim().toLowerCase() : command.replace('@bot', '').trim().toLowerCase();

    if (!platformName || platformName.length > 30) { // Si es muy largo, probablemente no es solo la plataforma
        return; // Dejar que pase a processAdminQuery en index.js
    }

    await message.reply(`🤖 Buscando cualquier cuenta disponible de *${platformName}* para ${targetUser || 'ti'}, jefe...`);

    try {
        const { fetchRawData } = require('./apiService');
        const allRows = await fetchRawData();
        const targetSearch = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');

        // 1. BUSCAR CUENTA DISPONIBLE
        let match = null;
        const rows = allRows.filter(r => {
            const rowStreaming = (r.Streaming || r.Plataforma || "").toString().toLowerCase().replace(/[^a-z0-9]/g, '');
            return rowStreaming.includes(targetSearch) || targetSearch.includes(rowStreaming);
        });

        if (rows.length === 0) {
            await message.reply(`❌ Jefe, no encontré ninguna fila que coincida con "${platformName}" en el Excel.`);
            return;
        }

        // Prioridad: 1. Libre, 2. Vencida, 3. Cualquiera
        match = rows.find(r => !(r.whatsapp || r.whatsapp) || (r.Nombre || "").toLowerCase() === 'libre');
        if (!match) {
            const { parseExcelDate } = require('./salesRegistryService');
            const now = new Date();
            match = rows.find(r => {
                const date = parseExcelDate(r.deben || r.Deben);
                return date && date < now;
            });
        }
        if (!match) match = rows[0];

        // 2. IDENTIFICAR DESTINATARIO
        let recipientId = message.from; // Por defecto el remitente (admin)
        let recipientDisplay = "ti, jefe";

        if (targetUser) {
            const cleanTarget = targetUser.toString().replace(/\D/g, '');
            if (cleanTarget.length >= 8) {
                recipientId = (cleanTarget.startsWith('57') ? cleanTarget : '57' + cleanTarget) + '@c.us';
                recipientDisplay = `el número ${cleanTarget}`;
            } else {
                // Es un nombre, buscamos en el Excel
                const userRow = allRows.find(r => {
                    const rowName = (r.Nombre || r['Nombre Completo'] || "").toString().toLowerCase();
                    return rowName.includes(targetUser.toLowerCase());
                });
                if (userRow && userRow.numero) {
                    const tel = userRow.numero.toString().replace(/\D/g, '');
                    recipientId = (tel.startsWith('57') ? tel : '57' + tel) + '@c.us';
                    recipientDisplay = `*${userRow.Nombre || targetUser}*`;
                } else {
                    await message.reply(`⚠️ Jefe, no encontré a nadie llamado "${targetUser}" en la base de datos para enviarle la cuenta. Te la paso a ti:`);
                }
            }
        }

        // 3. FORMATEAR Y ENVIAR
        const correo = match.correo || match.Correo || match["E-mail"] || "N/A";
        const clave = match.contraseña || match.Clave || match.clave || "N/A";
        const pin = match["pin perfil"] || match.pin || "";
        const perfil = match.Nombre || match.nombre || match.Perfil || "";

        let response = `✅ *AQUÍ TIENES TU CUENTA*\n\n`;
        response += `*Plataforma:* ${platformName.toUpperCase()}\n`;
        response += `*Correo:* ${correo}\n`;
        response += `*Clave:* ${clave}\n`;
        if (perfil) response += `*Perfil:* ${perfil}\n`;
        if (pin) response += `*PIN:* ${pin}\n`;

        await client.sendMessage(recipientId, response);

        if (recipientId !== message.from) {
            await message.reply(`✅ Cuenta de ${platformName.toUpperCase()} enviada exitosamente a ${recipientDisplay}.`);
        }

    } catch (error) {
        console.error("[Admin Force] Error:", error);
        await message.reply("❌ Error interno buscando la cuenta jefe.");
    }
}

/**
 * Genera un reporte de chats con estados pendientes (esperando humano, etc.)
 */
async function getPendientesReport(userStates) {
    let report = "📝 *CHATS PENDIENTES DE ATENCIÓN*:\n\n";
    let count = 0;

    for (const [userId, state] of userStates.entries()) {
        if (state && (state.state === 'waiting_human' || state.state === 'awaiting_payment_confirmation')) {
            count++;
            const status = state.state === 'waiting_human' ? '🆘 Esperando Asesor' : '💰 Esperando Pago';
            report += `• @${userId.replace('@c.us', '')} [${status}]\n`;
        }
    }

    if (count === 0) return "✅ No hay chats pendientes de atención en este momento.";
    return report + `\nTotal: ${count} pendientes.`;
}

async function applyLabelToChat(userId, client, labelSearchNames = ['pago', 'revisión', 'manual']) {
    try {
        const chat = await client.getChatById(userId);
        const allLabels = await client.getLabels();
        
        let targetLabel = null;
        for (const searchName of labelSearchNames) {
            targetLabel = allLabels.find(l => (l.name || '').toLowerCase().trim() === searchName.toLowerCase().trim());
            if (targetLabel) break;
        }

        if (targetLabel) {
            let currentLabelIds = [];
            try {
                const currentLabels = await chat.getLabels();
                currentLabelIds = (currentLabels || []).map(l => l.id);
            } catch (e) {
                console.warn("[Label Helper] No se pudieron obtener etiquetas actuales del chat, usando array vacío:", e.message);
            }

            if (!currentLabelIds.includes(targetLabel.id)) {
                currentLabelIds.push(targetLabel.id);
                await chat.changeLabels(currentLabelIds);
                console.log(`[Label Helper] Etiqueta "${targetLabel.name}" aplicada con éxito al chat ${userId}`);
            } else {
                console.log(`[Label Helper] El chat ${userId} ya tiene la etiqueta "${targetLabel.name}"`);
            }
        } else {
            console.log(`[Label Helper] No se encontró ninguna etiqueta en WhatsApp Business que coincida exactamente con: ${labelSearchNames.join(', ')}`);
        }
    } catch (err) {
        console.error("[Label Helper] Error al aplicar etiqueta al chat:", err.message);
    }
}

async function removeLabelFromChat(userId, client, labelSearchNames = ['pago', 'revisión', 'manual']) {
    try {
         const chat = await client.getChatById(userId);
         const allLabels = await client.getLabels();
         
         let targetLabel = null;
         for (const searchName of labelSearchNames) {
             targetLabel = allLabels.find(l => (l.name || '').toLowerCase().trim() === searchName.toLowerCase().trim());
             if (targetLabel) break;
         }

         if (targetLabel) {
            let currentLabels = [];
            try {
                currentLabels = await chat.getLabels();
            } catch (e) {
                return;
            }
            const currentLabelIds = (currentLabels || []).map(l => l.id);

            if (currentLabelIds.includes(targetLabel.id)) {
                const updatedLabelIds = currentLabelIds.filter(id => id !== targetLabel.id);
                await chat.changeLabels(updatedLabelIds);
                console.log(`[Label Helper] Etiqueta "${targetLabel.name}" removida con éxito del chat ${userId}`);
            }
        }
    } catch (err) {
        console.error("[Label Helper] Error al remover etiqueta del chat:", err.message);
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
    handleAdminForceRetrieve,
    notifyProviderExpiringAccounts,
    getPendientesReport,
    getDynamicSupportExpectationMessage,
    applyLabelToChat,
    removeLabelFromChat
};
