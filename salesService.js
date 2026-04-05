const { parsePurchaseIntent, parsePlanSelection } = require('./aiService');

const PLATFORMS_URL = 'https://sheerit.com.co/data/platforms.json';

async function getPlatforms() {
  try {
    const response = await fetch(PLATFORMS_URL);
    if (!response.ok) throw new Error('Failed to fetch platforms');
    return await response.json();
  } catch (error) {
    console.error('Error fetching platforms:', error);
    return [];
  }
}

async function startPurchaseProcess(message, userId, userStates) {
  const platforms = await getPlatforms();
  if (platforms.length === 0) {
    await message.reply("🤖 No se pudieron cargar las plataformas. Inténtalo más tarde.");
    userStates.delete(userId);
    return;
  }
  let reply = "Plataformas disponibles para compra:\n";
  platforms.forEach((p) => {
    reply += `• ${p.name} - Precio base: $${p.plans[0].price}\n`;
  });

  reply += '\n🤖 Responde con los nombres de las plataformas que deseas, separados por coma (ej. Netflix, Disney+).';
  await message.reply(reply);
  userStates.set(userId, 'awaiting_purchase_platforms');
}

async function getChatHistoryText(message) {
  let chatHistoryText = "";
  try {
    const chat = await message.getChat();
    const messages = await chat.fetchMessages({ limit: 6 });
    const history = messages.filter(m => m.id._serialized !== message.id._serialized).slice(-5);
    
    const now = new Date();
    chatHistoryText += `[Hora actual del sistema: ${now.toLocaleString('es-CO')}]\n\nHistorial reciente:\n`;
    
    chatHistoryText += history.map(m => {
      const timeStr = new Date(m.timestamp * 1000).toLocaleString('es-CO');
      return `[${timeStr}] ${m.fromMe ? 'Asistente' : 'Usuario'}: ${m.body}`;
    }).join('\n');
    
    const currentMsgTime = new Date(message.timestamp * 1000).toLocaleString('es-CO');
    chatHistoryText += `\n[${currentMsgTime}] Usuario (Mensaje Actual): ${message.body}`;
  } catch (err) {
    console.error("Error fetching chat history", err);
  }
  return chatHistoryText;
}

async function handleSubscriptionInterest(message, userId, userStates, client, GROUP_ID) {
  const mensaje = message.body;

  const chatHistoryText = await getChatHistoryText(message);
  const intent = await parsePurchaseIntent(mensaje, chatHistoryText);
  console.log("[DEBUG] AI Intent Result:", JSON.stringify(intent, null, 2));
  const { items, statedPrice, subscriptionType, empathyGreeting } = intent;

  if (!items || items.length === 0) {
    await message.reply("🤖 No pude entender qué servicios deseas. Por favor, intenta de nuevo especificando el nombre de la plataforma y el plan.");
    return;
  }

  const platforms = await getPlatforms();
  let selectedItems = [];
  let invalidElements = [];

  items.forEach(item => {
    const targetPlatform = item.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    const platform = platforms.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlatform)) ||
      platforms.find(p => targetPlatform.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, '')));

    if (platform) {
      let plan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase().replace(/[^a-z0-9]/g, '');
        plan = platform.plans.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlan));
      }
      selectedItems.push({ platform, plan, originalItem: item });
    } else {
      invalidElements.push(item.platform);
    }
  });

  if (invalidElements.length > 0) {
    await message.reply(`🤖 Lo siento, no manejamos las siguientes plataformas: ${invalidElements.join(', ')}.`);
    if (selectedItems.length === 0) {
      userStates.set(userId, 'waiting_human');
      await message.reply("🤖 Un asesor te contactará pronto para ver si podemos ayudarte con algo más.");
      return;
    }
    await message.reply(`🤖 Pero ¡buena noticia! Sí podemos ayudarte con el resto de tu pedido.`);
  }

  let calculatedTotal = 0;
  let responseText = empathyGreeting ? `🤖 ${empathyGreeting}\n\nEntendido, buscas:\n` : "Entendido, buscas:\n";

  for (const s of selectedItems) {
    if (s.plan) {
      calculatedTotal += s.plan.price;
      responseText += `- ${s.platform.name} (${s.plan.name}): $${s.plan.price}\n`;
    } else {
      const defaultPlan = s.platform.plans[0];
      calculatedTotal += defaultPlan.price;
      s.plan = defaultPlan; 
      responseText += `- ${s.platform.name} (${defaultPlan.name}): $${defaultPlan.price} (Plan Básico asumido)\n`;
    }
  }

  const numPlatforms = selectedItems.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    calculatedTotal -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  let periodText = "/mes";
  if (subscriptionType === 'anual') {
    calculatedTotal = calculatedTotal * 12 * 0.85;
    periodText = "/año";
  } else if (subscriptionType === 'semestral') {
    calculatedTotal = calculatedTotal * 6 * 0.93;
    periodText = "/semestre";
  }

  calculatedTotal = Math.round(calculatedTotal);
  responseText += `\nTotal calculado: $${calculatedTotal}${periodText}`;

  if (statedPrice !== null && Math.abs(statedPrice - calculatedTotal) > 2000) {
    responseText += `\n\nNoté que mencionaste un precio de $${statedPrice}, pero según mis cálculos el total es $${calculatedTotal}. ¿Deseas continuar con el precio de $${calculatedTotal}?`;
  }

  await message.reply('🤖 ' + responseText);

  userStates.set(userId, { state: 'awaiting_payment_method', total: calculatedTotal, items: selectedItems, subscriptionType: subscriptionType || 'mensual' });

  let paymentOptions = "🤖 ⭐Nequi\n⭐Llaves Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
}

