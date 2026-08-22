const { updateExcelData, fetchRawData } = require('./apiService');
const { getAvailabilityConfig, normalizeStreamingName } = require('./availabilityService');

function getLevenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

const FAMILY_KEYWORDS = ['youtube', 'apple', 'microsoft', 'google', 'spotify individual', 'spotify personal', 'spotify familiar', 'familiar', 'family', 'xbox', 'netflix extra', 'extra', 'individual', 'personal', 'correo propio', 'tu correo'];

function isSamePlatformFamily(name1, name2) {
    if (!name1 || !name2) return false;
    const n1 = normalizeStreamingName(name1);
    const n2 = normalizeStreamingName(name2);

    // REGLA CRÍTICA 1: Cuentas OWNER / PROPORCIONADO no deben emparejarse con cuentas PERSONAL / INDIVIDUAL / FAMILIAR
    const isOwner1 = n1.includes('owner') || name1.toLowerCase().includes('owner') || name1.toLowerCase().includes('proporcionado');
    const isOwner2 = n2.includes('owner') || name2.toLowerCase().includes('owner') || name2.toLowerCase().includes('proporcionado');
    if (isOwner1 !== isOwner2) return false;

    // REGLA CRÍTICA 2: Planes PLATINO / PLATINUM no deben emparejarse con planes ESTÁNDAR / NORMALES
    const isPlatino1 = n1.includes('platino') || name1.toLowerCase().includes('platino') || name1.toLowerCase().includes('platinum');
    const isPlatino2 = n2.includes('platino') || name2.toLowerCase().includes('platino') || name2.toLowerCase().includes('platinum');
    if (isPlatino1 !== isPlatino2) return false;

    // REGLA CRÍTICA 3: Cuentas EXTRA no deben emparejarse con cuentas normales
    const isExtra1 = n1.includes('extra') || name1.toLowerCase().includes('extra');
    const isExtra2 = n2.includes('extra') || name2.toLowerCase().includes('extra');
    if (isExtra1 !== isExtra2) return false;

    // REGLA CRÍTICA 4: Tiers específicos (ej: netflix_extra, hbo_platino, spotify_owner, youtube_owner) no deben cruzarse entre sí
    if (n1 !== n2) {
        if ((n1 === 'disney' && n2 === 'disney_premium') || (n1 === 'disney_premium' && n2 === 'disney')) {
            return true;
        }
        const specificTiers = ['hbo_platino', 'netflix_extra', 'spotify_owner', 'youtube_owner', 'appletv', 'appleone'];
        if (specificTiers.includes(n1) || specificTiers.includes(n2)) {
            return false;
        }
    }

    if (n1 === n2) return true;
    
    const families = [
        ['hbo', 'hbo_platino', 'max'],
        ['netflix', 'netflix_extra'],
        ['spotify', 'spotify_familiar', 'spotify_personal', 'spotify_individual'],
        ['disney', 'disney_premium', 'disney_standard'],
        ['apple', 'apple_one', 'apple_tv', 'appletv'],
        ['gemini', 'gemini_pro', 'gemini_pro_compartida'],
        ['youtube', 'youtube_premium', 'youtube_familiar', 'youtube_individual'],
        ['microsoft', 'microsoft_365', 'office', 'office_365', 'outlook'],
        ['prime', 'amazon_prime', 'prime_video'],
        ['vix', 'vix_premium']
    ];
    
    const mainRoots = ['gemini', 'apple', 'youtube', 'spotify', 'disney', 'hbo', 'netflix', 'microsoft', 'office', 'prime', 'vix', 'crunchyroll', 'claude', 'chatgpt', 'gpt'];
    for (const root of mainRoots) {
        let normalizedN1 = n1.replace(/chatgpt|chat gpt/g, 'gpt');
        let normalizedN2 = n2.replace(/chatgpt|chat gpt/g, 'gpt');
        if (normalizedN1.includes(root) && normalizedN2.includes(root)) {
            return true;
        }
    }

    return false;
}

/**
 * Calcula la fecha del próximo pago sumando los meses correspondientes.
 * @param {string} subscriptionType - 'mensual', 'semestral', 'anual'
 * @returns {string} Fecha en formato DD/MM/YYYY
 */
