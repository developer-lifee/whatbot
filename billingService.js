const { getAccountsByPhone, fetchCustomersData, getJsDateFromExcel, getTodayInBogota } = require('./apiService');
const { generateCredentialsResponse } = require('./aiService');
const { getPlatformKnowledge } = require('./apiService');
const path = require('path');
const fs = require('fs');

/**
 * Procesa la solicitud de credenciales de un usuario.
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

/**
 * Procesa la solicitud de precios/deudas de un usuario (Opción 3 del menú).
 */
async function processCheckPrices(message, userId, userStates, inputToUse = "", detectedPlatform = null, durationMonths = 1) {
    try {
        const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
        const userAccounts = await getAccountsByPhone(phoneNumber);

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
                'APPLE TV': 'APPLE',
                'HBO': 'HBOMAX',
                'MAX': 'HBOMAX',
                'DISNEY': 'DISNEY+ PREMIUM',
                'STAR': 'DISNEY+ PREMIUM',
                'YOUTUBE': 'YOUTUBE PREMIUM'
            };
            for (const [alias, real] of Object.entries(aliasMap)) {
                if (mappedStreaming.includes(alias)) {
                    mappedStreaming = real;
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

            response += `📺 *${streaming}*\n`;
            response += `📧 ${acc.correo || 'Sin correo'}\n`;
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

        // Lógica de descuento por combo: solo aplica si se renuevan varios servicios que vencen pronto (imminent)
        // Multiplicamos el descuento base de 1000 por la cantidad de meses para que sea proporcional
        const imminentRenewals = itemsForRenewal.filter(item => {
            const expDate = getJsDateFromExcel(item.deben || item.vencimiento);
            if (!expDate) return false;
            // Consideramos inminente si vence hoy, mañana o ya venció
            const diffDays = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
            return diffDays <= 1; 
        });

        if (total > 0 && imminentRenewals.length > 1) {
            const discount = (imminentRenewals.length - 1) * 1000 * durationMonths;
            total -= discount;
            response += `✨ *Descuento por combo:* -$${discount}\n`;
        }

        response += `*TOTAL A PAGAR: $${total}*\n\n`;
        response += "🤖 ¿Por cuál medio deseas realizar la transferencia?\n\n⭐ *QR Negocios (RECOMENDADO - ENTREGA INMEDIATA ⚡)*\n⭐ *Llave Bre-V (Nequi/Daviplata/Ahorro - ENTREGA INMEDIATA ⚡)*:\n   • Celular: *0087387259*\n⭐ *Bancolombia (Abono Directo - VALIDACIÓN AUTOMÁTICA ⚡)*:\n   • Ahorros: *46772753713* (CC: 1032936324)\n\n📌 *Otras Opciones (Verificación Manual por Asesor ⏳):*\n⭐ *Llave Bre-B alternativa:* 3118587974\n⭐ *Banco Caja Social:* Ahorros 24111572331 (CC: 1032936324)\n\n💡 *Tip de Renovación:* Si pagas por un medio automático (QR, Llave Bre-V o Bancolombia), tu servicio se renovará al instante. **¡Así no se te volverá a repetir este recordatorio de cobro ni un solo día más, ya que tu fecha de vencimiento se actualiza de inmediato!** ⚡🤖";

        await message.reply(response);
        
        // Actualizar estado para esperar comprobante
        userStates.set(userId, { 
            state: 'awaiting_payment_method', 
            total: total, 
            items: itemsForRenewal, 
            isRenewal: true,
            durationMonths: durationMonths
        });

    } catch (error) {
        console.error('[Billing Service] Error en processCheckPrices:', error);
        await message.reply("🤖 Tuve un problema al calcular tus precios. Por favor espera a que un asesor revise tu caso.");
    }
}

/**
 * Maneja el proceso automático de cobros (Aviso de Cobro).
 */
async function handleAutoCobros(message, groupId, userStates, pendingConfirmations, client) {
    try {
        console.log('[Billing Service] Iniciando escaneo de vencimientos para cobros automáticos...');
        const customers = await fetchCustomersData();
        const today = getTodayInBogota();
        
        // Notificar al grupo que inició el proceso
        if (message && typeof message.reply === 'function') {
            await message.reply('⏳ Escaneando base de datos para enviar avisos de cobro...');
        }

        const expiredOrSoon = customers.filter(c => {
            const expDate = getJsDateFromExcel(c.deben || c.vencimiento);
            if (!expDate) return false;
            
            const observaciones = String(c.observaciones || "").toUpperCase();
            if (observaciones.includes("COMPROBANTE") || observaciones.includes("REVISAR")) return false;
            
            // Avisar si vence hoy o ya venció hace poco (ej: hasta 2 días atrás)
            const diffDays = Math.floor((today - expDate) / (1000 * 60 * 60 * 24));
            return diffDays >= -1 && diffDays <= 2; // -1 es "vence mañana", 0 es "vence hoy", 1-2 es "vencido"
        });

        // Agrupar por teléfono para no mandar 5 mensajes a alguien con 5 cuentas
        const groupedByPhone = {};
        expiredOrSoon.forEach(c => {
            const phone = (c.numero || c.Numero || c.whatsapp || "").toString().replace(/\D/g, '');
            if (phone.length < 10) return;
            const fullPhone = phone.startsWith('57') ? phone : '57' + phone;
            
            if (!groupedByPhone[fullPhone]) {
                groupedByPhone[fullPhone] = {
                    nombre: c.Nombre || 'cliente',
                    servicios: [],
                    vencimiento: c.deben || c.vencimiento
                };
            }
            groupedByPhone[fullPhone].servicios.push((c.Streaming || 'Servicio').toUpperCase());
        });

        let sentCount = 0;
        for (const [phone, data] of Object.entries(groupedByPhone)) {
            const userId = phone + '@c.us';
            const expDate = getJsDateFromExcel(data.vencimiento);
            const diffDays = expDate ? Math.floor((today - expDate) / (1000 * 60 * 60 * 24)) : 99;
            
            let dateContext = "está próximo a vencer o ya venció";
            if (diffDays === -1) dateContext = "vence el día de mañana";
            else if (diffDays === 0) dateContext = "vence el día de HOY";
            else if (diffDays === 1) dateContext = "se venció el día de ayer";
            else if (diffDays > 1) dateContext = `se venció el pasado ${expDate.toLocaleDateString('es-CO')}`;

            const msg = `🤖 *Aviso de Cobro*\n\nHola *${data.nombre}*, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que tu servicio ${dateContext}.\n\nServicio(s): ${data.servicios.join(', ')}\n\nEscribe *3* en este chat para conocer el valor exacto a pagar y ver los medios de transferencia. ¡Gracias por preferirnos! 😊`;
            
            try {
                await client.sendMessage(userId, msg);
                sentCount++;
                // Pequeño delay para evitar spam block
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                console.error(`Error enviando cobro a ${phone}:`, e.message);
            }
        }

        if (message && typeof message.reply === 'function') {
            await message.reply(`✅ Proceso finalizado. Se enviaron ${sentCount} avisos de cobro exitosamente.`);
        }

    } catch (error) {
        console.error('[Billing Service] Error en handleAutoCobros:', error);
        if (message && typeof message.reply === 'function') {
            await message.reply('❌ Error al procesar los cobros automáticos.');
        }
    }
}

/**
 * Marcadores de posición para otras funciones requeridas por index.js
 */
async function handleCobrosParser(message) {
    await message.reply("🤖 Función de parseo manual de cobros no implementada aún en este módulo, pero puedes usar '@bot cobros automáticos' para el proceso general.");
}

async function handleAwaitingCobrosConfirmation(message, userId, userStates) {
    // Lógica para cuando el usuario confirma que recibió el cobro o pregunta algo
    await processCheckPrices(message, userId, userStates);
}

module.exports = {
    processCheckCredentials,
    processCheckPrices,
    handleAutoCobros,
    handleCobrosParser,
    handleAwaitingCobrosConfirmation
};
