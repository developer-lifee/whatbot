const fs = require('fs');
const path = require('path');
const { getAccountsByPhone } = require('./apiService');
const { getPlatforms } = require('./salesService');

async function handleCobrosParser(message, userId, userStates, pendingConfirmations) {
  const payload = message.body.split(':')[1] || '';
  const lines = payload.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const records = [];
  
  for (let line of lines) {
    line = line.replace(/\t/g, ' ');
    const parts = line.split(',');
    const name = (parts[0] || '').trim();
    const rest = (parts.slice(1).join(',') || '').trim();
    
    const digits = (rest.match(/\d+/g) || []).join('');
    if (name && digits) {
      let phone = digits;
      if (!phone.startsWith('57')) {
        if (phone.length === 10) phone = '57' + phone;
      }
      records.push({ name, phone });
    }
  }

  if (records.length === 0) {
    await message.reply('No pude parsear las líneas. Verifica el formato y vuelve a intentarlo.');
    return;
  }

  const names = records.map(r => r.name);
  const summary = records.length > 1
    ? `Al día de hoy tienes vencidas las cuentas de ${names.join(', ')}. ¿Deseas renovar?`
    : `Al día de hoy tienes vencida la cuenta de ${names[0]}. ¿Deseas renovar?`;

  pendingConfirmations.set(userId, records);
  await message.reply(`Recibí los siguientes cargos (tal cual los enviaste):\n\n${lines.join('\n')}\n\n${summary}\nResponde *SI* para confirmar o *NO* para cancelar.`);
}

/**
 * Función auxiliar para enviar mensajes de cobro de forma masiva con delay anti-spam.
 */
async function sendBulkCharges(client, records, requesterId = null) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'pending_charges.json');
  
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
  const entry = { requester: requesterId || 'SYSTEM_AUTO', records, timestamp: new Date().toISOString() };
  existing.push(entry);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));

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
    
    try {
        await client.sendMessage(dest, `🤖 *Aviso de Cobro*\nHola ${r.name}, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que ${vencimientoTxt}.\n\nServicio(s): ${serviceName}\n\nEscribe *3* en este chat para conocer el valor a pagar y ver los medios de transferencia. ¡Gracias por preferirnos!`);
        exitosos++;
    } catch(e) {
        console.error(`[Billing] Error enviando cobro a ${dest}:`, e.message);
    }
    
    // Pausa de seguridad (3s anti-spam)
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return exitosos;
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

async function processCheckPrices(message, userId, userStates) {
  try {
    // RESOLUCIÓN DE CONTACTO: Queremos el número del CLIENTE, no del remitente
    // (Útil si el último mensaje fue del bot en un batch scan)
    const client = message._client || null; // Algunos objetos message tienen el client inyectado
    let contact;
    if (client) {
        contact = await client.getContactById(userId);
    } else {
        contact = await message.getContact();
    }
    
    const phoneNumber = contact.number; // number es el teléfono real sin @c.us o LID
    const userAccounts = await getAccountsByPhone(phoneNumber);
    const platforms = await getPlatforms();

    // Mapa de alias para normalizar nombres del Excel al catálogo
    const PLATFORM_ALIASES = {
      'amazon': 'prime video',
      'prime': 'prime video',
      'hbo': 'max',
      'hbomax': 'max',
      'disney': 'disney+',
      'star': 'disney+',
      'm365': 'microsoft 365',
      'office': 'microsoft 365'
    };

    if (userAccounts.length > 0) {
      let replyMessage = "Tus cuentas actuales para renovar o pagar son:\n";
      let totalToPay = 0;
      let dateGroups = new Map();

      for (const account of userAccounts) {
        let fechaVencimientoObj = null;
        let fechaVencimientoStr = "Fecha desconocida";
        
        if (account.deben && !isNaN(parseFloat(account.deben))) {
            const excelDate = parseFloat(account.deben);
            const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
            
            // Comparación de fechas sin hora (Bogotá)
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            fechaVencimientoObj = new Date(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
            
            const diffTime = fechaVencimientoObj - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
                fechaVencimientoStr = "¡HOY!";
            } else if (diffDays === 1) {
                fechaVencimientoStr = "MAÑANA";
            } else {
                fechaVencimientoStr = fechaVencimientoObj.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
            }
        } else if (account.vencimiento) {
            fechaVencimientoStr = account.vencimiento;
        }

        const rawStreamingName = (account.Streaming || "SERVICIO").toUpperCase();
        const streamingName = rawStreamingName;
        
        // 1. Intentar precio del Excel como base
        let price = parseFloat(account["Ingreso Mensual"]) || 0;
        
        // 2. Normalizar nombre y buscar en catálogo
        let searchName = rawStreamingName.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Aplicar alias si existe
        if (PLATFORM_ALIASES[searchName]) {
          searchName = PLATFORM_ALIASES[searchName].toLowerCase().replace(/[^a-z0-9]/g, '');
        }

        let catalogPlatform = platforms.find(p => {
          const normalizedCatalogName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normalizedCatalogName === searchName || searchName.includes(normalizedCatalogName) || normalizedCatalogName.includes(searchName);
        });
        
        // Fix: Evitar que "Netflix Extra" adquiera el precio de la plataforma "Netflix" base
        if (catalogPlatform && searchName.includes('extra') && !catalogPlatform.name.toLowerCase().includes('extra')) {
          catalogPlatform = platforms.find(p => {
            const normalizedCatalogName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return normalizedCatalogName === searchName && searchName.includes('extra');
          }) || null;
        }

        if (catalogPlatform && catalogPlatform.plans && catalogPlatform.plans.length > 0) {
          // El catálogo manda sobre el precio manual si el catálogo tiene precio válido
          const catalogPrice = catalogPlatform.plans[0].price;
          if (catalogPrice > 0) {
            price = catalogPrice;
          }
        }
        
        totalToPay += price;

        replyMessage += `\n• ${streamingName} (Vence el ${fechaVencimientoStr})`;
        if (price > 0) {
           replyMessage += ` - $${price}`;
        } else {
           replyMessage += ` - (Pendiente confirmar precio)`;
        }

        if (fechaVencimientoObj) {
          const dateKey = fechaVencimientoObj.getTime();
          dateGroups.set(dateKey, (dateGroups.get(dateKey) || 0) + 1);
        }
      }
      
      let totalDiscount = 0;
      dateGroups.forEach((count) => {
        if (count > 1) {
          totalDiscount += (count - 1) * 1000;
        }
      });

      if (totalDiscount > 0) {
        totalToPay -= totalDiscount;
        replyMessage += `\n\nDescuento por combo (vencimiento mismo día): -$${totalDiscount}`;
      }

      if (totalToPay > 0) {
        replyMessage += `\n\nTotal a pagar: $${totalToPay} COP`;
      }

      replyMessage += "\n\n🤖 *Importante:* Hemos sumado los precios estándar de tus servicios con los descuentos por combo correspondientes. Si tienes alguna duda sobre tu factura o crees que aplicas a algún descuento adicional, por favor espera un momento a que un asesor humano revise tu caso personalmente. 😊";

      replyMessage += "\n\n¿Por cuál medio deseas hacer la transferencia para tu renovación?\n⭐Nequi\n⭐Llaves Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia";
      
      await message.reply(replyMessage);
      userStates.set(userId, { state: 'awaiting_payment_method', total: totalToPay > 0 ? totalToPay : null, isRenewal: true, items: userAccounts });
    } else {
      await message.reply(`🤖 No encontramos cuentas pendientes o asociadas al número ${phoneNumber}. Si crees que hay un error, contacta a un asesor. 😊`);
      userStates.delete(userId);
    }
  } catch (error) {
    console.error('Error en processCheckPrices con la base de datos de Azure:', error);
    await message.reply("🤖 Hubo un error al procesar tu solicitud. Por favor, inténtalo de nuevo más tarde.");
    userStates.delete(userId);
  }
}