/**
 * Calcula la fecha del próximo pago sumando los meses correspondientes.
 * @param {string} subscriptionType - 'mensual', 'semestral', 'anual'
 * @param {number} overrideMonths - Opcional, cantidad de meses a sumar
 * @param {string|Date} baseDate - Opcional, fecha base desde la cual sumar (ej: vencimiento anterior)
 * @returns {string} Fecha en formato YYYY-MM-DD
 */
function calculateNextPaymentDate(subscriptionType, overrideMonths = null, baseDate = null) {
    let now = new Date();

    if (baseDate) {
        const { getJsDateFromExcel } = require('./apiService');
        const parsedBase = (baseDate instanceof Date) ? baseDate : getJsDateFromExcel(baseDate);

        if (parsedBase && !isNaN(parsedBase.getTime())) {
            // Regla: Si la fecha base es mayor a 15 días en el pasado, usamos hoy para no "renovar en el pasado"
            // Pero si es solo un retraso normal (ej: 1-5 días), mantenemos el ciclo original.
            const diffDays = (new Date() - parsedBase) / (1000 * 60 * 60 * 24);
            if (diffDays < 15) {
                now = new Date(parsedBase.getTime());
            }
        }
    }

    let monthsToAdd = 1;
    if (overrideMonths) {
        monthsToAdd = overrideMonths;
    } else {
        if (subscriptionType === 'trimestral') monthsToAdd = 3;
        else if (subscriptionType === 'semestral') monthsToAdd = 6;
        else if (subscriptionType === 'anual') monthsToAdd = 12;
    }

    now.setMonth(now.getMonth() + monthsToAdd);

    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();

    return `${year}-${month}-${day}`;
}

/**
 * Formatea un número de teléfono al estilo Sheerit: "57 3XX XXXXXXX"
 * Asegura un espacio después del indicativo 57 para evitar formatos feos en Excel.
 */
function formatWhatsAppNumber(phone) {
    const clean = phone.replace(/\D/g, '');
    if (clean.startsWith('57') && clean.length === 12) {
        return `57 ${clean.slice(2, 5)} ${clean.slice(5)}`;
    }
    if (clean.length === 10 && clean.startsWith('3')) {
        return `57 ${clean.slice(0, 3)} ${clean.slice(3)}`;
    }
    return clean;
}

/**
 * Intenta convertir una cadena de fecha (DD/MM/YYYY o similar) a objeto Date.
 */
function parseExcelDate(dateStr) {
    if (!dateStr || dateStr.toString().trim() === "") return null;
    try {
        const parts = dateStr.toString().split('/');
        if (parts.length === 3) {
            // Asumimos DD/MM/YYYY
            return new Date(parts[2], parts[1] - 1, parts[0]);
        }
        return new Date(dateStr);
    } catch (e) {
        return null;
    }
}

/**
 * Busca un cupo disponible para una plataforma específica.
 * Un cupo es "disponible" si la plataforma coincide y el campo 'whatsapp' o 'Nombre' está vacío.
 */
function findAvailableSlot(platformName, allRows) {
    const targetPlatform = normalizeStreamingName(platformName);
    const config = getAvailabilityConfig();

    for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        const rowStreaming = normalizeStreamingName(row.Streaming || row.Plataforma);

        if (!rowStreaming) continue;

        // Si la plataforma coincide
        if (rowStreaming === targetPlatform || isSamePlatformFamily(rowStreaming, targetPlatform)) {
            const email = (row.correo || row.Correo || "").toString().toLowerCase().trim();
            if (email && config[email] && config[email].immediate === false) {
                continue;
            }

            const whatsapp = (row.whatsapp || row.whatsapp || "").toString().trim();
            const nombre = (row.Nombre || row.nombre || "").toString().trim();

            // Solo usamos filas que están vacías o marcadas como 'libre' (STOCK real)
            if (!whatsapp && (!nombre || nombre.toLowerCase() === 'libre')) {
                return { rowData: row, index: i + 2 };
            }
        }
    }
    return null;
}

/**
 * Registra una venta intentando llenar cupos existentes.
 */
