const fs = require('fs');
const path = require('path');
const { getAccountsByPhone, getTodayInBogota, getJsDateFromExcel } = require('./apiService');

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

async function processCheckPrices(message, userId, userStates, preferredMethod = null, platformFilter = null) {
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
    const allUserAccounts = await getAccountsByPhone(phoneNumber);
    const platforms = await getPlatforms();

    // Filtrar por plataforma si se especificó una (ej: "solo quiero pagar Disney")
    let userAccounts = allUserAccounts;
    if (platformFilter) {
        const filterLower = platformFilter.toLowerCase();
        userAccounts = allUserAccounts.filter(acc => {
            const accName = (acc.Streaming || "").toLowerCase();
            return accName.includes(filterLower) || filterLower.includes(accName);
        });
        
        // Si no encontramos nada con el filtro, volvemos a la lista completa por seguridad
        if (userAccounts.length === 0) {
            userAccounts = allUserAccounts;
            platformFilter = null;
        }
    }

    // Mapa de alias para normalizar nombres del Excel al catálogo
    const PLATFORM_ALIASES = {
      'amazon': 'prime video',
      'prime': 'prime video',
      'hbo': 'hbomax',
      'hbomax': 'hbomax',
      'max': 'hbomax',
      'hbo platino': 'hbomax',
      'hboplatino': 'hbomax',
      'disney': 'disney+',
      'star': 'disney+',
      'm365': 'microsoft 365',
      'office': 'microsoft 365'
    };

    if (userAccounts.length > 0) {
      let replyMessage = platformFilter 
        ? `Tus cuentas de *${platformFilter.toUpperCase()}* para renovar o pagar son:\n`
        : "Tus cuentas actuales para renovar o pagar son:\n";
      let totalToPay = 0;
      let dateGroups = new Map();

      for (const account of userAccounts) {
        let fechaVencimientoObj = null;
        let fechaVencimientoStr = "Fecha desconocida";
        
        if (account.deben) {
            fechaVencimientoObj = getJsDateFromExcel(account.deben);
            if (!fechaVencimientoObj) {
                fechaVencimientoStr = "Fecha desconocida";
            } else {
                const today = getTodayInBogota();
                const diffTime = fechaVencimientoObj - today;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            
            if (diffDays === 0) {
                fechaVencimientoStr = "¡HOY!";
            } else if (diffDays === 1) {
                fechaVencimientoStr = "MAÑANA";
            } else {
                fechaVencimientoStr = fechaVencimientoObj.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
            }
          }
        } else if (account.vencimiento) {
            fechaVencimientoStr = account.vencimiento;
        }


        const rawStreamingName = (account.Streaming || "SERVICIO").toUpperCase();
        const streamingName = rawStreamingName;
        
        // 1. Intentar precio del Excel como base
        let price = parseFloat(account["Ingreso Mensual"]) || 0;
        
        // 2. Normalizar nombre y buscar en catálogo
        const normalizedFullName = rawStreamingName.toLowerCase().replace(/[^a-z0-9]/g, '');
        let searchName = normalizedFullName;
        
        // Aplicar alias si existe
        if (PLATFORM_ALIASES[searchName]) {
          searchName = PLATFORM_ALIASES[searchName].toLowerCase().replace(/[^a-z0-9]/g, '');
        } else {
          // Búsqueda parcial de alias (ej: si dice "HBO PLATINO" y tenemos alias "hbo")
          for (const aliasKey in PLATFORM_ALIASES) {
            if (normalizedFullName.includes(aliasKey)) {
              searchName = PLATFORM_ALIASES[aliasKey].toLowerCase().replace(/[^a-z0-9]/g, '');
              break;
            }
          }
        }

        let catalogPlatform = platforms.find(p => {
          const normalizedCatalogName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return normalizedCatalogName === searchName || searchName.includes(normalizedCatalogName) || normalizedCatalogName.includes(searchName);
        });
        


        if (catalogPlatform && catalogPlatform.plans && catalogPlatform.plans.length > 0) {
          // El catálogo manda sobre el precio manual si el catálogo tiene precio válido
          // Intentar encontrar el plan específico que coincida con lo que dice el Excel
          const specificPlan = catalogPlatform.plans.find(pl => {
              const normPlanName = pl.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              // Match con el nombre completo original (ej: "platino" en "hboplatino")
              return normalizedFullName.includes(normPlanName) || normPlanName.includes(normalizedFullName);
          });
          
          // Si es Netflix y el Excel dice Extra, pero no encontramos plan específico, 
          // evitamos asignar el precio base de 13000 si podemos encontrar el de 17000
          let catalogPrice = 0;
          if (specificPlan) {
              catalogPrice = specificPlan.price;
          } else if (searchName.includes('extra')) {
              const extraPlan = catalogPlatform.plans.find(pl => pl.name.toLowerCase().includes('extra'));
              if (extraPlan) catalogPrice = extraPlan.price;
          }
          
          // Fallback al primer plan (base) si no encontramos uno específico
          if (catalogPrice === 0) {
              // REGLA INTELIGENTE: Si el precio del Excel ya coincide con alguno de los precios del catálogo,
              // respetamos ese precio en lugar de forzar el primer plan.
              const matchesAnyPlanPrice = catalogPlatform.plans.some(pl => pl.price === price);
              
              if (matchesAnyPlanPrice && price > 0) {
                  catalogPrice = price;
              } else if (!searchName.includes('extra')) {
                  // Solo si no coincide con nada y no es un "Extra" (que tiene lógica propia), 
                  // tomamos el primer plan como base.
                  catalogPrice = catalogPlatform.plans[0].price;
              }
          }

          // REGLA ESPECIAL SPOTIFY: Respetar precio del Excel si es mayor al del catálogo (ej: 9000 vs 8000)
          if (searchName.includes('spotify') && !normalizedFullName.includes('owner') && price > catalogPrice) {
              // Mantener el precio del Excel
          } else if (catalogPrice > 0) {
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

      const existing = userStates.get(userId);
      const stateData = { 
        ...((typeof existing === 'object') ? existing : {}), 
        state: 'awaiting_payment_method', 
        total: totalToPay > 0 ? totalToPay : null, 
        isRenewal: true, 
        items: userAccounts 
      };
      userStates.set(userId, stateData);

      // Si el usuario ya mencionó un método (ej: "Renovar por Nequi")
      if (preferredMethod) {
          await message.reply(replyMessage);
          // Importante: Requerimos index.js o inyectamos la función para procesar la selección
          // Pero para evitar circulares, simplemente llamamos a una versión local de los detalles
          const details = {
            'nequi': "3118587974",
            'daviplata': "3107946794",
            'bancolombia': "46772753713\nBancolombia - ahorros\nNumero de cuenta: 46772753713\nCC1032936324",
            'banco caja social': "24111572331\nESTEBAN AVILA\ncc: 1032936324",
            'transfiya': "*LLAVE*\n3118587974",
            'llaves bre-v': "*LLAVE*\n3118587974",
            'llave bre-b': "*LLAVE*\n3118587974"
          };
          
          const methodKey = preferredMethod.toLowerCase();
          const foundKey = Object.keys(details).find(k => methodKey.includes(k) || k.includes(methodKey));
          if (foundKey) {
              await message.reply(`🤖 Entendido, aquí tienes los datos para *${preferredMethod.toUpperCase()}*:\n\n${details[methodKey]}\n\nUna vez realices la transferencia, por favor envíame el comprobante por aquí.`);
              userStates.set(userId, { ...stateData, state: 'awaiting_payment_confirmation', paymentMethod: preferredMethod });
          } else {
              await message.reply("\n\n¿Por cuál medio deseas hacer la transferencia para tu renovación?\n⭐Nequi | ⭐Daviplata | ⭐Bancolombia | ⭐QR Negocios");
          }
      } else {
          replyMessage += "\n\n¿Por cuál medio deseas hacer la transferencia para tu renovación?\n⭐Nequi | ⭐Daviplata | ⭐Bancolombia | ⭐QR Negocios";
          await message.reply(replyMessage);
      }
    } else {
      const stateData = userStates.get(userId) || {};
      if (stateData.items && stateData.items.length > 0) {
          // Si está comprando algo nuevo, no mostramos error de "no hay cuentas", simplemente lo guiamos al pago.
          await message.reply(`🤖 ¡Perfecto! Veo que estás por completar tu primera compra.\n\n¿Por cuál medio deseas hacer la transferencia?\n⭐Nequi | ⭐Daviplata | ⭐Bancolombia | ⭐QR Negocios`);
          userStates.set(userId, { ...stateData, state: 'awaiting_payment_method' });
      } else {
          await message.reply(`🤖 No encontramos cuentas pendientes o asociadas al número ${phoneNumber}. Si crees que hay un error, contacta a un asesor. 😊`);
          userStates.delete(userId);
      }
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
    
    const today = getTodayInBogota();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    
    let records = [];
    
    clientes.forEach(account => {
      let isTargetDate = false;
      let accountDate = null;
      
      accountDate = getJsDateFromExcel(account.deben);
      if (accountDate) {

        
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
        
        const destId = phone + '@c.us';
        const currentState = userStates.get(destId);
        const stateStr = (typeof currentState === 'object') ? currentState.state : currentState;

        const observacion = (account.observaciones || '').toString().trim();
        let dateStr = accountDate ? accountDate.toLocaleDateString('es-ES') : '';
        if (accountDate && accountDate.getTime() === tomorrow.getTime()) {
            dateStr = "MAÑANA";
        }

        // --- FILTRO DE SEGURIDAD ---
        // Si ya envió comprobante o está en charla, lo mandamos a revisión especial
        if (stateStr === 'waiting_admin_confirmation' || stateStr === 'waiting_human') {
          records.push({ 
            name: account.Nombre || 'Cliente', 
            phone, 
            service: account.Streaming || 'Servicio',
            dateStr,
            observacion: `[PENDIENTE] Ya hay actividad o pago en este chat (${stateStr}).`,
            isSkip: true
          });
          return;
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
    const toNotifyAdminUsers = new Map();
    
    records.forEach(r => {
      if (r.isSkip) {
        if (!toNotifyAdminUsers.has(r.phone)) {
            toNotifyAdminUsers.set(r.phone, { name: r.name, phone: r.phone, services: [] });
        }
        toNotifyAdminUsers.get(r.phone).services.push(r.service);
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

    if (toCharge.length === 0 && toReview.length === 0 && toNotify.length === 0) {
      await message.reply('🤖 No se encontraron cobros, revisiones ni pagos pendientes para procesar.');
      return;
    }

    // AVISAR QUE INICIAMOS
    await message.reply(`🤖 *PROCESO AUTOMÁTICO DE COBROS INICIADO*\n\nHe encontrado ${toCharge.length} clientes para cobrar, ${toReview.length} para revisión de corte y ${toNotify.length} con pagos/actividad pendiente. Procedo con el envío...`);

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

    if (toNotify.length > 0) {
      finalReport += `\n📥 *PAGOS/CHATS POR VALIDAR (Bot saltó el cobro):*\n`;
      toNotify.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone} (${r.services.join(', ')})\n`;
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
