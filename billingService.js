const { getAccountsByPhone, fetchCustomersData, getJsDateFromExcel, getTodayInBogota } = require('./apiService');
const { generateCredentialsResponse } = require('./aiService');
const { getPlatformKnowledge } = require('./apiService');
const path = require('path');
const fs = require('fs');

function extractPlatformFromText(text) {
    if (!text) return null;
    const txt = text.toLowerCase().trim();
    if (txt === "2") return null; // Ignorar si es solo la opción del menú
    if (txt.includes('netflix')) return 'NETFLIX';
    if (txt.includes('spotify')) return 'SPOTIFY';
    if (txt.includes('disney')) return 'DISNEY';
    if (txt.includes('prime') || txt.includes('amazon')) return 'AMAZON PRIME';
    if (txt.includes('hbo') || txt.includes('max')) return 'MAX';
    if (txt.includes('paramount')) return 'PARAMOUNT';
    if (txt.includes('youtube')) return 'YOUTUBE';
    if (txt.includes('plex')) return 'PLEX';
    if (txt.includes('crunchyroll') || txt.includes('crunchy')) return 'CRUNCHYROLL';
    if (txt.includes('apple') || txt.includes('one')) return 'APPLE ONE';
    return null;
}

/**
 * Procesa la solicitud de credenciales de un usuario.
 */
async function processCheckCredentials(userId, client, triggerMessage = "", history = "", userStates = null) {
    try {
        let phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
        let contactName = null;
        if (userId.includes('@lid')) {
            try {
                const contact = await client.getContactById(userId);
                if (contact && contact.number) {
                    phoneNumber = contact.number;
                    contactName = contact.name || contact.pushname;
                }
            } catch (e) {
                console.warn("[processCheckCredentials] No se pudo obtener contacto para LID:", e.message);
            }
        }

        // Validar si tiene un pago en proceso de validación humana
        let isPendingValidation = false;
        if (userStates) {
            const stateData = userStates.get(userId);
            if (stateData && (stateData.state === 'waiting_admin_confirmation' || stateData.state === 'awaiting_payment_confirmation')) {
                isPendingValidation = true;
            }
        }

        if (!isPendingValidation) {
            try {
                const { pool } = require('./database');
                const [pendingSales] = await pool.query(
                    "SELECT * FROM web_sales_pending WHERE whatsapp LIKE ? OR whatsapp = ?",
                    [`%${phoneNumber}%`, phoneNumber]
                );
                if (pendingSales && pendingSales.length > 0) {
                    isPendingValidation = true;
                }
            } catch (dbErr) {
                console.error('[Billing Service] Error buscando ventas pendientes:', dbErr.message);
            }
        }

        if (isPendingValidation) {
            await client.sendMessage(userId, "🤖 Un humano aún no ha validado tu pago, estamos en proceso de validación. Para la próxima vez, te recomendamos usar la Llave de Pago para una activación inmediata sin esperar verificación humana.");
            return;
        }

        let userAccounts = await getAccountsByPhone(phoneNumber, contactName);

        if (userAccounts.length === 0) {
            await client.sendMessage(userId, "🤖 No encontré servicios activos vinculados a este número. Si compraste desde otro número, por favor dímelo para ayudarte a buscar o contacta a un asesor.");
            return;
        }

        // --- VALIDACIÓN DE PLATAFORMA ESPECÍFICA ---
        const requestedPlatform = extractPlatformFromText(triggerMessage);
        if (requestedPlatform) {
            const hasPlatform = userAccounts.some(acc => {
                const streaming = (acc.Streaming || acc.streaming || "").toUpperCase();
                return streaming.includes(requestedPlatform) || requestedPlatform.includes(streaming);
            });

            if (!hasPlatform) {
                await client.sendMessage(userId, `🤖 Veo que actualmente no tienes una suscripción activa de *${requestedPlatform}* con nosotros.\n\n¿Te gustaría adquirir un plan? Escribe *1* para ver nuestro catálogo y comprar. 🛒\n\nSi crees que esto es un error, no te preocupes, en un momento un asesor humano revisará este chat para ayudarte. 🧑‍💻`);
                // Activar modo humano para que el asesor pueda revisar el error si el cliente responde
                if (userStates) {
                    const existing = userStates.get(userId);
                    userStates.set(userId, {
                        ...(existing || {}),
                        state: 'waiting_human',
                        waiting_human_mode: 'advisor',
                        advisorReason: `Solicitó credenciales de ${requestedPlatform} pero no la tiene adquirida`,
                        waitingTimestamp: Date.now()
                    });
                }
                const { applyLabelToChat } = require('./adminService');
                try {
                    await applyLabelToChat(userId, client, ['revisión', 'manual']);
                } catch (e) {}
                return;
            } else {
                // Filtrar las cuentas de usuario para enviar únicamente las de la plataforma solicitada
                userAccounts = userAccounts.filter(acc => {
                    const streaming = (acc.Streaming || acc.streaming || "").toUpperCase();
                    return streaming.includes(requestedPlatform) || requestedPlatform.includes(streaming);
                });
            }
        }

        // Detectar si alguna de las cuentas no tiene credenciales asignadas aún
        const pendingAccounts = userAccounts.filter(acc => {
            const correoOriginal = (acc.correo || acc.Correo || acc["E-mail"] || "").toString().trim().toLowerCase();
            const claveOriginal = (acc["contraseña"] || acc["Clave"] || acc["clave"] || acc["password"] || acc["Password"] || "").toString().trim().toLowerCase();
            
            return !correoOriginal || !claveOriginal || 
                   correoOriginal === "n/a" || claveOriginal === "n/a" ||
                   correoOriginal.includes("pendiente") || claveOriginal.includes("pendiente") ||
                   correoOriginal.includes("por asignar") || claveOriginal.includes("por asignar") ||
                   correoOriginal.includes("por_asignar") || claveOriginal.includes("por_asignar");
        });

        const assignedAccounts = userAccounts.filter(acc => !pendingAccounts.includes(acc));

        let waitingTimeText = "";
        const existingState = userStates ? userStates.get(userId) : null;
        if (existingState && existingState.waitingTimestamp) {
            const diffMs = Date.now() - existingState.waitingTimestamp;
            const diffMins = Math.floor(diffMs / (1000 * 60));
            if (diffMins < 60) {
                waitingTimeText = ` por más de ${diffMins} minutos`;
            } else {
                const diffHours = Math.floor(diffMins / 60);
                const remainingMins = diffMins % 60;
                waitingTimeText = ` por más de ${diffHours} horas y ${remainingMins} minutos`;
            }
        }

        if (assignedAccounts.length === 0) {
            // Todas las cuentas están pendientes de asignar
            const platformsStr = userAccounts.map(a => (a.Streaming || "Servicio").toUpperCase()).join(", ");
            await client.sendMessage(userId, `🤖 Veo que tus credenciales de *${platformsStr}* aún no se han asignado. Ya le recordé a un asesor humano que has estado esperando${waitingTimeText} para que te las entregue lo antes posible. ¡Gracias por tu paciencia! 😊`);
            return;
        }

        let aiResponse = await generateCredentialsResponse(assignedAccounts, triggerMessage, history);
        if (aiResponse && !aiResponse.includes('🤖')) {
            aiResponse += '\n\n🤖';
        }

        // Si además tiene cuentas pendientes, le agregamos una aclaración al final de la respuesta
        if (pendingAccounts.length > 0) {
            const pendingPlatformsStr = pendingAccounts.map(a => (a.Streaming || "Servicio").toUpperCase()).join(", ");
            aiResponse += `\n\n⚠️ *Nota:* Tus credenciales de *${pendingPlatformsStr}* aún no se han asignado. Ya le recordé a un asesor que has estado esperando${waitingTimeText} para que te las entregue.`;
        }

        await client.sendMessage(userId, aiResponse);

    } catch (error) {
        console.error('[Billing Service] Error al procesar credenciales:', error);
        await client.sendMessage(userId, "🤖 Hubo un error al recuperar tus credenciales. Por favor, inténtalo de nuevo en un momento o contacta a un asesor.");
    }
}