async function handleAwaitingPurchasePlatforms(message, userId, userStates, client, GROUP_ID) {
  const mensaje = message.body;

  const chatHistoryText = await getChatHistoryText(message);
  const intent = await parsePurchaseIntent(mensaje, chatHistoryText);
  const { items, subscriptionType, empathyGreeting } = intent;

  if (empathyGreeting) {
    await message.reply(`🤖 ${empathyGreeting}`);
  }

  if (!items || items.length === 0) {
    await message.reply("🤖 No pude identificar las plataformas. Por favor intenta escribiendo los nombres claros, por ejemplo: Netflix, Disney.");
    return;
  }

  const platforms = await getPlatforms();
  let selectedItems = [];
  let invalidElements = [];

  items.forEach(item => {
    const targetPlatform = item.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    const platform = platforms.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlatform)) ||
      platforms.find(p => targetPlatform.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, '')));

    if (platform) {
      let chosenPlan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase().replace(/[^a-z0-9]/g, '');
        chosenPlan = platform.plans.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlan));
      }
      selectedItems.push({ platform, chosenPlan });
    } else {
      invalidElements.push(item.platform);
    }
  });

  if (invalidElements.length > 0) {
    try {
      const chat = await client.getChatById(GROUP_ID);
      if (chat) {
        await chat.sendMessage(`🚨 Plataformas no identificables: Usuario ${userId.replace('@c.us', '')} pidió: ${mensaje}. Inválidos: ${invalidElements.join(', ')}.`);
      }
    } catch (error) {}

    await message.reply(`🤖 Lo siento, de momento no manejamos: ${invalidElements.join(', ')}.`);

    if (selectedItems.length === 0) {
      await message.reply("🤖 Enviaré tu caso a un asesor para que te ayude personalmente.");
      userStates.set(userId, 'waiting_human');
      return;
    }

    await message.reply(`🤖 Sigamos adelante con las plataformas que sí tenemos disponibles.`);
  }

  userStates.set(userId, { state: 'selecting_plans', selected: selectedItems, currentIndex: 0, subscriptionType: subscriptionType || 'mensual' });
  await showPlanSelection(message, userId, userStates);
}

async function showPlanSelection(message, userId, userStates) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'selecting_plans') return;

  const { selected, currentIndex } = state;

  if (currentIndex >= selected.length) {
    await calculateAndShowPrice(message, userId, userStates);
    return;
  }

  const current = selected[currentIndex];
  if (current.chosenPlan) {
    state.currentIndex++;
    await showPlanSelection(message, userId, userStates); 
    return;
  }

  const platform = current.platform;

  if (platform.plans.length === 1) {
    selected[currentIndex].chosenPlan = platform.plans[0];
    state.currentIndex++;
    await showPlanSelection(message, userId, userStates);
    return;
  }

  let reply = `Selecciona el plan para ${platform.name}:\n`;
  platform.plans.forEach((plan, idx) => {
    reply += `${idx + 1}. ${plan.name} - $${plan.price}\n  ${plan.characteristics.join('\n  ')}\n`;
  });
  reply += `\n🤖 Responde con el número del plan, o 'agregar' para añadir otra plataforma.`;

  await message.reply(reply);
}

async function handleSelectingPlans(message, userId, userStates) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'selecting_plans') return;

  const { selected, currentIndex } = state;
  const body = message.body.trim().toLowerCase();

  if (body === 'agregar') {
    userStates.set(userId, { state: 'adding_platform', selected, subscriptionType: state.subscriptionType, returnIndex: currentIndex });
    await showAvailablePlatforms(message, userId, userStates);
    return;
  }

  const current = selected[currentIndex];
  let selection = parseInt(body) - 1;

  // Si no es un número directo, intentar con IA para entender la opción
  if (isNaN(selection) || selection < 0) {
    const aiSelection = await parsePlanSelection(message.body, current.platform.plans);
    if (aiSelection !== null) {
      selection = aiSelection - 1;
    }
  }

  if (isNaN(selection) || selection < 0 || selection >= current.platform.plans.length) {
    await message.reply('🤖 No te entendí. Por favor dime el número del plan (ej: 1), di su nombre o escribe "agregar" si quieres algo más.');
    return;
  }

  selected[currentIndex].chosenPlan = current.platform.plans[selection];
  state.currentIndex++;

  if (state.currentIndex >= selected.length) {
    await calculateAndShowPrice(message, userId, userStates);
  } else {
    await showPlanSelection(message, userId, userStates);
  }
}

