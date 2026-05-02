const { parsePurchaseIntent, parsePlanSelection } = require('./aiService');

const PLATFORMS_URL = 'https://sheerit.com.co/data/platforms.json';
const fs = require('fs');
const path = require('path');

async function getPlatforms() {
  const localPath = path.join(__dirname, 'platforms.json');
  try {
    const response = await fetch(PLATFORMS_URL);
    if (!response.ok) throw new Error('Failed to fetch platforms');
    return await response.json();
  } catch (error) {
    console.warn('[Sales Service] No se pudo obtener plataformas remotas, intentando local...');
    try {
        if (fs.existsSync(localPath)) {
            const localData = fs.readFileSync(localPath, 'utf8');
            return JSON.parse(localData);
        }
    } catch (localError) {
        console.error('[Sales Service] Error crítico cargando plataformas locales:', localError.message);
    }
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
  const existing = userStates.get(userId);
  const stateData = typeof existing === 'object' ? { ...existing, state: 'awaiting_purchase_platforms' } : { state: 'awaiting_purchase_platforms' };
  userStates.set(userId, stateData);
}

/**
 * Obtiene el historial de mensajes formateado para la IA.
 * @param {Message} message - El mensaje actual.
 * @param {number} limit - Cantidad de mensajes a recuperar.
 * @returns {Promise<string>}
 */
async function getChatHistoryText(message, limit = 6) {
  let chatHistoryText = "";
  try {
    if (!message) return "";
    const chat = await message.getChat().catch(() => null);
    if (!chat) return "";

    let messages = [];
    
    // Evitar fetchMessages en ciertos casos problemáticos
    const fromId = (message.from || "");
    if (!fromId.includes('status@broadcast')) {
        messages = await safeFetchMessages(chat, limit);
    }
    
    // Filtramos el mensaje actual para que no aparezca duplicado en el historial previo
    const history = (messages || []).filter(m => {
        if (!m || !m.id || !message || !message.id) return false;
        return m.id._serialized !== message.id._serialized;
    });
    
    const now = new Date();
    chatHistoryText += `[Hora actual del sistema: ${now.toLocaleString('es-CO')}]\n\nHistorial reciente:\n`;
    
    chatHistoryText += history.map(m => {
      const timeStr = new Date(m.timestamp * 1000).toLocaleString('es-CO');
      return `[${timeStr}] ${m.fromMe ? 'Asistente' : 'Usuario'}: ${m.body || ''}`;
    }).join('\n');
    
    const currentMsgTime = new Date(message.timestamp * 1000).toLocaleString('es-CO');
    chatHistoryText += `\n[${currentMsgTime}] Usuario (Mensaje Actual): ${message.body || ''}`;
  } catch (err) {
    console.error("Error fetching chat history", err.message);
  }
  return chatHistoryText;
}

/**
 * Encapsula fetchMessages con manejo de errores para evitar crasheos por waitForChatLoading.
 */
async function safeFetchMessages(chat, limit) {
    try {
        if (!chat) return [];
        return await chat.fetchMessages({ limit });
    } catch (err) {
        if (err.message.includes('waitForChatLoading') || err.message.includes('undefined')) {
            // Error silencioso esperado en ráfagas o chats pesados
            return [];
        }
        console.error(`[SAFE FETCH] Error en ${chat.id._serialized}:`, err.message);
        return [];
    }
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

  items.forEach(item => {
    if (!item || !item.platform) return;
    let targetPlatform = item.platform.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Aplicar alias
    if (PLATFORM_ALIASES[targetPlatform]) {
      targetPlatform = PLATFORM_ALIASES[targetPlatform].toLowerCase().replace(/[^a-z0-9]/g, '');
    }

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

  let consolidatedResponse = "";

  if (invalidElements.length > 0) {
    consolidatedResponse += `🤖 Lo siento, de momento no manejamos: ${invalidElements.join(', ')}.\n`;
    if (selectedItems.length === 0) {
      consolidatedResponse += `\nPero no te preocupes, un asesor humano te contactará pronto para ver si podemos ayudarte con algo más o conseguirte esa cuenta. 😊`;
      await message.reply(consolidatedResponse);
      userStates.set(userId, { state: 'waiting_human', waitingCount: 1 });
      return;
    }
    consolidatedResponse += `\nPero ¡buena noticia! Sí podemos ayudarte con el resto de tu pedido:\n\n`;
  } else {
    consolidatedResponse = empathyGreeting ? `🤖 ${empathyGreeting}\n\nEntendido, buscas:\n` : "🤖 Entendido, buscas:\n";
  }

  let calculatedTotal = 0;
  let plansToClarify = [];

  for (const s of selectedItems) {
    if (s.plan) {
      calculatedTotal += s.plan.price;
      consolidatedResponse += `- ${s.platform.name} (${s.plan.name}): $${s.plan.price}\n`;
    } else {
      if (s.platform.plans.length > 1) {
          plansToClarify.push(s.platform);
      } else {
          const defaultPlan = s.platform.plans[0];
          calculatedTotal += defaultPlan.price;
          s.plan = defaultPlan; 
          consolidatedResponse += `- ${s.platform.name}: $${defaultPlan.price}\n`;
      }
    }
  }

  // Si hay planes que aclarar, interrumpimos el flujo de pago para preguntar
  if (plansToClarify.length > 0) {
      let clarificationMsg = "🤖 ¡Excelente elección! Pero antes de continuar, cuéntame qué plan prefieres para estas plataformas:\n\n";
      plansToClarify.forEach(p => {
          clarificationMsg += `*${p.name}:*\n`;
          p.plans.forEach(plan => {
              clarificationMsg += `- ${plan.name}: $${plan.price}\n`;
          });
          clarificationMsg += "\n";
      });
      clarificationMsg += "¿Cuál de estos te gustaría activar? 😊";
      await message.reply(clarificationMsg);
      
      // Mantenemos el estado de búsqueda pero sin pasar a pago aún
      userStates.set(userId, { ...userStates.get(userId), state: 'awaiting_purchase_platforms' });
      return;
  }

  const numPlatforms = selectedItems.length;
  if (numPlatforms > 1) {
    const discount = (numPlatforms - 1) * 1000;
    calculatedTotal -= discount;
    consolidatedResponse += `\nDescuento por combo: -$${discount}\n`;
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
  consolidatedResponse += `\nTotal calculado: $${calculatedTotal}${periodText}`;

  if (statedPrice !== null && Math.abs(statedPrice - calculatedTotal) > 2000) {
    consolidatedResponse += `\n\nNoté que mencionaste un precio de $${statedPrice}, pero según mis cálculos el total es $${calculatedTotal}. ¿Deseas continuar con el precio de $${calculatedTotal}?`;
  }

  consolidatedResponse += "\n\n¿Por cuál medio deseas hacer la transferencia?\n⭐Nequi | ⭐Daviplata | ⭐Bancolombia | ⭐QR Negocios";

  await message.reply(consolidatedResponse);

  const existing = userStates.get(userId);
  let finalTotal = calculatedTotal;
  let finalItems = selectedItems;
  
  if (existing && existing.items && existing.isRenewal) {
      finalTotal += (existing.total || 0);
      finalItems = [...existing.items, ...selectedItems];
      consolidatedResponse = consolidatedResponse.replace(`Total calculado: $${calculatedTotal}${periodText}`, `Total con renovación pendiente: $${finalTotal} COP`);
  }

  const stateData = typeof existing === 'object' 
    ? { ...existing, state: 'awaiting_payment_method', total: finalTotal, items: finalItems, subscriptionType: subscriptionType || 'mensual' }
    : { state: 'awaiting_payment_method', total: finalTotal, items: finalItems, subscriptionType: subscriptionType || 'mensual' };
  userStates.set(userId, stateData);
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
    if (!item || !item.platform) return;
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

  const existing = userStates.get(userId);
  const stateData = typeof existing === 'object'
    ? { ...existing, state: 'selecting_plans', selected: selectedItems, currentIndex: 0, subscriptionType: subscriptionType || 'mensual' }
    : { state: 'selecting_plans', selected: selectedItems, currentIndex: 0, subscriptionType: subscriptionType || 'mensual' };
  userStates.set(userId, stateData);
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
    const existing = userStates.get(userId);
    const stateData = typeof existing === 'object'
      ? { ...existing, state: 'adding_platform', selected, subscriptionType: state.subscriptionType, returnIndex: currentIndex }
      : { state: 'adding_platform', selected, subscriptionType: state.subscriptionType, returnIndex: currentIndex };
    userStates.set(userId, stateData);
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

  let paymentOptions = "🤖 ⭐Nequi\n⭐Llave Bre-B\n⭐Daviplata\n⭐Banco caja social\n⭐Bancolombia\n\n¿Por cuál medio deseas hacer la transferencia?\n\n💡 *Tip:* Si deseas pagar por *QR*, dímelo y te enviaré la imagen o los datos para que sea más fácil.";
  await message.reply(paymentOptions);
  const existing = userStates.get(userId);
  const stateData = typeof existing === 'object'
    ? { ...existing, state: 'awaiting_payment_method', total: totalPrice, items: selected, subscriptionType }
    : { state: 'awaiting_payment_method', total: totalPrice, items: selected, subscriptionType };
  userStates.set(userId, stateData);
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
  getChatHistoryText,
  safeFetchMessages
};