async function recordNewSale(userId, userState, paymentMethod, overrideMonths = null) {
    const months = overrideMonths || userState.durationMonths || null;
    console.log(`[Sales Registry] Procesando registro inteligente para ${userId} (${months || 'auto'} meses)...`);

    try {
        const items = userState.items || [];
        const subscriptionType = userState.subscriptionType || 'mensual';

        // 1. Resolver Teléfono Real (evitando guardar LIDs de 15 dígitos en Excel)
        const cleanDigits = userId.replace(/\D/g, '');
        const isLid = userId.includes('@lid') || (!cleanDigits.startsWith('57') && cleanDigits.length > 10) || cleanDigits.length > 12;
        let realPhone = userState.realPhone || null;
        let resolvedName = userState.nombre || null;

        const activeClient = typeof global !== 'undefined' ? global.client : null;

        if (isLid && !realPhone) {
            // A. Buscar en tabla chats
            try {
                const { pool } = require('./database');
                const [chatRows] = await pool.query(
                    'SELECT customer_phone FROM chats WHERE (chat_id = ? OR chat_id LIKE ?) AND customer_phone IS NOT NULL LIMIT 1',
                    [userId, `%${cleanDigits}%`]
                );
                if (chatRows.length > 0 && chatRows[0].customer_phone) {
                    const cp = chatRows[0].customer_phone.replace(/\D/g, '');
                    if (cp && cp.length >= 7 && cp.length <= 12 && cp !== cleanDigits) {
                        realPhone = cp;
                    }
                }
            } catch (e) { }

            // B. Buscar vía Puppeteer / WhatsApp Web Contact
            if (!realPhone && activeClient && activeClient.info) {
                try {
                    const contact = await Promise.race([
                        activeClient.getContactById(userId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1200))
                    ]).catch(() => null);

                    if (contact) {
                        if (!resolvedName || resolvedName === 'Cliente WhatsApp' || resolvedName === 'Cliente') {
                            resolvedName = contact.name || contact.pushname || resolvedName;
                        }
                        if (contact.number) {
                            const cleanCNum = String(contact.number).replace(/\D/g, '');
                            if (cleanCNum.length >= 7 && cleanCNum.length <= 12 && cleanCNum !== cleanDigits) {
                                realPhone = cleanCNum;
                            }
                        }
                        if (!realPhone && typeof contact.getFormattedNumber === 'function') {
                            try {
                                const formatted = await contact.getFormattedNumber();
                                const cleanFNum = String(formatted).replace(/\D/g, '');
                                if (cleanFNum.length >= 7 && cleanFNum.length <= 12 && cleanFNum !== cleanDigits) {
                                    realPhone = cleanFNum;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) { }
            }

            // C. Si tenemos pupPage, buscar en Store.Contact y Store.Lid
            if (!realPhone && activeClient && activeClient.pupPage) {
                try {
                    const storeInfo = await activeClient.pupPage.evaluate((targetId, cleanD) => {
                        if (!window.Store || !window.Store.Contact) return null;
                        const c = window.Store.Contact.get(targetId) || 
                                  (window.Store.Contact._models && window.Store.Contact._models.find(m => (m.id && (m.id.user === cleanD || m.id._serialized === targetId)) || (m.lid && m.lid.user === cleanD)));
                        if (!c) return null;
                        let pn = '';
                        if (c.phoneNumber) pn = typeof c.phoneNumber === 'object' ? (c.phoneNumber.user || c.phoneNumber._serialized) : c.phoneNumber;
                        else if (c.pn) pn = typeof c.pn === 'object' ? (c.pn.user || c.pn._serialized) : c.pn;
                        else if (c.number) pn = c.number;
                        else if (c.formattedNumber) pn = c.formattedNumber;
                        else if (c.userid && !String(c.userid).includes('lid') && String(c.userid).length <= 12) pn = c.userid;
                        
                        if (!pn && window.Store.Lid && typeof window.Store.Lid.getPhoneNumber === 'function') {
                            try {
                                const resL = window.Store.Lid.getPhoneNumber(c.lid || c.id);
                                if (resL) pn = typeof resL === 'object' ? (resL.user || resL._serialized) : resL;
                            } catch(e) {}
                        }
                        return { name: c.name || c.pushname || '', pn: String(pn || '') };
                    }, userId, cleanDigits).catch(() => null);

                    if (storeInfo) {
                        if (storeInfo.name && (!resolvedName || resolvedName === 'Cliente WhatsApp' || resolvedName === 'Cliente')) {
                            resolvedName = storeInfo.name;
                        }
                        if (storeInfo.pn) {
                            const cleanP = storeInfo.pn.replace(/\D/g, '');
                            if (cleanP.length >= 7 && cleanP.length <= 12 && cleanP !== cleanDigits) {
                                realPhone = cleanP;
                            }
                        }
                    }
                } catch (e) { }
            }
        }

        const phoneToUse = realPhone || cleanDigits;
        if (realPhone) {
            userState.realPhone = realPhone;
        }

        // 2. Resolver Nombre Real
        let name = resolvedName || userState.nombre || userState.pushname;
        if (!name || name === "Cliente WhatsApp" || name === "Cliente") {
            try {
                const { searchContactByPhone } = require('./googleContactsService');
                const contactName = await searchContactByPhone(phoneToUse);
                if (contactName) {
                    name = contactName;
                } else {
                    name = userState.pushname || "Cliente WhatsApp";
                }
            } catch (e) {
                name = userState.pushname || "Cliente WhatsApp";
            }
        }

        console.log(`[Sales Registry] Nombre resuelto para el registro: ${name} (Tel: ${phoneToUse})`);
        const phone = phoneToUse;
        const formattedPhone = formatWhatsAppNumber(phone);

        // Obtener todos los datos crudos para buscar cupos o validar nombres reales en filas de Excel
        const allRows = await fetchRawData();

        const expandedItems = [];
        for (const item of items) {
            let pName = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "");
            const cleanStr = pName.replace(/^combo\s*\([^)]*\)\s*:\s*/i, '').replace(/^combo\s*:\s*/i, '');
            if (cleanStr.includes(',') || cleanStr.includes(' + ')) {
                const parts = cleanStr.split(/,|\s\+\s/);
                for (const part of parts) {
                    const trimmed = part.replace(/-\s*suscripci[oó]n/i, '').trim();
                    if (trimmed) {
                        expandedItems.push({ ...item, platform: { name: trimmed }, Streaming: trimmed, name: trimmed, chosenPlan: null, plan: null });
                    }
                }
            } else {
                expandedItems.push(item);
            }
        }

        const results = [];
        for (const item of expandedItems) {
            const planName = (item.chosenPlan ? item.chosenPlan.name : (item.plan ? (item.plan.name || item.plan) : "")) || "";
            let platformName = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "");
            
            // Si el plan es específico (como Platino o Extra), lo concatenamos para la búsqueda en Excel
            if (planName && (planName.toLowerCase().includes('platino') || planName.toLowerCase().includes('platinum') || planName.toLowerCase().includes('extra'))) {
                platformName = `${platformName} ${planName}`;
            }
            const lowerName = platformName.toLowerCase();

            // 1. CASO RENOVACIÓN: Ya tenemos la fila
            let targetRow = null;
            let excelRow = null;
            if (userState.isRenewal && (item._rowNumber || item.index)) {
                const tempRow = item._rowNumber || item.index;
                const tempRowData = allRows[tempRow - 2];
                if (tempRowData) {
                    const rowPhone = (tempRowData.numero || tempRowData.Numero || "").toString().replace(/\D/g, '');
                    const whatsappVal = (tempRowData.whatsapp || "").toString().trim();
                    const whatsappDigits = whatsappVal.replace(/\D/g, '');
                    let isPhoneMatch = rowPhone && rowPhone.includes(phone.slice(-10));
                    if (!isPhoneMatch && whatsappDigits) {
                        isPhoneMatch = whatsappDigits.includes(phone.slice(-10));
                    }
                    
                    if (isPhoneMatch) {
                        targetRow = tempRow;
                        excelRow = tempRowData;
                    } else {
                        console.log(`[Sales Registry] Advertencia: Desfase de fila detectado para ${platformName}. Fila sugerida ${tempRow} no coincide con el teléfono ${phone}. Buscando inteligentemente...`);
                    }
                }
            }

            if (targetRow && excelRow) {
                const baseDate = item.deben || null;
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, months, baseDate);
                const realStreamingName = excelRow.Streaming || excelRow.Plataforma || platformName;

                console.log(`[Sales Registry] RENOVACIÓN detectada para ${realStreamingName} en fila ${targetRow}. Nueva fecha: ${nextPaymentDate}`);
                const updates = {
                    "deben": nextPaymentDate,
                    "observaciones": `Renovación Dashboard - ${new Date().toLocaleDateString()}`
                };
                await updateExcelData(targetRow, updates);
                results.push({ 
                    name: realStreamingName, 
                    status: 'success', 
                    rowNumber: targetRow, 
                    type: 'renewal',
                    correo: excelRow.correo || excelRow.Correo || "",
                    contraseña: excelRow.contraseña || excelRow.Contraseña || excelRow.password || "",
                    pin: excelRow["pin perfil"] || excelRow.pin || "",
                    vencimiento: nextPaymentDate,
                    "customer mail": excelRow["customer mail"] || excelRow["Customer Mail"] || "",
                    customerMail: excelRow["customer mail"] || excelRow["Customer Mail"] || ""
                });
                continue;
            }

            // 2. CASO INTELIGENTE: BUSCAR si el usuario YA TIENE esta plataforma en el Excel
            let finalRow = null;
            let matchedRow = null;
            let isAutoRenewal = false;

            const lastMsgText = userState.lastMessage || "";
            const isExplicitNewAccount = (userState.isNewSale || userState.forceNewSale || /nueva|otra|adicional|segunda|comprar otra/i.test(lastMsgText));

            if (!isExplicitNewAccount) {
                const existingAccount = allRows.find(r => {
                    const rowPhone = (r.numero || r.Numero || "").toString().replace(/\D/g, '');
                    const whatsappVal = (r.whatsapp || "").toString().trim();
                    const whatsappDigits = whatsappVal.replace(/\D/g, '');
                    
                    // Match by phone number
                    let isPhoneMatch = false;
                    if (rowPhone && rowPhone.includes(phone.slice(-10))) {
                        isPhoneMatch = true;
                    } else if (whatsappDigits && whatsappDigits.includes(phone.slice(-10))) {
                        isPhoneMatch = true;
                    }

                    // Match by name
                    let isNameMatch = false;
                    const cleanWhatsapp = whatsappVal.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
                    const cleanName = (userState.nombre || "").toLowerCase().replace(/[^a-z0-9]/g, '').trim();
                    const cleanPush = (userState.pushname || "").toLowerCase().replace(/[^a-z0-9]/g, '').trim();

                    if (!isPhoneMatch && cleanWhatsapp && !whatsappDigits) {
                        // Solo si no coincidió por teléfono y hay un nombre válido en la celda
                        if (cleanName === cleanWhatsapp || cleanPush === cleanWhatsapp) {
                            isNameMatch = true;
                        } else if (cleanName && getLevenshteinDistance(cleanName, cleanWhatsapp) <= 2) {
                            isNameMatch = true;
                        } else if (cleanPush && getLevenshteinDistance(cleanPush, cleanWhatsapp) <= 2) {
                            isNameMatch = true;
                        }
                    }

                    if ((isPhoneMatch || isNameMatch) && isSamePlatformFamily(r.Streaming, platformName)) {
                        // Si el usuario ya tiene esta plataforma y no pidió explícitamente cuenta nueva, renovamos su fila existente
                        return true;
                    }
                    return false;
                });

                if (existingAccount) {
                    finalRow = existingAccount._rowNumber || allRows.indexOf(existingAccount) + 2;
                    matchedRow = existingAccount;
                    isAutoRenewal = true;
                    console.log(`[Sales Registry] Auto-detección: El cliente ya tiene ${platformName} (vencida/por vencer). Procesando como RENOVACIÓN en fila ${finalRow}`);
                }
            }

            if (finalRow) {
                const baseDate = matchedRow ? (matchedRow.deben || matchedRow.Deben) : null;
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, months, baseDate);

                const updates = {
                    "deben": nextPaymentDate,
                    "observaciones": `Renovación Auto - ${new Date().toLocaleDateString()}`
                };
                await updateExcelData(finalRow, updates);
                results.push({ 
                    name: matchedRow.Streaming || platformName, 
                    status: 'success', 
                    rowNumber: finalRow, 
                    type: 'renewal',
                    correo: matchedRow.correo || matchedRow.Correo || "",
                    contraseña: matchedRow.contraseña || matchedRow.Contraseña || matchedRow.password || "",
                    pin: matchedRow["pin perfil"] || matchedRow.pin || "",
                    vencimiento: nextPaymentDate,
                    "customer mail": matchedRow["customer mail"] || matchedRow["Customer Mail"] || "",
                    customerMail: matchedRow["customer mail"] || matchedRow["Customer Mail"] || ""
                });
                continue;
            }

            // 3. CASO VENTA NUEVA: Buscar cupo
            // Verificar disponibilidad manual o por stock
            const { getPlatformAvailability } = require('./availabilityService');
            const availability = await getPlatformAvailability(platformName);
            if (!availability.immediate) {
                console.log(`[Sales Registry] ${platformName} no tiene entrega inmediata (${availability.reason}). Saltando registro automático.`);
                results.push({ name: platformName, status: 'manual_invitation_required' });
                continue;
            }

            // Verificamos si es un PLAN FAMILIAR (Saltar si es venta nueva, pero NO si es renovación)
            const isFamilyPlan = FAMILY_KEYWORDS.some(key => lowerName.includes(key));

            if (isFamilyPlan) {
                console.log(`[Sales Registry] ${platformName} es un plan FAMILIAR. Saltando registro automático.`);
                results.push({ name: platformName, status: 'manual_invitation_required' });
                continue;
            }

            const slot = findAvailableSlot(platformName, allRows);

            if (slot) {
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, months);
                console.log(`[Sales Registry] Cupo encontrado para ${platformName} en fila ${slot.index}`);

                // Lógica de separación de nombres
                const nameParts = name.trim().split(/\s+/);
                const firstName = nameParts[0] || "";
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";

                const numericPhone = parseInt(formattedPhone.replace(/\D/g, '')) || 0;

                const updates = {
                    "whatsapp": name,
                    "numero": formattedPhone,
                    "Nombre": firstName,
                    "apellido": lastName,
                    "deben": nextPaymentDate,
                    "observaciones": `Venta Auto (${nextPaymentDate}) - ${new Date().toLocaleDateString()}`
                };

                console.log(`[Sales Registry] Enviando actualización a Azure:`, JSON.stringify(updates, null, 2));

                // Si es Netflix o Disney y tenemos operador en el estado, lo llenamos
                if (lowerName.includes('netflix') || lowerName.includes('disney')) {
                    if (userState.netflixIsp) {
                        updates["operador"] = userState.netflixIsp;
                    }
                }

                // Customer mail (si lo tenemos en el estado)
                if (userState.correo) {
                    updates["customer mail"] = userState.correo;
                }

                await updateExcelData(slot.index, updates);
                // Marcar el row en nuestro array local como usado para evitar colisiones
                if (allRows[slot.index - 2]) {
                    allRows[slot.index - 2].whatsapp = phone;
                    allRows[slot.index - 2].deben = "RESERVADO";
                }
                results.push({ 
                    name: slot.rowData.Streaming || platformName, 
                    status: 'success', 
                    rowNumber: slot.index, 
                    type: 'new_sale',
                    correo: slot.rowData.correo || slot.rowData.Correo || "",
                    contraseña: slot.rowData.contraseña || slot.rowData.Contraseña || slot.rowData.password || "",
                    pin: slot.rowData["pin perfil"] || slot.rowData.pin || "",
                    vencimiento: nextPaymentDate,
                    "customer mail": slot.rowData["customer mail"] || slot.rowData["Customer Mail"] || "",
                    customerMail: slot.rowData["customer mail"] || slot.rowData["Customer Mail"] || ""
                });

                // Registrar ingreso automático en Flujo de Caja Real si es pago por transferencia / Nequi / Bre-B / Admin
                if (paymentMethod !== 'Bold Pagos' && !String(paymentMethod).toLowerCase().includes('bold')) {
                    try {
                        const { addCashFlowEntry } = require('./accountingService');
                        const platName = slot.rowData.Streaming || platformName;
                        const itemPrice = parseFloat(slot.rowData.precio || (item.platform ? item.platform.price : 0) || userState.total || 0);
                        if (itemPrice > 0) {
                            await addCashFlowEntry('income', platName, itemPrice, `Venta confirmada (${paymentMethod}): ${name}`, new Date(), true);
                            console.log(`[Sales Registry] 💵 Ingreso de $${itemPrice} registrado en cash_flow_entries para ${platName}`);
                        }
                    } catch (cashErr) {
                        console.warn("[Sales Registry] Error registrando flujo de caja:", cashErr.message);
                    }
                }
            } else {
                console.log(`[Sales Registry] NO se encontró cupo disponible para ${platformName}.`);
                results.push({ name: platformName, status: 'no_slots_found' });
            }
        }
        return results;

    } catch (error) {
        console.error("[Sales Registry] Error en proceso inteligente:", error.message);
    }
}

module.exports = {
    recordNewSale,
    isSamePlatformFamily
};