/**
 * Intenta ajustar la duración y el total de la renovación en stateData si el monto pagado coincide con múltiples meses.
 */
async function adjustDurationToMatchAmount(stateData, paidAmount, userId) {
    if (!stateData || !stateData.isRenewal || !paidAmount) return;
    try {
        const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
        const userAccounts = await getAccountsByPhone(phoneNumber);
        if (userAccounts.length === 0) return;

        const platforms = await getPlatformKnowledge();
        const today = getTodayInBogota();

        // Probar duraciones de 1 a 12 meses
        for (let m = 1; m <= 12; m++) {
            let total = 0;
            let hasZeroPrice = false;

            userAccounts.forEach(acc => {
                const streaming = (acc.Streaming || "").toUpperCase();
                let price = 0;
                let mappedStreaming = streaming;
                const aliasMap = {
                    'AMAZON': 'PRIME VIDEO', 'PRIME': 'PRIME VIDEO', 'APPLE TV': 'APPLE TV+',
                    'HBO': 'HBOMAX', 'MAX': 'HBOMAX', 'DISNEY': 'DISNEY+ PREMIUM',
                    'STAR': 'DISNEY+ PREMIUM', 'YOUTUBE': 'YOUTUBE PREMIUM', 'MICROSOFT': 'MICROSOFT 365'
                };
                for (const [alias, real] of Object.entries(aliasMap)) {
                    if (mappedStreaming.includes(alias)) {
                        mappedStreaming = mappedStreaming.replace(alias, real);
                        break;
                    }
                }
                const cleanExcel = mappedStreaming.replace(/[^A-Z0-9]/g, '');
                const platInfo = platforms.find(p => {
                    const cleanPlat = p.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                    return cleanExcel.includes(cleanPlat) || cleanPlat.includes(cleanExcel);
                });
                if (platInfo) {
                    price = platInfo.price || 0;
                    if (platInfo.name.toUpperCase() === 'SPOTIFY' && !cleanExcel.includes('PROPORCIONADO') && !cleanExcel.includes('OWNER')) {
                        const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL'));
                        if (personalPlan) price = personalPlan.price;
                    } else if (platInfo.plans && platInfo.plans.length > 0) {
                        const specificPlan = platInfo.plans.find(plan => {
                            const cleanPlan = plan.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            return cleanExcel.includes(cleanPlan) || cleanPlan.includes(cleanExcel);
                        });
                        if (specificPlan) price = specificPlan.price;
                    }
                }
                if (price === 0) hasZeroPrice = true;
                total += price * m;
            });

            if (hasZeroPrice) continue;

            // Descuento combo
            const imminentRenewals = userAccounts.filter(acc => {
                const expDate = getJsDateFromExcel(acc.deben || acc.vencimiento);
                if (!expDate) return false;
                const diffDays = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
                return diffDays <= 1;
            });
            if (total > 0 && imminentRenewals.length > 1) {
                const discount = (imminentRenewals.length - 1) * 1000 * m;
                total -= discount;
            }

            if (Math.abs(total - paidAmount) < 500) {
                console.log(`[Duration Adjuster] ✅ Monto pagado $${paidAmount} detectado para ${m} meses de renovación.`);
                stateData.durationMonths = m;
                stateData.total = total;
                return;
            }
        }
    } catch (e) {
        console.error('[Duration Adjuster] Error:', e.message);
    }
}

/**
 * Procesa la solicitud de precios/deudas de un usuario (Opción 3 del menú).
 */
