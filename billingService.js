const { getAccountsByPhone, generateCredentialsResponse, fetchCustomersData, getJsDateFromExcel, getTodayInBogota } = require('./apiService');
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
async function processCheckPrices(message, userId, userStates, inputToUse = "", detectedPlatform = null) {
    try {
        const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, '');
        const userAccounts = await getAccountsByPhone(phoneNumber);

        if (userAccounts.length === 0) {
            await message.reply("🤖 No encontré servicios activos vinculados a este número para renovar. Si deseas comprar algo nuevo, escribe *1*.");
            return;
        }

        const platforms = await getPlatformKnowledge();
        const today = getTodayInBogota();
        
        let response = "💰 *TU RESUMEN DE PAGO*\n\n";
        let total = 0;
        let itemsForRenewal = [];

        userAccounts.forEach(acc => {
            const streaming = (acc.Streaming || "").toUpperCase();
            const vencimientoRaw = acc.deben || acc.vencimiento;
            const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
            
            // Buscar precio base en platforms.json
            let price = 0;
            const platInfo = platforms.find(p => streaming.includes(p.name.toUpperCase()));
            if (platInfo && platInfo.plans && platInfo.plans.length > 0) {
                // Intentamos buscar el plan que coincida con el nombre en el Excel (si existe esa columna)
                // O usamos el primer plan por defecto
                price = platInfo.plans[0].price;
            }

            // Si el Excel tiene un valor en 'Ingreso Mensual2' o similar, podríamos usarlo, 
            // pero por ahora usamos el catálogo oficial para consistencia.
            
            const isExpired = vencimientoDate && vencimientoDate <= today;
            const status = isExpired ? "⚠️ VENCIDO" : "✅ Vigente";

            response += `📺 *${streaming}*\n`;
            response += `📧 ${acc.correo || 'Sin correo'}\n`;
            response += `📅 Vence: ${vencimientoDate ? vencimientoDate.toLocaleDateString() : 'N/A'} (${status})\n`;
            response += `💵 Valor: $${price}\n\n`;
            
            total += price;
            itemsForRenewal.push({ ...acc, price, platform: { name: (acc.Streaming || 'Servicio') } });
        });

        if (total > 0 && itemsForRenewal.length > 1) {
            const discount = (itemsForRenewal.length - 1) * 1000;
            total -= discount;
            response += `✨ *Descuento por combo:* -$${discount}\n`;
        }

        response += `*TOTAL A PAGAR: $${total}*\n\n`;
        response += "🤖 ¿Por cuál medio deseas realizar la transferencia?\n\n⭐ *QR Negocios (RECOMENDADO ⚡)*\n⭐ *Llaves (Bre-V / Bre-B)*\n⭐ *Nequi / Daviplata / Transfiya*\n⭐ *Bancolombia / Banco Caja Social*\n\n💡 *Tip:* Si pagas por *QR* o *Llave Bre-V*, el bot valida tu pago automáticamente y entrega el servicio de inmediato. 🤖";

        await message.reply(response);
        
        // Actualizar estado para esperar comprobante
        userStates.set(userId, { 
            state: 'awaiting_payment_method', 
            total: total, 
            items: itemsForRenewal, 
            isRenewal: true 
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
            const msg = `🤖 *Aviso de Cobro*\n\nHola *${data.nombre}*, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que tus servicios están próximos a vencer o ya vencieron.\n\nServicio(s): ${data.servicios.join(', ')}\n\nEscribe *3* en este chat para conocer el valor exacto a pagar y ver los medios de transferencia. ¡Gracias por preferirnos! 😊`;
            
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
