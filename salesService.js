const { parsePurchaseIntent, parsePlanSelection } = require('./aiService');
const { fetchRawData, getPricingRules } = require('./apiService');

const PLATFORMS_URL = 'https://sheerit.com.co/data/platforms.json';
const fs = require('fs');
const path = require('path');

function findPlatformByName(platformName, platforms) {
  if (!platformName) return null;
  let targetPlatform = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  const PLATFORM_ALIASES = {
    'amazon': 'prime video',
    'prime': 'prime video',
    'amazon prime': 'prime video',
    'amazonprime': 'prime video',
    'hbo': 'max',
    'hbomax': 'max',
    'disney': 'disney+',
    'disney premium': 'disney+',
    'star': 'disney+',
    'm365': 'microsoft 365',
    'office': 'microsoft 365'
  };

  if (PLATFORM_ALIASES[targetPlatform]) {
    targetPlatform = PLATFORM_ALIASES[targetPlatform].toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  return platforms.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlatform)) ||
    platforms.find(p => targetPlatform.includes(p.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

async function getPlatforms() {
  const localPath = path.join(__dirname, 'platforms.json');
  try {
    let platforms = [];
    const response = await fetch(PLATFORMS_URL);
    if (!response.ok) throw new Error('Failed to fetch platforms');
    platforms = await response.json();

    // Guardar copia local de respaldo actualizada asíncronamente
    fs.writeFile(localPath, JSON.stringify(platforms, null, 2), (err) => {
        if (err) console.error('[Sales Service] Error guardando respaldo de platforms.json:', err.message);
    });

    // --- POST-PROCESAMIENTO: REGLAS DE NEGOCIO PERSONALIZADAS ---
    platforms = platforms.map(p => {
        if (p.name === 'Spotify') {
            p.plans = p.plans.map(plan => {
                // El plan de 8000 es el Owner (proporcionado por nosotros)
                if (plan.price === 8000) {
                    plan.name = "Spotify Owner (Proporcionado)";
                    plan.detalles = "Plan familiar donde nosotros te entregamos el acceso de dueño. Ideal para revendedores.";
                } 
                // El plan de 10000 es el Individual (cuenta propia)
                else if (plan.price === 10000) {
                    plan.name = "Spotify Individual (Cuenta Propia)";
                    plan.detalles = "Activamos el premium directamente en tu correo personal. Privacidad total.";
                }
                return plan;
            });
        } else if (p.name === 'Microsoft 365') {
            p.name = "Microsoft Individual";
            p.price = 12000;
            const personalPlan = p.plans.find(plan => plan.name.toLowerCase().includes('personal') || plan.price === 12000);
            if (personalPlan) {
                p.plans = [personalPlan];
                p.plans[0].name = "Individual (Cuenta Propia)";
            }
        } else if (p.name === 'Microsoft 365 Compartida') {
            p.name = "Microsoft Compartida";
            p.price = 5000;
        }
        return p;
    });

    return platforms;
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

/**
 * Verifica disponibilidad de stock para Netflix Extra
 */
async function checkNetflixExtraStock() {
    try {
        const data = await fetchRawData();
        // Criterio: Filas que digan "EXTRA" y no tengan número ni Nombre ni customer mail
        const availableExtra = data.filter(d => {
            const isExtra = (d.Streaming || "").toLowerCase().includes('extra');
            const hasNoCustomer = !d.numero && !d.Nombre && (!d["customer mail"] || d["customer mail"].trim() === "" || d["customer mail"] === " ");
            return isExtra && hasNoCustomer;
        });
        return availableExtra.length > 0;
    } catch (e) {
        console.error("[Stock Check] Error:", e.message);
        return true; // Fallback optimista para no bloquear ventas si la API falla
    }
}

async function startPurchaseProcess(message, userId, userStates) {
  const platforms = await getPlatforms();
  if (platforms.length === 0) {
    await message.reply("🤖 No se pudieron cargar las plataformas. Inténtalo más tarde.");
    userStates.delete(userId);
    return;
  }
  let reply = "🌟 *¡Claro que sí! Tenemos disponibilidad inmediata para la mayoría de nuestras plataformas.* 🚀\n\nAquí tienes nuestra lista de precios actualizada:\n\n";
  platforms.forEach((p) => {
    reply += `• *${p.name}* - Desde $${p.plans[0].price}\n`;
  });

  reply += '\n🤖 *¿Qué te gustaría activar hoy?* Escribe los nombres de las plataformas (ej. Netflix, Disney+).\n\n💡 *Dato Pro:* Si pagas usando nuestro **QR de Negocios**, yo mismo valido tu pago y te entrego la cuenta en segundos. 🤖⚡';
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
    const dateStr = now.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    chatHistoryText += `[Fecha/Hora actual del sistema: ${dateStr}, ${now.toLocaleTimeString('es-CO')}]\n\nHistorial reciente:\n`;
    
    chatHistoryText += history.map(m => {
      const d = new Date(m.timestamp * 1000);
      const mDateStr = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
      const mTimeStr = d.toLocaleTimeString('es-CO');
      return `[${mDateStr}, ${mTimeStr}] ${m.fromMe ? 'Asistente' : 'Usuario'}: ${m.body || ''}`;
    }).join('\n');
    
    const currentMsgDate = new Date(message.timestamp * 1000);
    const currDateStr = currentMsgDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    const currTimeStr = currentMsgDate.toLocaleTimeString('es-CO');
    chatHistoryText += `\n[${currDateStr}, ${currTimeStr}] Usuario (Mensaje Actual): ${message.body || ''}`;
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

  items.forEach(item => {
    if (!item || !item.platform) return;
    const platform = findPlatformByName(item.platform, platforms);

    if (platform) {
      let plan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase().replace(/[^a-z0-9]/g, '');
        plan = platform.plans.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlan));
      }
      selectedItems.push({ platform, chosenPlan: plan, originalItem: item });
    } else {
      invalidElements.push(item.platform);
    }
  });

  // Verificar disponibilidad general antes de armar la respuesta
  const { getPlatformAvailability } = require('./availabilityService');
  let nonImmediatePlats = [];
  for (const s of selectedItems) {
    const planName = s.chosenPlan ? `${s.platform.name} ${s.chosenPlan.name}` : s.platform.name;
    const avail = await getPlatformAvailability(planName);
    if (!avail.immediate) {
      nonImmediatePlats.push(s.platform.name);
    }
  }

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
    // Si hay plataformas no inmediatas/sin stock, apagamos el saludo optimista de la IA
    consolidatedResponse = (empathyGreeting && nonImmediatePlats.length === 0) 
      ? `🤖 ${empathyGreeting}\n\nEntendido, buscas:\n` 
      : "🤖 Entendido, buscas:\n";
  }

  let calculatedTotal = 0;
  let plansToClarify = [];

  for (const s of selectedItems) {
    if (s.chosenPlan) {
      calculatedTotal += s.chosenPlan.price;
      consolidatedResponse += `- ${s.platform.name} (${s.chosenPlan.name}): $${s.chosenPlan.price}\n`;
    } else {
      if (s.platform.plans.length > 1) {
          plansToClarify.push(s.platform);
      } else {
          const defaultPlan = s.platform.plans[0];
          calculatedTotal += defaultPlan.price;
          s.chosenPlan = defaultPlan; 
          consolidatedResponse += `- ${s.platform.name}: $${defaultPlan.price}\n`;
      }
    }
  }

  // Si hay planes que aclarar, usamos el flujo estándar de selección de planes
  if (plansToClarify.length > 0) {
      userStates.set(userId, { 
          ...userStates.get(userId), 
          state: 'selecting_plans', 
          selected: selectedItems, 
          currentIndex: 0,
          subscriptionType: subscriptionType || 'mensual'
      });
      await showPlanSelection(message, userId, userStates);
      return;
  }

  const activeRules = await getPricingRules();

  const numPlatforms = selectedItems.length;
  const discountPerItem = numPlatforms > 1 ? ((numPlatforms - 1) * activeRules.discountPerPlatform) / numPlatforms : 0;
  
  if (numPlatforms > 1) {
    const totalComboDiscount = (numPlatforms - 1) * activeRules.discountPerPlatform;
    consolidatedResponse += `\nDescuento por combo: -$${totalComboDiscount}\n`;
  }

  let finalCalculatedTotal = 0;
  for (const s of selectedItems) {
    const tier = s.platform.discountTier || 'A';
    const tierRules = activeRules.durationDiscounts[tier] || activeRules.durationDiscounts['A'];
    const durationRule = tierRules[subscriptionType || 'mensual'] || tierRules['mensual'];
    const months = durationRule.months || 1;
    const factor = durationRule.factor || 1.0;
    
    // Ponderar el precio unitario base mensual descontando la parte proporcional del combo
    const itemMonthlyPrice = s.chosenPlan.price - discountPerItem;
    finalCalculatedTotal += (itemMonthlyPrice * months) * factor;
  }

  calculatedTotal = Math.ceil(finalCalculatedTotal / 1000) * 1000;
  
  const defaultTier = selectedItems[0]?.platform?.discountTier || 'A';
  const defaultTierRules = activeRules.durationDiscounts[defaultTier] || activeRules.durationDiscounts['A'];
  const defaultDurationRule = defaultTierRules[subscriptionType || 'mensual'] || defaultTierRules['mensual'];
  let periodText = "/mes";
  if (defaultDurationRule && defaultDurationRule.label) {
    periodText = `/${defaultDurationRule.label}`;
  }

  consolidatedResponse += `\n\n💰 *Total a transferir:* $${calculatedTotal}${periodText}`;

  if (statedPrice !== null && Math.abs(statedPrice - calculatedTotal) > 2000) {
    consolidatedResponse += `\n\n⚠️ Noté que mencionaste un precio de $${statedPrice}, pero según mis cálculos el total es $${calculatedTotal}. ¿Deseas continuar con el precio de $${calculatedTotal}?`;
  }

  if (nonImmediatePlats.length > 0) {
    const uniquePlats = [...new Set(nonImmediatePlats)];
    consolidatedResponse += `\n\n⚠️ *Nota:* Para *${uniquePlats.join(', ')}*, la entrega/activación demorará un poco más de lo habitual y no será de inmediato. ¡Agradecemos tu paciencia! 😊`;
  }

  const { getDynamicPaymentMessage } = require('./salesService');
  consolidatedResponse += getDynamicPaymentMessage(nonImmediatePlats.length > 0);

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

async function handleAwaitingPurchasePlatforms(message, userId, userStates, client, GROUP_ID, detection = null) {
  const mensaje = message.body;

  const chatHistoryText = await getChatHistoryText(message);
  const intent = await parsePurchaseIntent(mensaje, chatHistoryText);
  const { items, subscriptionType, empathyGreeting } = intent;

  // Verificar si alguno de los planes del mensaje no está disponible de inmediato
  const { getPlatformAvailability: getAvail } = require('./availabilityService');
  let hasManualPlatform = false;
  if (items && items.length > 0) {
    for (const item of items) {
      if (!item || !item.platform) continue;
      const planName = item.plan ? `${item.platform} ${item.plan}` : item.platform;
      const avail = await getAvail(planName);
      if (!avail.immediate) {
        hasManualPlatform = true;
        break;
      }
    }
  }

  if (empathyGreeting && !hasManualPlatform) {
    await message.reply(`🤖 ${empathyGreeting}`);
  }

  if (!items || items.length === 0) {
    if (detection && detection.userName) {
      const firstName = detection.userName.split(' ')[0];
      await message.reply(`🤖 ¡Hola, ${firstName}! Qué gusto saludarte. 😊\n\nCuéntame, ¿qué plataformas o servicios te interesaría adquirir hoy? (Por ejemplo: Netflix, Disney+, Prime Video).`);
      return;
    }
    await message.reply("🤖 No pude identificar las plataformas. Por favor intenta escribiendo los nombres claros, por ejemplo: Netflix, Disney.");
    return;
  }

  const platforms = await getPlatforms();
  const existing = userStates.get(userId) || {};
  let selectedItems = existing.selected || []; // Recuperamos lo que ya teníamos
  let invalidElements = [];

  const lastPlats = existing.lastClarifiedPlatforms || [];

  items.forEach(item => {
    if (!item || !item.platform) return;
    const platform = findPlatformByName(item.platform, platforms);

    if (platform) {
      let chosenPlan = null;
      if (item.plan) {
        const targetPlan = item.plan.toLowerCase().replace(/[^a-z0-9]/g, '');
        chosenPlan = platform.plans.find(p => p.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(targetPlan));
      }

      // --- MEJORA: Si la IA no detectó plan pero el usuario respondió a una aclaración ---
      if (!chosenPlan && lastPlats.some(lp => lp.toLowerCase().includes(platform.name.toLowerCase()))) {
          const lowerBody = mensaje.toLowerCase().trim();
          chosenPlan = platform.plans.find(p => 
              lowerBody.includes(p.name.toLowerCase().trim()) || 
              p.name.toLowerCase().includes(lowerBody)
          );
      }

      // Si la plataforma ya estaba en el estado anterior, la actualizamos en lugar de duplicarla
      const existingIdx = selectedItems.findIndex(si => si.platform.name === platform.name);
      if (existingIdx !== -1) {
          selectedItems[existingIdx].chosenPlan = chosenPlan || selectedItems[existingIdx].chosenPlan;
      } else {
          selectedItems.push({ platform, chosenPlan });
      }
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

  const stateData = { 
    ...existing, 
    state: 'selecting_plans', 
    selected: selectedItems, 
    currentIndex: 0, 
    subscriptionType: subscriptionType || 'mensual' 
  };
  
  // Limpiamos el contexto de aclaración ya que lo estamos procesando
  delete stateData.lastClarifiedPlatforms;
  
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
  const platform = current.platform;

  // Filtrar planes deshabilitados según platform_availability.json
  const { getAvailabilityConfig } = require('./availabilityService');
  const config = getAvailabilityConfig();
  const availablePlans = platform.plans.filter(plan => {
      const planFullName = `${platform.name} ${plan.name}`;
      const normalizedName = planFullName.toLowerCase().trim();
      let configKey = Object.keys(config).find(key => key.toLowerCase().trim() === normalizedName);
      if (!configKey) {
          configKey = Object.keys(config).find(key => {
              const k = key.toLowerCase().trim();
              return k.includes(normalizedName) || normalizedName.includes(k);
          });
      }
      return !(configKey && config[configKey].immediate === false);
  });

  if (current.chosenPlan) {
    state.currentIndex++;
    await showPlanSelection(message, userId, userStates); 
    return;
  }

  if (availablePlans.length === 1) {
    selected[currentIndex].chosenPlan = availablePlans[0];
    state.currentIndex++;
    await showPlanSelection(message, userId, userStates);
    return;
  }

  let reply = `Selecciona el plan para ${platform.name}:\n`;
  
  const { getPlatformAvailability } = require('./availabilityService');
  let warnings = [];
  for (const plan of availablePlans) {
      const planFullName = `${platform.name} ${plan.name}`;
      const avail = await getPlatformAvailability(planFullName);
      if (!avail.immediate) {
          warnings.push(plan.name);
      }
  }

  availablePlans.forEach((plan, idx) => {
      reply += `${idx + 1}. ${plan.name} - $${plan.price}\n  ${plan.characteristics.join('\n  ')}\n`;
  });
  
  if (warnings.length > 0) {
      reply += `\n⚠️ *Nota:* Para el plan *${warnings.join(', ')}*, la entrega/activación tomará un poco más de lo habitual y no será de inmediato. 😊`;
  }

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
  const platform = current.platform;

  // Filtrar planes deshabilitados según platform_availability.json
  const { getAvailabilityConfig } = require('./availabilityService');
  const config = getAvailabilityConfig();
  const availablePlans = platform.plans.filter(plan => {
      const planFullName = `${platform.name} ${plan.name}`;
      const normalizedName = planFullName.toLowerCase().trim();
      let configKey = Object.keys(config).find(key => key.toLowerCase().trim() === normalizedName);
      if (!configKey) {
          configKey = Object.keys(config).find(key => {
              const k = key.toLowerCase().trim();
              return k.includes(normalizedName) || normalizedName.includes(k);
          });
      }
      return !(configKey && config[configKey].immediate === false);
  });

  // Si el usuario pregunta de forma general por precios, planes o qué ofrecemos
  const wantsPrices = ['planes', 'costo', 'precio', 'catalogo', 'catálogo', 'que ofrecen', 'qué ofrecen', 'servicios', 'cuanto cuesta', 'cuánto cuesta', 'info'].some(k => body.includes(k));
  if (wantsPrices) {
    let reply = `🤖 ¡Claro! Para *${platform.name}* tenemos disponibles estos planes:\n\n`;
    availablePlans.forEach((plan, idx) => {
      reply += `*${idx + 1}* - ${plan.name}: **$${plan.price}**\n`;
    });
    reply += `\nRespóndeme únicamente con el **número del plan** (ej: *1*) para seleccionarlo.\n\n🌐 Si prefieres ver todo el catálogo y armar tu combo, ingresa a: https://sheerit.com.co`;
    await message.reply(reply);
    return;
  }

  let selection = parseInt(body) - 1;

  // Si no es un número directo, intentar con IA para entender la opción
  if (isNaN(selection) || selection < 0) {
    const aiSelection = await parsePlanSelection(message.body, availablePlans);
    if (aiSelection !== null) {
      selection = aiSelection - 1;
    }
  }

  if (isNaN(selection) || selection < 0 || selection >= availablePlans.length) {
    await message.reply('🤖 No te entendí. Por favor dime el número del plan (ej: 1), di su nombre o escribe "agregar" si quieres algo más.');
    return;
  }

  const chosenPlan = availablePlans[selection];
  selected[currentIndex].chosenPlan = chosenPlan;
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

  const activeRules = await getPricingRules();

  const numPlatforms = selected.length;
  const discountPerItem = numPlatforms > 1 ? ((numPlatforms - 1) * activeRules.discountPerPlatform) / numPlatforms : 0;
  
  if (numPlatforms > 1) {
    const totalComboDiscount = (numPlatforms - 1) * activeRules.discountPerPlatform;
    responseText += `\nDescuento por combo: -$${totalComboDiscount}\n`;
  }

  let finalTotalPrice = 0;
  selected.forEach(s => {
    const plan = s.chosenPlan;
    if (!plan) return;
    
    const tier = s.platform.discountTier || 'A';
    const tierRules = activeRules.durationDiscounts[tier] || activeRules.durationDiscounts['A'];
    const durationRule = tierRules[subscriptionType || 'mensual'] || tierRules['mensual'];
    const months = durationRule.months || 1;
    const factor = durationRule.factor || 1.0;
    
    // Ponderar el precio unitario base mensual descontando la parte proporcional del combo
    const itemMonthlyPrice = plan.price - discountPerItem;
    finalTotalPrice += (itemMonthlyPrice * months) * factor;
  });

  totalPrice = Math.ceil(finalTotalPrice / 1000) * 1000;
  
  const defaultTier = selected[0]?.platform?.discountTier || 'A';
  const defaultTierRules = activeRules.durationDiscounts[defaultTier] || activeRules.durationDiscounts['A'];
  const defaultDurationRule = defaultTierRules[subscriptionType || 'mensual'] || defaultTierRules['mensual'];
  let periodText = "/mes";
  if (defaultDurationRule && defaultDurationRule.label) {
    periodText = `/${defaultDurationRule.label}`;
  }

  responseText += `\nTotal (${subscriptionType}): $${totalPrice}${periodText}`;

  // Verificar disponibilidad general usando plan completo
  const { getPlatformAvailability } = require('./availabilityService');
  let nonImmediatePlats = [];
  for (const s of selected) {
    const planName = s.chosenPlan ? `${s.platform.name} ${s.chosenPlan.name}` : s.platform.name;
    const avail = await getPlatformAvailability(planName);
    if (!avail.immediate) {
      nonImmediatePlats.push(s.platform.name);
    }
  }
  if (nonImmediatePlats.length > 0) {
    const uniquePlats = [...new Set(nonImmediatePlats)];
    responseText += `\n\n⚠️ *Nota:* Para *${uniquePlats.join(', ')}*, la entrega/activación demorará un poco más de lo habitual y no será de inmediato. ¡Agradecemos tu paciencia! 😊`;
  }

  responseText += "\n\n🤖 *Aviso:* He sumado los precios estándar. Si tienes dudas sobre el total o crees que aplicas a un descuento especial, no te preocupes, puedes esperar a que un asesor humano revise tu solicitud. 😊";

  await message.reply('🤖 ' + responseText);

  const paymentOptions = "🤖 ¿Por cuál medio deseas hacer la transferencia?" + getDynamicPaymentMessage(nonImmediatePlats.length > 0).replace("\n\n🚀 *¡Listo para activar tu cuenta!*\n¿Por cuál medio deseas realizar la transferencia?", "");
  await message.reply(paymentOptions);
  const existing = userStates.get(userId);
  const stateData = typeof existing === 'object'
    ? { ...existing, state: 'awaiting_payment_method', total: totalPrice, items: selected, subscriptionType }
    : { state: 'awaiting_payment_method', total: totalPrice, items: selected, subscriptionType };
  userStates.set(userId, stateData);
}

function getDynamicPaymentMessage(hasManual = false) {
  try {
    const { getPaymentConfig } = require('./paymentConfigService');
    const config = getPaymentConfig();
    
    const isQrActive = config.qr_negocios && config.qr_negocios.enabled;
    const isLlavePrincipalActive = config.llave && config.llave.enabled && 
      (config.llave.sub_methods && config.llave.sub_methods.some(s => s.id === 'llave_bot' && s.enabled));
      
    const limitToAuto = isQrActive && isLlavePrincipalActive;
    let enabled = Object.keys(config).filter(k => config[k].enabled);
    if (limitToAuto) {
      enabled = ['qr_negocios', 'llave'];
    }
      
      let msg = "\n\n🚀 *¡Listo para activar tu cuenta!*\n¿Por cuál medio deseas realizar la transferencia?\n\n";
      
      const paymentLines = [];
      const manualLabels = [];

      enabled.forEach(k => {
        const method = config[k];
        if (method.sub_methods) {
          let activeSubs = method.sub_methods.filter(s => s.enabled);
          if (limitToAuto && k === 'llave') {
            activeSubs = activeSubs.filter(s => s.id === 'llave_bot');
          }
          activeSubs.forEach(sub => {
            const isAuto = sub.automatic !== undefined ? sub.automatic : method.automatic;
            if (isAuto && !hasManual) {
              paymentLines.push(`⭐ **${method.label} ${sub.label}** (RECOMENDADO: entrega inmediata ⚡)`);
            } else {
              paymentLines.push(`⭐ **${method.label} ${sub.label}**`);
              manualLabels.push(`${method.label} ${sub.label}`);
            }
          });
        } else {
          if (method.automatic && !hasManual) {
            paymentLines.push(`⭐ **${method.label}** (RECOMENDADO: entrega inmediata ⚡)`);
          } else {
            paymentLines.push(`⭐ **${method.label}**`);
            manualLabels.push(method.label);
          }
        }
      });

      msg += paymentLines.join('\n') + '\n';
      
      const tcClause = "\n\n📝 *Términos y Condiciones:* Al realizar tu transferencia y continuar con la compra, confirmas que aceptas nuestros *Términos y Condiciones*, nuestras *Políticas de Reembolso y Cambios* (reembolsos en 24h tras disponibilidad de agentes; cambios de plataforma acumulados como saldo a favor, sin devoluciones en efectivo si ya fue entregado) y autorizas el *Tratamiento de tus Datos Personales* (Ley 1581 de 2012 Habeas Data). Puedes consultarlos en sheerit.com.co. 🌐";
      
      if (hasManual) {
        msg += `\n💡 *Nota:* Dado que tu pedido contiene servicios que requieren activación manual o están temporalmente sin cupos automáticos, el registro y la entrega de tus credenciales serán realizados de forma **manual por un asesor** tras verificar tu pago. ¡Agradecemos tu paciencia! 😊`;
      } else if (manualLabels.length > 0) {
        msg += `\n💡 *Nota:* Si prefieres pagar por ${manualLabels.join(', ')} directo, ten en cuenta que el registro será **manual** y un asesor tendrá que verificar tu comprobante cuando esté disponible. 😊`;
      }
      return msg + tcClause;
  } catch (e) {
    console.error("Error reading payment config in salesService:", e.message);
  }
  const fallbackTc = "\n\n📝 *Términos y Condiciones:* Al realizar tu transferencia y continuar con la compra, confirmas que aceptas nuestros *Términos y Condiciones*, nuestras *Políticas de Reembolso y Cambios* (reembolsos en 24h tras disponibilidad de agentes; cambios de plataforma acumulados como saldo a favor, sin devoluciones en efectivo si ya fue entregado) y autorizas el *Tratamiento de tus Datos Personales* (Ley 1581 de 2012 Habeas Data). Puedes consultarlos en sheerit.com.co. 🌐";
  return hasManual
    ? "\n\n🚀 *¡Listo para activar tu cuenta!*\n¿Por cuál medio deseas realizar la transferencia?\n\n⭐ **Llave Bre-V**\n\n💡 *Nota:* Dado que tu pedido requiere activación manual o está sin stock automático, un asesor verificará y entregará tu cuenta de forma manual. ¡Agradecemos tu paciencia! 😊" + fallbackTc
    : "\n\n🚀 *¡Listo para activar tu cuenta!*\n¿Por cuál medio deseas realizar la transferencia?\n\n⭐ **Llave Bre-V** (RECOMENDADO: entrega inmediata ⚡)\n\n💡 *Nota:* Si prefieres pagar por Daviplata, ten en cuenta que el registro será **manual** y un asesor tendrá que verificar tu comprobante cuando esté disponible. 😊" + fallbackTc;
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
  safeFetchMessages,
  getDynamicPaymentMessage
};