async function processCheckPrices(message, userId, userStates, inputToUse = "", detectedPlatform = null, durationMonths = 1) {
    try {
        let phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
        let contactName = null;
        try {
            if (message && typeof message.getContact === 'function') {
                const contact = await message.getContact();
                if (contact && contact.number) {
                    phoneNumber = contact.number;
                    contactName = contact.name || contact.pushname;
                }
            }
        } catch (contactErr) {
            console.warn("[processCheckPrices] No se pudo obtener contacto del mensaje:", contactErr.message);
        }

        const userAccounts = await getAccountsByPhone(phoneNumber, contactName);

        if (userAccounts.length === 0) {
            await message.reply("🤖 No encontré servicios activos vinculados a este número para renovar. Si deseas comprar algo nuevo, escribe *1*.");
            return;
        }

        const platforms = await getPlatformKnowledge();
        const today = getTodayInBogota();
        
        let response = `💰 *TU RESUMEN DE PAGO${durationMonths > 1 ? ` (${durationMonths} MESES)` : ''}*\n\n`;
        let total = 0;
        let itemsForRenewal = [];

        let hasZeroPrice = false;
        
        let accountsToProcess = userAccounts;
        if (detectedPlatform) {
            const search = detectedPlatform.toLowerCase().replace(/[^a-z0-9]/g, '');
            const filtered = userAccounts.filter(acc => {
                const current = (acc.Streaming || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                return current.includes(search) || search.includes(current);
            });
            if (filtered.length > 0) {
                accountsToProcess = filtered;
            }
        } else {
            // Si no hay plataforma específica, filtramos para renovar solo servicios vencidos o por vencer pronto (próximos 5 días)
            const expiredOrExpiring = userAccounts.filter(acc => {
                const vencimientoRaw = acc.deben || acc.vencimiento;
                const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
                if (!vencimientoDate) return false;
                
                const isExpired = vencimientoDate < today;
                const diffTime = vencimientoDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
                
                return isExpired || diffDays <= 5;
            });
            
            if (expiredOrExpiring.length > 0) {
                accountsToProcess = expiredOrExpiring;
            }
        }

        accountsToProcess.forEach(acc => {
            const streaming = (acc.Streaming || "").toUpperCase();
            const vencimientoRaw = acc.deben || acc.vencimiento;
            const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
            
            // Buscar precio estrictamente en el catálogo de la página (platforms.json)
            // Lógica de matching agresiva (quitando caracteres especiales)
            let price = 0;
            
            let mappedStreaming = streaming.toUpperCase();
            const aliasMap = {
                'AMAZON': 'PRIME VIDEO',
                'PRIME': 'PRIME VIDEO',
                'APPLE TV': 'APPLE TV+',
                'HBO': 'HBOMAX',
                'MAX': 'HBOMAX',
                'DISNEY': 'DISNEY+ PREMIUM',
                'STAR': 'DISNEY+ PREMIUM',
                'YOUTUBE': 'YOUTUBE PREMIUM',
                'MICROSOFT': 'MICROSOFT 365'
            };
            for (const [alias, real] of Object.entries(aliasMap)) {
                if (mappedStreaming.includes(alias)) {
                    mappedStreaming = mappedStreaming.replace(alias, real);
                    break;
                }
            }
            
            const cleanExcel = mappedStreaming.replace(/[^A-Z0-9]/g, '');
            
            const platInfo = platforms.find(p => {
                const cleanPlat = p.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                return cleanExcel.includes(cleanPlat) || cleanPlat.includes(cleanExcel);
            });

            if (platInfo) {
                price = platInfo.price || 0; 
                
                // Regla especial para Spotify:
                // Si la plataforma es Spotify y el Excel NO contiene palabras de "proporcionado" u "owner",
                // por defecto asumimos que es el plan "Personal (Tu Correo)" de 10,000.
                if (platInfo.name.toUpperCase() === 'SPOTIFY' && !cleanExcel.includes('PROPORCIONADO') && !cleanExcel.includes('OWNER')) {
                    const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL'));
                    if (personalPlan) {
                        price = personalPlan.price;
                    }
                } else if (platInfo.name.toUpperCase().includes('GEMINI') && !cleanExcel.includes('COMPARTIDA')) {
                    const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('CORREO') || p.name.toUpperCase().includes('PROPIO'));
                    if (personalPlan) {
                        price = personalPlan.price;
                    }
                } else if (platInfo.name.toUpperCase().includes('MICROSOFT') && !cleanExcel.includes('COMPARTIDA')) {
                    const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL') || p.name.toUpperCase().includes('INDIVIDUAL'));
                    if (personalPlan) {
                        price = personalPlan.price;
                    }
                } else if (platInfo.plans && platInfo.plans.length > 0) {
                    const specificPlan = platInfo.plans.find(plan => {
                        const cleanPlan = plan.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                        
                        const keywords = ['PERSONAL', 'EXTRA', 'COMPARTIDA', 'ESTANDAR', 'PLATINO', 'MENSUAL', 'ANUAL', 'PLUS', 'PRO', 'CORREOPROPIO', 'NUEVA', 'RENOVACION', 'PROPORCIONADO', 'OWNER', 'INDIVIDUAL', 'PROPIO', 'CORREO'];
                        const synonyms = {
                            'INDIVIDUAL': ['PERSONAL', 'CORREOPROPIO', 'PROPIO', 'CORREO'],
                            'PERSONAL': ['INDIVIDUAL', 'CORREOPROPIO', 'PROPIO', 'CORREO'],
                            'PROPIO': ['PERSONAL', 'INDIVIDUAL', 'CORREOPROPIO', 'CORREO'],
                            'CORREOPROPIO': ['PERSONAL', 'INDIVIDUAL', 'PROPIO', 'CORREO'],
                            'CORREO': ['PERSONAL', 'INDIVIDUAL', 'PROPIO', 'CORREOPROPIO']
                        };

                        for (const kw of keywords) {
                            if (cleanExcel.includes(kw)) {
                                if (cleanPlan.includes(kw)) return true;
                                if (synonyms[kw] && synonyms[kw].some(syn => cleanPlan.includes(syn))) {
                                    return true;
                                }
                            }
                        }
                        
                        return cleanExcel.includes(cleanPlan) || cleanPlan.includes(cleanExcel);
                    });
                    
                    if (specificPlan) {
                        price = specificPlan.price;
                    } else if (price === 0) {
                        price = platInfo.plans[0].price;
                    }
                }
            }

            if (price === 0) hasZeroPrice = true;
            
            const isExpired = vencimientoDate && vencimientoDate < today;
            const isToday = vencimientoDate && vencimientoDate.getTime() === today.getTime();
            
            let status = "✅ Vigente";
            if (isExpired) status = "⚠️ VENCIDO";
            else if (isToday) status = "⚠️ VENCE HOY";

            const dateStr = vencimientoDate ? vencimientoDate.toLocaleDateString('es-CO') : 'N/A';

            const customerMail = (acc["customer mail"] || acc["Customer Mail"] || "").toString().trim();
            let emailToShow = customerMail;
            if (!emailToShow) {
                const adminMail = (acc.correo || 'Sin correo').toString().trim();
                emailToShow = acc.correo ? `${adminMail} *(Administrador)*` : adminMail;
            }
            response += `📺 *${streaming}*\n`;
            response += `📧 ${emailToShow}\n`;
            response += `📅 Vence: ${dateStr} (${status})\n`;
            if (durationMonths > 1) {
                const multiPrice = price * durationMonths;
                response += `💵 Valor: $${price}/mes x ${durationMonths} meses = *$${multiPrice}*\n\n`;
                total += multiPrice;
                itemsForRenewal.push({ ...acc, price: multiPrice, platform: { name: (acc.Streaming || 'Servicio') } });
            } else {
                response += `💵 Valor: $${price}\n\n`;
                total += price;
                itemsForRenewal.push({ ...acc, price, platform: { name: (acc.Streaming || 'Servicio') } });
            }
        });

        // FALLBACK: Si algún precio es cero o el total es cero, no enviar resumen automático
        if (hasZeroPrice || total === 0) {
            console.log(`[Billing Service] Fallback activado: Precio cero detectado para el usuario ${userId}`);
            await message.reply("🤖 No pude calcular automáticamente el valor total de tu renovación debido a una discrepancia en los nombres de los servicios registrados. \n\nPor favor, espera un momento a que un asesor humano revise tu caso y te envíe el valor correcto manualmente. ¡Gracias por tu paciencia! 😊");
            return;
        }

        // Lógica de descuento por combo: solo aplica si las plataformas a renovar tienen la misma fecha de vencimiento (fecha idéntica)
        const vencimientoStrings = itemsForRenewal.map(item => {
            const rawDate = item.deben || item.vencimiento;
            if (!rawDate) return null;
            const jsDate = getJsDateFromExcel(rawDate);
            if (!jsDate || isNaN(jsDate.getTime())) return null;
            return jsDate.toISOString().split('T')[0];
        }).filter(Boolean);

        const uniqueDates = [...new Set(vencimientoStrings)];
        const allDatesIdentical = uniqueDates.length === 1 && vencimientoStrings.length === itemsForRenewal.length;

        if (total > 0 && itemsForRenewal.length > 1 && allDatesIdentical) {
            const discount = (itemsForRenewal.length - 1) * 1000 * durationMonths;
            total -= discount;
            response += `✨ *Descuento por combo:* -$${discount.toLocaleString('es-CO')}\n`;
        }

        // Detección automática de Churn (si renueva una plataforma pero deja vencer otras)
        const churnPlatforms = [];
        let churnText = "";
        if (detectedPlatform) {
            const notRenewed = userAccounts.filter(acc => !accountsToProcess.includes(acc));
            const expiredOrExpiringSoon = notRenewed.filter(acc => {
                const venc = acc.deben || acc.vencimiento;
                const vencDate = getJsDateFromExcel(venc);
                if (!vencDate) return false;
                const isExpired = vencDate < today;
                const diffTime = vencDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
                return isExpired || diffDays <= 3;
            });
            
            if (expiredOrExpiringSoon.length > 0) {
                const { updateExcelData } = require('./apiService');
                const dateStr = new Date().toLocaleDateString('es-CO');
                for (const acc of expiredOrExpiringSoon) {
                    const rowNum = acc._rowNumber || acc.index;
                    if (rowNum) {
                        churnPlatforms.push(rowNum);
                        await updateExcelData(rowNum, { "observaciones": `cortar (bot ${dateStr})` }).catch(e => {});
                    }
                }
                const platformNames = expiredOrExpiringSoon.map(acc => (acc.Streaming || "Servicio").toUpperCase()).join(', ');
                churnText = `\n\n😔 *Nota:* Veo que decidiste no continuar con tu servicio de *${platformNames}*. Nos encantaría seguir mejorando: ¿podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho.`;
            }
        }

        response += `*TOTAL A PAGAR: $${total}*\n\n`;
        response += "🤖 ¿Por cuál medio deseas realizar la transferencia?\n\n⭐ *QR Negocios (RECOMENDADO - ENTREGA INMEDIATA ⚡)*\n⭐ *Llave Bre-V (AUTOMÁTICA ⚡)*:\n   • Celular: *0087387259*\n⭐ *Bancolombia (Abono Directo - VALIDACIÓN AUTOMÁTICA ⚡)*:\n   • Ahorros: *46772753713* (CC: 1032936324)\n\n💡 *Tip de Renovación:* Si pagas por un medio automático (QR, Llave Bre-V o Bancolombia), tu servicio se renovará al instante. **¡Así no se te volverá a repetir este recordatorio de cobro ya que tu fecha de vencimiento se actualiza de inmediato!** ⚡🤖";
        
        if (churnText) {
            response += churnText;
        }

        await message.reply(response);
        
        // Actualizar estado para esperar comprobante
        userStates.set(userId, { 
            state: 'awaiting_payment_method', 
            total: total, 
            items: itemsForRenewal, 
            isRenewal: true,
            durationMonths: durationMonths,
            churnPlatforms: churnPlatforms.length > 0 ? churnPlatforms : null
        });

    } catch (error) {
        console.error('[Billing Service] Error en processCheckPrices:', error);
        await message.reply("🤖 Tuve un problema al calcular tus precios. Por favor espera a que un asesor revise tu caso.");
    }
}