async function handleAutoCobros(message, userId, userStates, pendingConfirmations, client) {
  try {
    const { fetchCustomersData } = require('./apiService');
    const clientes = await fetchCustomersData();
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    let records = [];
    
    clientes.forEach(account => {
      let isTargetDate = false;
      let accountDate = null;
      
      if (account.deben && !isNaN(parseFloat(account.deben))) {
        const excelDate = parseFloat(account.deben);
        const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
        accountDate = new Date(jsDate.getFullYear(), jsDate.getMonth(), jsDate.getDate());
        
        // Incluir cualquier fecha que sea mañana o en el pasado
        if (accountDate.getTime() <= tomorrow.getTime()) {
           isTargetDate = true;
        }
      }
      
      if (isTargetDate && account.numero) {
        let phone = account.numero.toString().replace(/\D/g, '');
        if (!phone.startsWith('57')) {
          if (phone.length === 10) phone = '57' + phone;
        }
        
        const observacion = (account.observaciones || '').toString().trim();
        let dateStr = accountDate ? accountDate.toLocaleDateString('es-ES') : '';
        if (accountDate && accountDate.getTime() === tomorrow.getTime()) {
            dateStr = "MAÑANA";
        }
        
        records.push({ 
          name: account.Nombre || 'Cliente', 
          phone, 
          service: account.Streaming || 'Servicio',
          dateStr,
          observacion
        });
      }
    });

    if (records.length === 0) {
      await message.reply('🤖 Revisé la base de datos y no encontré cobros pendientes para hoy o fechas anteriores en la columna "deben".');
      return;
    }

    const toChargeUsers = new Map();
    const toReviewUsers = new Map();
    
    records.forEach(r => {
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

    if (toCharge.length === 0 && toReview.length === 0) {
      await message.reply('🤖 No se encontraron cobros ni revisiones para procesar.');
      return;
    }

    // AVISAR QUE INICIAMOS
    await message.reply(`🤖 *PROCESO AUTOMÁTICO DE COBROS INICIADO*\n\nHe encontrado ${toCharge.length} clientes listos para cobrar y ${toReview.length} que requieren revisión manual. Procedo con el envío directo...`);

    // EJECUCIÓN DIRECTA
    let exitosos = 0;
    if (toCharge.length > 0) {
        exitosos = await sendBulkCharges(client || message._client, toCharge, userId);
    }

    let finalReport = `✅ *REPORTE DE EJECUCIÓN FINALIZADO*\n\n`;
    finalReport += `- Cobros enviados: ${exitosos}/${toCharge.length}\n`;
    
    if (toReview.length > 0) {
      finalReport += `\n⚠️ *PENDIENTES PARA REVISIÓN MANUAL (Cortes):*\n`;
      toReview.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone}\n  Notas: ${r.services.join(' | ')}\n`;
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
  handleCobrosParser,
  handleAwaitingCobrosConfirmation,
  processCheckPrices,
  handleAutoCobros
};