async function showAvailablePlatforms(message, userId, userStates) {
  const platforms = await getPlatforms();
  const state = userStates.get(userId);
  const selectedIds = state.selected.map(s => s.platform.id);
  const available = platforms.filter(p => !selectedIds.includes(p.id));

  if (available.length === 0) {
    await message.reply('🤖 No hay más plataformas disponibles para agregar.');
    const nextIndex = state.returnIndex !== undefined ? state.returnIndex : state.selected.length - 1;
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
    await showPlanSelection(message, userId, userStates);
    return;
  }

  let reply = 'Plataformas disponibles para agregar:\n';
  available.forEach((p) => {
    reply += `• ${p.name}\n`;
  });
  reply += '\n🤖 Responde con el nombre de la plataforma para agregar, o "volver" para continuar con la selección actual.';

  await message.reply(reply);
}

async function handleAddingPlatform(message, userId, userStates) {
  const state = userStates.get(userId);
  if (!state || state.state !== 'adding_platform') return;

  const body = message.body.trim().toLowerCase();

  if (body === 'volver') {
    const nextIndex = state.returnIndex !== undefined ? state.returnIndex : 0;
    userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
    await showPlanSelection(message, userId, userStates);
    return;
  }

  const platforms = await getPlatforms();
  const selectedIds = state.selected.map(s => s.platform.id);
  const available = platforms.filter(p => !selectedIds.includes(p.id));

  const selection = parseInt(body) - 1;

  if (isNaN(selection) || selection < 0 || selection >= available.length) {
    await message.reply('🤖 Selección inválida. Responde con el número o "volver".');
    return;
  }

  state.selected.push({ platform: available[selection], chosenPlan: null });

  const nextIndex = state.returnIndex !== undefined ? state.returnIndex : state.selected.length - 1;
  userStates.set(userId, { state: 'selecting_plans', selected: state.selected, currentIndex: nextIndex, subscriptionType: state.subscriptionType });
  await showPlanSelection(message, userId, userStates);
}

async function calculateAndShowPrice(message, userId, userStates) {
  const state = userStates.get(userId);
  const selected = state.selected;
  const subscriptionType = state.subscriptionType || 'mensual'; 

  let totalPrice = 0;
  let responseText = 'Has seleccionado:\n';
  let hasErrors = false;

  selected.forEach(s => {
    const plan = s.chosenPlan;
    if (!plan) {
      hasErrors = true;
      return;
    }
    totalPrice += plan.price;
    responseText += `- ${s.platform.name} (${plan.name}): $${plan.price}\n`;
  });

  if (hasErrors) {
    const firstMissingIndex = selected.findIndex(s => !s.chosenPlan);
    if (firstMissingIndex !== -1) {
      userStates.set(userId, { state: 'selecting_plans', selected: selected, currentIndex: firstMissingIndex, subscriptionType });
      await showPlanSelection(message, userId, userStates);
      return;
    }
  }

  const numPlatforms = selected.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    totalPrice -= discount;
    responseText += `\nDescuento por combo: -$${discount}\n`;
  }

  let periodText = "/mes";
  if (subscriptionType === 'anual') {
    totalPrice = totalPrice * 12 * 0.85;
    periodText = "/año";
  } else if (subscriptionType === 'semestral') {
    totalPrice = totalPrice * 6 * 0.93;
    periodText = "/semestre";
  }

  responseText += `\nTotal (${subscriptionType}): $${totalPrice}${periodText}`;

  responseText += "\n\n🤖 *Aviso:* He sumado los precios estándar. Si tienes dudas sobre el total o crees que aplicas a un descuento especial, no te preocupes, puedes esperar a que un asesor humano revise tu solicitud. 😊";

  await message.reply('🤖 ' + responseText);

  let paymentOptions = "🤖 ⭐Nequi\n⭐Llave Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?";
  await message.reply(paymentOptions);
  userStates.set(userId, { state: 'awaiting_payment_method', total: totalPrice, items: selected, subscriptionType });
}

module.exports = {
  getPlatforms,
  startPurchaseProcess,
  handleSubscriptionInterest,
  handleAwaitingPurchasePlatforms,
  showPlanSelection,
  handleSelectingPlans,
  showAvailablePlatforms,
  handleAddingPlatform,
  calculateAndShowPrice,
  getChatHistoryText
};