/**
 * Maneja el proceso automático de cobros (Aviso de Cobro).
 */
/**
 * Función auxiliar para enviar mensajes de cobro de forma masiva con delay anti-spam.
 */
async function sendBulkCharges(client, records, requesterId = null, userStates = null) {
  const file = path.join(__dirname, 'pending_charges.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
  const entry = { requester: requesterId || 'SYSTEM_AUTO', records, timestamp: new Date().toISOString() };
  existing.push(entry);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));

  // Load platform pricing definitions once to save DB/filesystem operations in the loop
  let platforms = [];
  try {
    platforms = await getPlatformKnowledge();
  } catch (err) {
    console.error("[Billing Auto] Error loading platform pricing for billing reminders:", err.message);
  }

  let exitosos = 0;
  for (const r of records) {
    const dest = r.phone + '@c.us';
    
    let vencimientoTxt = "tu suscripción está próxima a renovarse o ya venció";
    if (r.date || r.dateStr) {
        const d = r.date || r.dateStr;
        if (d === "MAÑANA") {
           vencimientoTxt = "el día de mañana se vence tu cuenta";
        } else {
           vencimientoTxt = `el día ${d} se venció tu cuenta`;
        }
    }
    
    const serviceName = r.textToShow || r.services?.join(', ') || r.service || 'tus servicios';
    let servicesToPrint = serviceName;
    
    // Dynamic total calculator for the initial reminder
    let totalText = "";
    try {
      const userAccounts = await getAccountsByPhone(r.phone);
      if (userAccounts && userAccounts.length > 0) {
        let totalSum = 0;
        const billedServicesList = [];
        
        // Match only services that are expiring or expired
        const today = getTodayInBogota();
        const expiredOrExpiring = userAccounts.filter(acc => {
            const vencimientoRaw = acc.deben || acc.vencimiento;
            const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
            if (!vencimientoDate) return false;
            
            const isExpired = vencimientoDate < today;
            const diffTime = vencimientoDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
            
            return isExpired || diffDays <= 5;
        });

        const targetAccounts = expiredOrExpiring.length > 0 ? expiredOrExpiring : userAccounts;

        targetAccounts.forEach(acc => {
          const streaming = (acc.Streaming || "").toUpperCase();
          if (streaming) billedServicesList.push(streaming);
          let price = 0;
          let mappedStreaming = streaming.toUpperCase();
          
          const aliasMap = {
              'AMAZON': 'PRIME VIDEO',
              'PRIME': 'PRIME VIDEO',
              'APPLE TV': 'APPLE TV+',
              'HBO': 'HBOMAX',
              'MAX': 'HBOMAX',
              'DISNEY': 'DISNEY+ PREMIUM',
              'STAR': 'DISNEY+ PREMIUM',
              'YOUTUBE': 'YOUTUBE PREMIUM',
              'MICROSOFT': 'MICROSOFT 365'
          };
          for (const [alias, real] of Object.entries(aliasMap)) {
              if (mappedStreaming.includes(alias)) {
                  mappedStreaming = mappedStreaming.replace(alias, real);
                  break;
              }
          }
          const cleanExcel = mappedStreaming.replace(/[^A-Z0-9]/g, '');
          const platInfo = platforms.find(p => {
              const cleanPlat = p.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
              return cleanExcel.includes(cleanPlat) || cleanPlat.includes(cleanExcel);
          });

          if (platInfo) {
              price = platInfo.price || 0;
              if (platInfo.name.toUpperCase() === 'SPOTIFY' && !cleanExcel.includes('PROPORCIONADO') && !cleanExcel.includes('OWNER')) {
                  const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL'));
                  if (personalPlan) price = personalPlan.price;
              } else if (platInfo.name.toUpperCase().includes('GEMINI') && !cleanExcel.includes('COMPARTIDA')) {
                  const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('CORREO') || p.name.toUpperCase().includes('PROPIO'));
                  if (personalPlan) price = personalPlan.price;
              } else if (platInfo.name.toUpperCase().includes('MICROSOFT') && !cleanExcel.includes('COMPARTIDA')) {
                  const personalPlan = platInfo.plans.find(p => p.name.toUpperCase().includes('PERSONAL') || p.name.toUpperCase().includes('INDIVIDUAL'));
                  if (personalPlan) price = personalPlan.price;
              } else if (platInfo.plans && platInfo.plans.length > 0) {
                  const specificPlan = platInfo.plans.find(plan => {
                      const cleanPlan = plan.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
                      
                      const keywords = ['PERSONAL', 'EXTRA', 'COMPARTIDA', 'ESTANDAR', 'PLATINO', 'MENSUAL', 'ANUAL', 'PLUS', 'PRO', 'CORREOPROPIO', 'NUEVA', 'RENOVACION', 'PROPORCIONADO', 'OWNER', 'INDIVIDUAL', 'PROPIO', 'CORREO'];
                      const synonyms = {
                          'INDIVIDUAL': ['PERSONAL', 'CORREOPROPIO', 'PROPIO', 'CORREO'],
                          'PERSONAL': ['INDIVIDUAL', 'CORREOPROPIO', 'PROPIO', 'CORREO'],
                          'PROPIO': ['PERSONAL', 'INDIVIDUAL', 'CORREOPROPIO', 'CORREO'],
                          'CORREOPROPIO': ['PERSONAL', 'INDIVIDUAL', 'PROPIO', 'CORREO'],
                          'CORREO': ['PERSONAL', 'INDIVIDUAL', 'PROPIO', 'CORREOPROPIO']
                      };

                      for (const kw of keywords) {
                          if (cleanExcel.includes(kw)) {
                              if (cleanPlan.includes(kw)) return true;
                              if (synonyms[kw] && synonyms[kw].some(syn => cleanPlan.includes(syn))) {
                                  return true;
                              }
                          }
                      }
                      
                      return cleanExcel.includes(cleanPlan) || cleanPlan.includes(cleanExcel);
                  });
                  
                  if (specificPlan) {
                      price = specificPlan.price;
                  } else if (price === 0) {
                      price = platInfo.plans[0].price;
                  }
              }
          }
          totalSum += price;
        });

        // Apply combo discount in automatic charging notice
        const imminentRenewals = targetAccounts.filter(acc => {
            const expDate = getJsDateFromExcel(acc.deben || acc.vencimiento);
            if (!expDate) return false;
            const diffDays = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
            return diffDays <= 1;
        });
        if (totalSum > 0 && imminentRenewals.length > 1) {
            const discount = (imminentRenewals.length - 1) * 1000;
            totalSum -= discount;
        }

        if (totalSum > 0) {
          totalText = `\n\n*Total a transferir:* $${totalSum.toLocaleString('es-CO')} COP 💰\n*Medio de Pago:* Llave Bre-V: \`0087387259\` 🔑 (Entrega inmediata ⚡)`;
          if (billedServicesList.length > 0) {
              const uniqueBilled = Array.from(new Set(billedServicesList));
              servicesToPrint = uniqueBilled.join(', ');
          }
        }
      }
    } catch (calcErr) {
      console.error("[Billing Auto] Error calculating total for initial message:", calcErr.message);
    }

    try {
        const customMessage = `🤖 *Aviso de Cobro*\nHola ${r.name}, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que ${vencimientoTxt}.\n\nServicio(s): ${servicesToPrint}${totalText}\n\nEscribe *3* en este chat para conocer el desglose detallado (precios, combos y correos) o ver otros medios. ¡Gracias por preferirnos!`;
        await client.sendMessage(dest, customMessage);
        
        if (userStates && userStates.has(dest)) {
            const st = userStates.get(dest);
            const stateStr = (typeof st === 'object') ? st.state : st;
            if (stateStr === 'waiting_human') {
                userStates.delete(dest);
                console.log(`[Auto-Billing] Cleared waiting_human state for ${dest} to allow automated interactions.`);
            }
        }
        exitosos++;
    } catch(e) {
        console.error(`[Billing] Error enviando cobro a ${dest}:`, e.message);
    }
    
    // Pausa de seguridad (3s anti-spam)
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return exitosos;
}

