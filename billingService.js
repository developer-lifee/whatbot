const fs = require('fs');
const path = require('path');
const { getAccountsByPhone } = require('./apiService');

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
        await client.sendMessage(dest, `Se enviará un cobro para *${r.name}* solicitado por ${userId}. Por favor, responde si el pago fue realizado.`);
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
    const phoneNumber = userId.replace('@c.us', '').replace(/\D/g, ''); 
    const userAccounts = await getAccountsByPhone(phoneNumber);

    if (userAccounts.length > 0) {
      let replyMessage = "Tus cuentas actuales para renovar o pagar son:\n";
      let totalToPay = 0;

      for (const account of userAccounts) {
        let fechaVencimiento = "Fecha desconocida";
        if (account.deben && !isNaN(parseFloat(account.deben))) {
            const excelDate = parseFloat(account.deben);
            const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
            fechaVencimiento = jsDate.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
        } else if (account.vencimiento) {
            fechaVencimiento = account.vencimiento;
        }

        const streamingName = (account.Streaming || "SERVICIO").toUpperCase();
        const price = parseFloat(account["Ingreso Mensual"]) || 0;
        totalToPay += price;

        replyMessage += `\n• ${streamingName} (Vence el ${fechaVencimiento})`;
        if (price > 0) replyMessage += ` - $${price}`;
      }
      
      if (totalToPay > 0) {
        replyMessage += `\n\nTotal estimado: $${totalToPay}`;
      }

      replyMessage += "\n\n🤖 ¿Por cuál medio deseas hacer la transferencia para tu renovación?\n⭐Nequi\n⭐Llaves Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia";
      
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

module.exports = {
  handleCobrosParser,
  handleAwaitingCobrosConfirmation,
  processCheckPrices
};
