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
  userStates.set(userId, 'awaiting_cobros_confirmation');
  await message.reply(`Recibí los siguientes cargos (tal cual los enviaste):\n\n${lines.join('\n')}\n\n${summary}\nResponde *SI* para confirmar o *NO* para cancelar.`);
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

      const file = path.join(__dirname, 'pending_charges.json');
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
      const entry = { requester: userId, records, timestamp: new Date().toISOString() };
      existing.push(entry);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2));

      for (const r of records) {
        const dest = r.phone + '@c.us';
        
        let vencimientoTxt = "tu suscripción está próxima a renovarse o ya venció";
        if (r.date) {
            if (r.date === "MAÑANA") {
               vencimientoTxt = "el día de mañana se vence tu cuenta";
            } else {
               vencimientoTxt = `el día ${r.date} se venció tu cuenta`;
            }
        }
        
        const serviceName = r.textToShow || r.services?.join(', ') || 'tus servicios';
        
        await client.sendMessage(dest, `🤖 *Aviso de Cobro*\nHola ${r.name}, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que ${vencimientoTxt}.\n\nServicio(s): ${serviceName}\n\nEscribe *3* en este chat para conocer el valor a pagar y ver los medios de transferencia. ¡Gracias por preferirnos!`);
        
        // Pausa de seguridad (3s anti-spam)
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      await message.reply('🤖 He guardado los cobros y he notificado a cada número individualmente.');
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

        const streamingName = (account.Streaming || "SERVICIO").toUpperCase();
        
        // Intentar buscar el precio actualizado en el catálogo de ventas de forma robusta
        let price = parseFloat(account["Ingreso Mensual"]) || 0;
        const normalizedExcelName = streamingName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const catalogPlatform = platforms.find(p => {
          const normalizedCatalogName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normalizedCatalogName === normalizedExcelName || normalizedExcelName.includes(normalizedCatalogName) || normalizedCatalogName.includes(normalizedExcelName);
        });
        
        if (catalogPlatform && catalogPlatform.plans && catalogPlatform.plans.length > 0) {
          // Usamos el precio del primer plan como base de renovación
          const catalogPrice = catalogPlatform.plans[0].price;
          if (catalogPrice > 0) {
            price = catalogPrice;
          }
        }
        
        totalToPay += price;

        replyMessage += `\n• ${streamingName} (Vence el ${fechaVencimientoStr})`;
        if (price > 0) replyMessage += ` - $${price}`;

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

async function handleAutoCobros(message, userId, userStates, pendingConfirmations) {
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

    const uniqueRecordsMap = new Map();
    records.forEach(r => {
      if (!uniqueRecordsMap.has(r.phone)) {
        uniqueRecordsMap.set(r.phone, { name: r.name, phone: r.phone, services: [r.service], date: r.dateStr, notas: [] });
      } else {
        uniqueRecordsMap.get(r.phone).services.push(r.service);
      }
      if (r.observacion) {
        uniqueRecordsMap.get(r.phone).notas.push(r.observacion);
      }
    });
    
    const toCharge = [];
    const toReview = [];
    
    Array.from(uniqueRecordsMap.values()).forEach(r => {
      if (r.notas.length > 0) {
        toReview.push(r);
      } else {
        toCharge.push(r);
      }
    });
    
    if (toCharge.length === 0 && toReview.length === 0) {
      return;
    }

    let replyMessage = "Recibí los siguientes cargos automáticos de Azure:\n\n";

    if (toReview.length > 0) {
      replyMessage += `⚠️ *REVISIÓN MANUAL (tienen notas/saldos):*\n`;
      toReview.forEach(r => {
        replyMessage += `• ${r.name} (${r.services.join(', ')}) - Tel: ${r.phone}\n  Notas: ${r.notas.join(' | ')}\n`;
      });
      replyMessage += `(A estos clientes NO se les cobrará automáticamente)\n\n`;
    }

    if (toCharge.length > 0) {
      replyMessage += `✅ *LISTOS PARA COBRO AUTOMÁTICO:*\n`;
      const lines = toCharge.map(r => `• ${r.name} (${r.services.join(', ')}) - Fecha: ${r.date}`);
      replyMessage += lines.join('\n');
      
      const summary = toCharge.length > 1
        ? `Encontré ${toCharge.length} cuentas vencidas listas para cobrar. ¿Deseas cobrarles?`
        : `Encontré 1 cuenta vencida lista para cobrar. ¿Deseas cobrar?`;
      
      replyMessage += `\n\n${summary}\nResponde *SI* para confirmar o *NO* para cancelar.`;
      
      pendingConfirmations.set(userId, toCharge.map(r => ({ name: r.name, phone: r.phone, textToShow: `${r.name} (${r.services.join(', ')})`, date: r.date })));
      userStates.set(userId, 'awaiting_cobros_confirmation');
    } else {
      replyMessage += `🤖 Todos los cobros vencidos requieren revisión manual por sus notas. No hay ninguno para envío automático.`;
    }
    
    await message.reply(replyMessage);

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