async function handleCobrosParser(message, userId, userStates, pendingConfirmations) {
  // Obtener todo el texto que va después de la llamada al bot
  const bodyText = message.body || '';
  let payload = '';
  
  if (bodyText.includes(':')) {
    payload = bodyText.substring(bodyText.indexOf(':') + 1);
  } else {
    const commandRegex = /^@bot\s+(cobra\s+estos|porfa\s+haz\s+los\s+cobros\s+para\s+hoy\s+de|haz\s+los\s+cobros\s+de)\s*/i;
    payload = bodyText.replace(commandRegex, '');
  }

  const lines = payload.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const parsedLines = [];
  
  for (let line of lines) {
    line = line.replace(/\t/g, ' ').trim();
    line = line.replace(/^[\*\-\•]\s*/, '').trim();
    
    let name = '';
    let phone = '';

    const telIndicatorRegex = /(?:tel|celular|telefono|teléfono):\s*(\d+)/i;
    const telMatch = line.match(telIndicatorRegex);
    
    if (telMatch) {
      phone = telMatch[1].trim();
      const namePart = line.split(telIndicatorRegex)[0].replace(/[\-,\s]+$/, '').trim();
      name = namePart;
    } else {
      const parts = line.includes(',') ? line.split(',') : line.split('-');
      name = (parts[0] || '').trim();
      const rest = (parts.slice(1).join(',') || '').trim();
      phone = (rest.match(/\d+/g) || []).join('');
    }

    if (name && phone) {
      if (!phone.startsWith('57') && !phone.startsWith('52')) {
        if (phone.length === 10) phone = '57' + phone;
      }
      parsedLines.push({ name, phone });
    }
  }

  if (parsedLines.length === 0) {
    await message.reply('🤖 No pude parsear ninguna línea de números de la lista. Verifica el formato e intenta nuevamente.');
    return;
  }

  const finalRecords = [];
  const skippedList = [];
  
  // Buscar en base de datos de Excel para verificar servicios actuales y saltar si ya pagaron
  for (const item of parsedLines) {
    try {
      const destId = item.phone + '@c.us';
      const userState = userStates.get(destId);
      const stateStr = (typeof userState === 'object') ? userState.state : userState;

      // 1. Si el chat está pendiente de validación manual o confirmación de pago por el admin, lo saltamos
      if (stateStr === 'waiting_admin_confirmation' || stateStr === 'awaiting_payment_confirmation') {
        skippedList.push({ name: item.name, phone: item.phone, reason: 'Ya hay un pago en validación.' });
        continue;
      }

      // 2. Buscar cuentas del cliente en el Excel
      const userAccounts = await getAccountsByPhone(item.phone);
      if (userAccounts.length === 0) {
        // Si no tiene cuentas vigentes asociadas, no sabemos qué cobrarle
        skippedList.push({ name: item.name, phone: item.phone, reason: 'No tiene cuentas registradas.' });
        continue;
      }

      // Extraer los nombres de las plataformas reales asociadas al cliente
      const services = userAccounts.map(acc => (acc.Streaming || acc.streaming || '').toString().trim()).filter(s => s.length > 0);
      if (services.length === 0) {
        skippedList.push({ name: item.name, phone: item.phone, reason: 'Servicios sin nombre en base de datos.' });
        continue;
      }

      // Añadir al registro de cobro con las plataformas reales del Excel
      finalRecords.push({
        name: item.name,
        phone: item.phone,
        textToShow: services.join(', ')
      });

    } catch (err) {
      console.error(`Error validando cuenta para ${item.phone}:`, err);
      // Fallback: lo añadimos igual con genérico por si falla la llamada
      finalRecords.push({
        name: item.name,
        phone: item.phone,
        textToShow: 'tus servicios'
      });
    }
  }

  if (finalRecords.length === 0) {
    let report = '🤖 Revisé los números en la base de datos y todos fueron omitidos:\n\n';
    skippedList.forEach(s => {
      report += `• *${s.name}* (Tel: ${s.phone}) - Omitido: _${s.reason}_\n`;
    });
    await message.reply(report);
    return;
  }

  const client = message._client || global.client; 
  
  // Avisar al admin sobre el análisis inicial
  let alertMsg = `🚀 *Iniciando envío directo...*\n`;
  alertMsg += `✅ A cobrar: ${finalRecords.length} destinatarios.\n`;
  if (skippedList.length > 0) {
    alertMsg += `⚠️ Omitidos (salteados): ${skippedList.length}\n`;
    skippedList.forEach(s => {
      alertMsg += ` • *${s.name}* (${s.phone}): _${s.reason}_\n`;
    });
  }
  await message.reply(alertMsg);

  try {
    const exitosos = await sendBulkCharges(client, finalRecords, userId, userStates);
    await message.reply(`🤖 *PROCESO COMPLETADO EXCELENTE*\n- Total en lista: ${parsedLines.length}\n- Enviados con éxito: ${exitosos}\n- Omitidos: ${skippedList.length}\n- Fallidos: ${finalRecords.length - exitosos}`);
  } catch (error) {
    console.error("Error enviando cobros directos:", error);
    await message.reply("⚠️ Hubo un error al procesar el envío masivo de cobros directos.");
  }
}

async function handleAwaitingCobrosConfirmation(message, userId, userStates, pendingConfirmations, client) {
  try {
    const body = (message.body || '').trim().toLowerCase();
    if (body === 'si' || body === 'sí') {
      const records = pendingConfirmations.get(userId) || [];
      if (records.length === 0) {
        await message.reply('🤖 No hay cobros pendientes para confirmar.');
        userStates.delete(userId);
        return;
      }

      await message.reply(`🚀 *Iniciando envío de ${records.length} cobros confirmados...*`);
      const exitosos = await sendBulkCharges(client, records, userId);

      await message.reply(`🤖 He finalizado el proceso.\n- Total: ${records.length}\n- Enviados con éxito: ${exitosos}\n- Fallidos: ${records.length - exitosos}`);
      pendingConfirmations.delete(userId);
      userStates.delete(userId);
    } else if (body === 'no') {
      pendingConfirmations.delete(userId);
      userStates.delete(userId);
      await message.reply('🤖 Operación cancelada. No se enviaron cobros.');
    } else {
      await message.reply('🤖 Por favor responde *SI* para confirmar o *NO* para cancelar.');
    }
  } catch (error) {
    console.error("Error en confirmación de cobros:", error);
    await message.reply("🤖 ⚠️ Ocurrió un error procesando tu solicitud. Por favor contacta al administrador.");
    userStates.delete(userId);
  }
}

async function handleAutoCobros(message, userId, userStates, pendingConfirmations, client) {
  try {
    const { fetchCustomersData } = require('./apiService');
    const clientes = await fetchCustomersData();
    
    const today = getTodayInBogota();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    let records = [];
    const { updateExcelData } = require('./apiService');
    
    for (const account of clientes) {
      let isTargetDate = false;
      let accountDate = null;
      let diffDays = 0;
      
      accountDate = getJsDateFromExcel(account.deben);
      if (accountDate) {
        if (accountDate.getTime() <= tomorrow.getTime()) {
           isTargetDate = true;
        }
        const diffTime = today.getTime() - accountDate.getTime();
        diffDays = Math.floor(diffTime / (1000 * 3600 * 24));
      }
      
      if (isTargetDate && account.numero) {
        let phone = account.numero.toString().replace(/\D/g, '');
        if (!phone.startsWith('57')) {
          if (phone.length === 10) phone = '57' + phone;
        }
        
        const destId = phone + '@c.us';
        const currentState = userStates.get(destId);
        const stateStr = (typeof currentState === 'object') ? currentState.state : currentState;

        let observacion = (account.observaciones || '').toString().trim();
        let dateStr = accountDate ? accountDate.toLocaleDateString('es-ES') : '';
        if (accountDate && accountDate.getTime() === tomorrow.getTime()) {
            dateStr = "MAÑANA";
        }

        // LÓGICA DE SUSPENSIÓN (CORTAR)
        let wasSuspendedNow = false;
        if (diffDays >= 3 && !observacion.toLowerCase().includes('cortar')) {
            observacion = observacion ? observacion + " - cortar" : "cortar";
            try {
                if (account.rowNumber) {
                    await updateExcelData(account.rowNumber, { "observaciones": observacion });
                    console.log(`[SUSPENSIÓN] Se agregó 'cortar' a fila ${account.rowNumber} (${account.Nombre}) por >3 días de mora.`);
                    wasSuspendedNow = true;
                }
            } catch (err) {
                console.error(`Error auto-suspendiendo fila ${account.rowNumber}:`, err);
            }
        }

        // --- FILTRO DE SEGURIDAD ---
        if (stateStr === 'waiting_admin_confirmation') {
          records.push({ 
            name: account.Nombre || 'Cliente', 
            phone, 
            service: account.Streaming || 'Servicio',
            dateStr,
            observacion: `Ya hay actividad o pago en este chat (${stateStr}).`,
            isSkip: true
          });
          continue;
        }
        
        records.push({ 
          name: account.Nombre || 'Cliente', 
          phone, 
          service: account.Streaming || 'Servicio',
          dateStr,
          observacion,
          wasSuspendedNow // Bandera para enviar mensaje de corte hoy
        });
      }
    }

    if (records.length === 0) {
      await message.reply('🤖 Revisé la base de datos y no encontré cobros pendientes para hoy o fechas anteriores en la columna "deben".');
      return;
    }

    const toChargeUsers = new Map();
    const toReviewUsers = new Map();
    const toNotifyAdminUsers = new Map();
    const toSuspendUsers = new Map();
    
    records.forEach(r => {
      if (r.isSkip) {
        if (!toNotifyAdminUsers.has(r.phone)) {
            toNotifyAdminUsers.set(r.phone, { name: r.name, phone: r.phone, services: [], reason: r.observacion });
        }
        toNotifyAdminUsers.get(r.phone).services.push(r.service);
        return;
      }

      if (r.wasSuspendedNow) {
          if (!toSuspendUsers.has(r.phone)) {
              toSuspendUsers.set(r.phone, { name: r.name, phone: r.phone, services: [] });
          }
          toSuspendUsers.get(r.phone).services.push(r.service);
          return;
      }

      const lowerObs = r.observacion ? r.observacion.toLowerCase() : '';
      const hasCorte = lowerObs.includes('cortar') || lowerObs.includes('corte');
      
      if (r.observacion && hasCorte) {
         // Va a revisión manual, SÓLO este servicio específico
         if (!toReviewUsers.has(r.phone)) {
           toReviewUsers.set(r.phone, { name: r.name, phone: r.phone, services: [] });
         }
         toReviewUsers.get(r.phone).services.push(`${r.service} (Nota: ${r.observacion})`);
      } else {
         // Va a cobrar (incluso si hay notas, si no son de corte, se adjuntan)
         if (!toChargeUsers.has(r.phone)) {
           toChargeUsers.set(r.phone, { name: r.name, phone: r.phone, services: [], date: r.dateStr });
         }
         let serviceDisplay = r.service;
         if (r.observacion) {
           serviceDisplay += ` (Nota del asesor: ${r.observacion})`;
         }
         toChargeUsers.get(r.phone).services.push(serviceDisplay);
      }
    });

    const toCharge = Array.from(toChargeUsers.values());
    const toReview = Array.from(toReviewUsers.values());
    const toNotify = Array.from(toNotifyAdminUsers.values());
    const toSuspend = Array.from(toSuspendUsers.values());

    if (toCharge.length === 0 && toReview.length === 0 && toNotify.length === 0 && toSuspend.length === 0) {
      await message.reply('🤖 No se encontraron cobros, revisiones ni pagos pendientes para procesar.');
      return;
    }

    // AVISAR QUE INICIAMOS
    await message.reply(`🤖 *PROCESO AUTOMÁTICO DE COBROS INICIADO*\n\nHe encontrado ${toCharge.length} para cobrar, ${toSuspend.length} para corte inminente, ${toReview.length} para revisión y ${toNotify.length} con pagos/actividad pendiente. Procedo con el envío...`);

    // EJECUCIÓN DIRECTA
    let exitosos = 0;
    if (toCharge.length > 0) {
        exitosos = await sendBulkCharges(client || message._client, toCharge, userId, userStates);
    }
    
    // ENVIAR AVISO DE CORTE
    let exitososCorte = 0;
    for (const r of toSuspend) {
        try {
            const destId = r.phone + '@c.us';
            const suspendMsg = `⚠️ *AVISO DE CORTE INMINENTE* ⚠️\n\nHola ${r.name}, te informamos que por falta de respuesta, tus cuentas de *${r.services.join(', ')}* serán suspendidas el día de hoy a menos de que envíes el comprobante de pago en el transcurso del día.\n\nPor favor envíanos tu comprobante lo antes posible para evitar la interrupción del servicio.`;
            await (client || message._client).sendMessage(destId, suspendMsg);
            if (userStates && userStates.has(destId)) {
                const st = userStates.get(destId);
                const stateStr = (typeof st === 'object') ? st.state : st;
                if (stateStr === 'waiting_human') {
                    userStates.delete(destId);
                    console.log(`[Auto-Billing] Cleared waiting_human state for ${destId} during suspension notice.`);
                }
            }
            exitososCorte++;
            await new Promise(res => setTimeout(res, 1000));
        } catch (e) {
            console.error(`Error enviando aviso de corte a ${r.phone}:`, e);
        }
    }

    let finalReport = `✅ *REPORTE DE EJECUCIÓN FINALIZADO*\n\n`;
    finalReport += `- Cobros enviados: ${exitosos}/${toCharge.length}\n`;
    finalReport += `- Avisos de corte enviados: ${exitososCorte}/${toSuspend.length}\n`;
    
    if (toSuspend.length > 0) {
      finalReport += `\n🚨 *CUENTAS MARCADAS PARA CORTE HOY:*\n`;
      toSuspend.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone}\n  Servicios: ${r.services.join(', ')}\n`;
      });
    }

    if (toReview.length > 0) {
      finalReport += `\n⚠️ *PENDIENTES PARA REVISIÓN MANUAL (Cortes antiguos):*\n`;
      toReview.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone}\n  Notas: ${r.services.join(' | ')}\n`;
      });
    }

    if (toNotify.length > 0) {
      finalReport += `\n📥 *PAGOS/CHATS POR VALIDAR (Bot saltó el cobro):*\n`;
      toNotify.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone} (${r.services.join(', ')}) - Motivo: ${r.reason || 'Sin especificar'}\n`;
      });
    }

    finalReport += `\n_El bot ha terminado su tarea programada de la mañana._`;
    await message.reply(finalReport);

  } catch (err) {
    console.error('Error calculando cobros automáticos:', err);
    await message.reply('Ocurrió un error al consultar Azure. Intenta nuevamente.');
  }
}

module.exports = {
  processCheckCredentials,
  processCheckPrices,
  handleAutoCobros,
  handleCobrosParser,
  handleAwaitingCobrosConfirmation,
  adjustDurationToMatchAmount
};
