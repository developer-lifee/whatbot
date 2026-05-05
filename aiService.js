const { getJsDateFromExcel, getTodayInBogota, getPlatformKnowledge } = require('./apiService');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// List of models to try in order. Prioritizes flash models for higher quota.
const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
  "gemini-2.5-pro"
];

/**
 * Detecta la intención de un administrador basándose en sus facultades.
 */
async function detectAdminIntent(messageContent) {
  const prompt = `
    Eres el asistente personal del JEFE de la plataforma Sheerit. 
    Tu tarea es identificar qué acción administrativa quiere realizar el jefe basándose en su mensaje: "${messageContent}"

    FACULTADES DEL JEFE:
    - "confirmar_pago": El jefe quiere validar el pago de un cliente. Busca si menciona un número de teléfono o nombre.
    - "confirm_action": El jefe confirma una acción pendiente (menciona "sí", "si", "dale", "proceder", "confirmar", "hazlo").
    - "liberar_bot": El jefe quiere que el bot vuelva a atender a un cliente que estaba silenciado (menciona "liberar", "atiende", "vuelve", "contesta").
    - "dame_cuenta": El jefe quiere que le des las credenciales de una plataforma para él mismo (menciona "dame una de", "pásame", "pasa cuenta"). NO confundir con envíos masivos (broadcast).
    - "dormir_bot": El jefe quiere apagar las respuestas automáticas globales ("duérmete", "apágate").
    - "despertar_bot": El jefe quiere reactivar el bot globalmente ("despiértate", "actívate").
    - "desconocido": Consultas de datos, reportes, envíos masivos (broadcast), o charla casual.
 
    Salida esperada JSON:
    {
      "intent": "confirmar_pago" | "confirm_action" | "liberar_bot" | "dame_cuenta" | "dormir_bot" | "despertar_bot" | "desconocido",
      "target_platform": string | null, // Ej: "Netflix", "HBO"
      "target_user": string | null, // Ej: "57304...", "Estefania Arias"
      "months": number | null // Si menciona duración para una confirmación
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un analista de comandos administrativos. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    return { intent: "desconocido", target: null, months: null };
  }
}

/**
 * Convierte el JSON de plataformas (con planes y detalles) en un resumen de texto para el prompt.
 */
function summarizePlatformKnowledge(platforms) {
  if (!platforms || platforms.length === 0) return "No hay documentación detallada disponible.";
  return platforms.map(p => {
    let text = `PLATAFORMA: ${p.name}\n`;
    if (p.plans && p.plans.length > 0) {
      p.plans.forEach(plan => {
        text += `- Plan ${plan.name}: $${plan.price}. `;
        if (plan.detalles) text += `Info: ${plan.detalles} `;
        if (plan.characteristics && plan.characteristics.length > 0) {
          text += `Características: ${plan.characteristics.join(', ')}`;
        }
        text += '\n';
      });
    } else {
      text += `- Precio base: $${p.price}\n`;
    }
    return text;
  }).join('\n---\n');
}

/**
 * Call Gemini API with a given prompt and system instruction.
 * Implements a fallback mechanism rotating through available models in case of 429 Quota Exceeded.
 * @param {string} prompt 
 * @param {string} systemInstruction 
 * @param {boolean} isJson
 * @param {object|null} mediaData { data: 'base64', mimeType: 'image/jpeg' }
 * @returns {Promise<string>}
 */
async function callGemini(prompt, systemInstruction = "Eres un asistente de soporte y ventas amable y profesional de Sheerit, un servicio de cuentas de streaming. Tu tono es servicial, claro y directo. Siempre buscas ayudar al cliente a completar su compra o resolver su duda.", isJson = true, mediaData = null) {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing in .env");
    throw new Error("GEMINI_API_KEY not configured");
  }

  const parts = [{ text: prompt }];
  
  if (mediaData) {
    const mediaArray = Array.isArray(mediaData) ? mediaData : [mediaData];
    mediaArray.forEach(m => {
      if (m.data && m.mimeType) {
        parts.push({
          inlineData: {
            data: m.data,
            mimeType: m.mimeType
          }
        });
      }
    });
  }

  const payload = {
    contents: [{
      role: 'user',
      parts: parts
    }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    }
  };

  if (isJson) {
    payload.generationConfig = {
      responseMimeType: "application/json"
    };
  }

  for (const modelName of MODELS) {
    const startTime = Date.now();
    try {
      // console.log(`Attempting with model: ${modelName}...`);
      const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

      const response = await fetch(`${API_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.status === 404) {
        console.warn(`⚠️ Model ${modelName} not found (404). Check API availability. Trying next...`);
        continue;
      }

      if (response.status === 429) {
        console.warn(`⚠️ Quota exceeded for ${modelName} (429). Rotating to next model...`);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error (${modelName}): ${response.status} ${response.statusText} - ${errText}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        return isJson ? "{}" : "";
      }

      return text;

    } catch (error) {
      console.error(`Error with ${modelName}:`, error.message);
      // If it's the last model, we re-throw to be caught by the caller
      if (modelName === MODELS[MODELS.length - 1]) {
        throw error;
      }
    }
  }

  // If we reach here, it means all models were skipped (e.g. all 404 or 429)
  throw new Error("All fallback models were unavailable or exceeded quota.");
}

/**
 * Parses a user's purchase intent using Gemini.
 * @param {string} messageContent The user's message.
 * @returns {Promise<{items: Array, statedPrice: number|null, subscriptionType: string}>}
 */
async function parsePurchaseIntent(messageContent, chatHistory = "") {
  const prompt = `
    Analiza el siguiente mensaje de un usuario interesado en servicios de streaming y extrae la información en formato JSON.
    Contexto de la conversación anterior (úsalo para entender mejor a qué se refiere el usuario): 
    ${chatHistory}

    El mensaje principal es: "${messageContent}"

    Salida esperada JSON:
    {
      "items": [
        { "platform": "NombrePlataforma", "plan": "NombrePlan" }
      ],
      "statedPrice": number | null, // Si el usuario menciona un precio total, inclúyelo (solo números).
      "subscriptionType": "mensual" | "semestral" | "anual", // "mensual" por defecto.
      "empathyGreeting": string | null // Un saludo empático si hubo mucha demora en responder.
    }
    
    Reglas:
    - **REGLA DE ORO:** NO inventes productos. Si el usuario solo dice "Hola", "Buenas", o mensajes de saludo, "items" debe ser [].
    - **RELEVANCIA TEMPORAL:** Analiza las fechas y horas en el [Historial reciente]. Si hubo un pedido hace mucho tiempo (ej: más de 24 horas) y el usuario hoy solo envía un saludo inicial, usa el sentido común: lo más probable es que ese pedido ya no sea relevante. No lo incluyas en "items" a menos que el usuario lo mencione o confirme hoy.
    - Solo agrega plataformas si el mensaje actual ("${messageContent}") las menciona explícitamente o si el historial reciente indica una continuación lógica inmediata.
    - Normaliza los nombres de planes y plataformas (ej. "Netflix - Básico" -> platform: "Netflix", plan: "Básico").
    - **REGLA CRÍTICA PARA MICROSOFT:** 
        * Si el usuario dice "Microsoft" o "Office" a secas (sin la palabra "compartida"), el plan es "Personal".
        * Si el usuario dice explícitamente "Microsoft compartida" o "Microsoft 365 compartida", el plan es "Compartida".
    - Si no se especifica plan para otras plataformas, pon null en "plan".
    - Si detectas "ChatGPT", normalizalo como platform: "ChatGPT".
    - Revisa las fechas/horas en el contexto. Si ha pasado mucho tiempo (varias horas o 1 día) entre el último mensaje del usuario y la respuesta (Hora actual del sistema), genera un breve "empathyGreeting". Si no hay demora significativa, déjalo en null.
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un asistente que extrae datos estructurados de pedidos.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error parsing purchase intent:", error);
    return { items: [], statedPrice: null, subscriptionType: 'mensual' };
  }
}

/**
 * Detects the payment method from a user's message.
 * @param {string} messageContent 
 * @returns {Promise<string|null>} The detected payment method key or null.
 */
async function detectPaymentMethod(messageContent) {
  const prompt = `
    Identifica el método de pago mencionado en: "${messageContent}".
    Opciones válidas: "nequi", "daviplata", "bancolombia", "banco caja social", "transfiya", "llaves bre-v", "llave bre-b".
    
    Salida esperada JSON:
    {
        "method": "nombre_metodo" | null
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un clasificador de métodos de pago. Responde solo con JSON.", true);
    const result = JSON.parse(jsonString);
    return result.method; // Puede ser null
  } catch (error) {
    console.error("Error detecting payment method:", error);
    return null;
  }
}

/**
 * Generates a human-like response for delivering credentials to the user.
 * @param {Array} userAccounts - The accounts found for the user.
 * @returns {Promise<string>}
 */
/**
 * Generates a text summary of the user's accounts for prompt context.
 */
function summarizeAccounts(userAccounts) {
  if (!userAccounts || userAccounts.length === 0) return "El usuario NO tiene servicios activos registrados.";
  
  return userAccounts.map(acc => {
    const streaming = (acc.Streaming || "Servicio").toUpperCase();
    const correo = acc.correo || acc.Correo || acc["E-mail"] || "N/A";
    const vence = acc.deben && !isNaN(parseFloat(acc.deben)) ? getJsDateFromExcel(acc.deben).toLocaleDateString() : (acc.vencimiento || "N/A");
    return `- ${streaming} (${correo}) - Vence: ${vence}`;
  }).join("\n");
}

async function generateCredentialsResponse(userAccounts, userMessage = "", chatHistory = "") {
  let cuentasTexto = "";
  if (!userAccounts || userAccounts.length === 0) {
     cuentasTexto = "El usuario no tiene cuentas activas en este momento o no encontramos registros asociados a su número.";
  } else {
     userAccounts.forEach(acc => {
       const streamingName = (acc.Streaming || "Servicio").toUpperCase();
       
       // Excluir cuentas familiares y extras
       const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'netflix extra'];
       const isFamily = familyPlatforms.some(fp => streamingName.toLowerCase().includes(fp));
       // if (isFamily) return;

       const correo = acc.correo || acc.Correo || acc["E-mail"] || "N/A";
       let clave = acc["contraseña"] || acc["Clave"] || acc["clave"] || acc["password"] || acc["Password"] || "N/A";
       const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
       const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "";
       const perfilCompleto = pin ? `${perfil} (PIN: ${pin})` : perfil;
       
       let fechaVencimiento = "Fecha desconocida";
       let isExpired = false;

       if (acc.deben && !isNaN(parseFloat(acc.deben))) {
           const jsDate = getJsDateFromExcel(acc.deben);
           fechaVencimiento = jsDate.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

           const today = getTodayInBogota();
           const compareDate = new Date(jsDate);
           compareDate.setHours(0,0,0,0);

           // Si la fecha de vencimiento es HOY o anterior, se considera vencida
           if (compareDate.getTime() <= today.getTime()) {
               isExpired = true;
           }
       } else if (acc.vencimiento) {
           fechaVencimiento = acc.vencimiento;
       }

       if (isExpired) {
           clave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
       }

       cuentasTexto += `- Plataforma: ${streamingName}\n  Correo: ${correo}\n  Clave: ${clave}\n  Perfil/PIN: ${perfilCompleto}\n  Vencimiento: ${fechaVencimiento}\n\n`;
     });

     if (cuentasTexto === "") {
        cuentasTexto = "El usuario no tiene cuentas activas o mostradas en este momento.";
     }
  }

  const prompt = `
  Eres un agente humano y empático de servicio al cliente de "Sheerit".
  Un cliente nos ha pedido revisar sus credenciales de streaming.
  
  Aquí están los datos de sus plataformas:
  ${cuentasTexto}

  HISTORIAL RECIENTE:
  ${chatHistory}

  MENSAJE DEL CLIENTE:
  "${userMessage}"
  
  INSTRUCCIONES:
  1. Si el cliente tiene una duda específica (ej: "¿cambió la clave?", "¿cuál es mi pin?", "no puedo entrar"), RESPÓNDELA directamente usando los datos arriba.
  2. Luego de responder la duda, entrega la información de sus cuentas de forma amable, clara y amigable.
  
  ⚠️ REGLAS CRÍTICAS:
  1. Muestra SIEMPRE el Correo, la Clave y el Perfil/PIN para CADA cuenta de la lista. NUNCA resumas u omitas esta información.
  2. Si la Clave o el PIN están presentes en los datos, DEBEN aparecer en tu respuesta.
  3. Si la cuenta está vencida, mantén el aviso de que la clave está oculta por seguridad.
  4. Si la lista está vacía, infórmale con tacto que no encontramos cuentas activas a su número.
  5. Al final de tu mensaje, incluye el emoji 🤖 para indicar que eres un asistente automatizado.
  
  No incluyas saludos genéricos como "[Tu Nombre]". Puedes despedirte en nombre del equipo de Sheerit.
  `;

  try {
    const responseText = await callGemini(prompt, "Eres un asesor de servicio al cliente en WhatsApp para Sheerit. Escribe de forma humana, directa y empática.", false);
    return responseText.trim();
  } catch (error) {
    console.error("Error generating credentials response:", error);
    // Fallback humano si falla la IA para no dejar al cliente sin datos
    return "👋 ¡Hola! Aquí tienes los datos de tus servicios actuales:\n\n" + cuentasTexto + "\n🤖 (Respuesta de respaldo automática)";
  }
}

/**
 * Formats credentials in a direct, plain-text format for mass sending without AI conversation.
 * @param {Array} userAccounts - The accounts found for the user.
 * @param {string} requestedPlatform - Optional. If provided, filters by this platform name.
 * @returns {string|null}
 */
function formatDirectCredentials(userAccounts, requestedPlatform = null, options = {}) {
  if (!userAccounts || userAccounts.length === 0) return null;
  
  let accountsToFormat = userAccounts;
  if (requestedPlatform) {
      const term = requestedPlatform.toLowerCase();
      accountsToFormat = userAccounts.filter(acc => (acc.Streaming || "").toLowerCase().includes(term));
  }
  
  if (accountsToFormat.length === 0) return null;
  
  const formattedAccounts = [];
  accountsToFormat.forEach(acc => {
    const streamingName = (acc.Streaming || "SERVICIO").toUpperCase();

    const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'netflix extra'];
    const isFamily = familyPlatforms.some(fp => streamingName.toLowerCase().includes(fp));
    
    const correo = acc.correo || acc.Correo || acc["E-mail"] || "N/A";
    let clave = acc["contraseña"] || acc["clave"] || acc["Clave"] || acc["password"] || acc["Password"] || "N/A";
    const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
    const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "N/A";
    
    const isSpotify = streamingName.toLowerCase().includes('spotify');
    const isYoutube = streamingName.toLowerCase().includes('youtube');

    // YouTube / Cuentas familiares: Priorizar el 'customer mail' si existe para no mostrar el correo del marcador/admin
    let displayCorreo = correo;
    const customerMail = (acc["customer mail"] || acc["Customer Mail"] || "").trim();
    if ((isYoutube || isFamily) && customerMail) {
        displayCorreo = customerMail;
    }

    const labelPin = isSpotify ? "DIRECCIÓN/LINK" : "PIN";
    const perfilDisplay = pin ? `${perfil} - ${labelPin}: ${pin}` : perfil;
    
    let fechaVencimiento = "Fecha desconocida";
    let isExpired = false;

    // Procesar fecha de vencimiento (asumimos que existe lógica previa de deben/vencimiento)
    // ... (reutilizamos la lógica de abajo) ...
    if (acc.deben && !isNaN(parseFloat(acc.deben))) {
        const jsDate = getJsDateFromExcel(acc.deben);
        const day = jsDate.getDate();
        const monthMatch = jsDate.toLocaleDateString('es-ES', { month: 'long' });
        const month = monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1);
        const year = jsDate.getFullYear();
        fechaVencimiento = `${day} de ${month} de ${year}`;

        const today = getTodayInBogota();
        const compareDate = new Date(jsDate);
        compareDate.setHours(0,0,0,0);
        if (compareDate.getTime() <= today.getTime()) {
            isExpired = true;
        }
    } else if (acc.vencimiento) {
        fechaVencimiento = acc.vencimiento;
    }

    const isConcise = options.concise || (requestedPlatform && (requestedPlatform.includes('solo pin') || requestedPlatform.includes('unicamente pin')));

    if (isConcise) {
        let conciseMsg = `🚨 *ACTUALIZACIÓN ${streamingName}*\n\n📧 Cuenta: ${displayCorreo}`;
        if (pin) conciseMsg += `\n📍 ${labelPin}: ${pin}`;
        conciseMsg += `\n\nSi tienes inconvenientes, escribe "ayuda". 🤖`;
        formattedAccounts.push(conciseMsg);
        return;
    }

    if (isFamily) {
        const msgFamily = isExpired 
            ? `⚠️ *SERVICIO VENCIDO*: Este servicio (${streamingName}) requiere renovación para seguir funcionando.`
            : `ℹ️ *NOTA*: Para este servicio, recibirás una invitación por correo. La contraseña la configuras tú mismo con tu correo al aceptar la invitación. Un asesor te contactará en breve si necesitas ayuda.`;
        
        formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${displayCorreo}\nPERFIL: ${perfilDisplay}\n\n${msgFamily}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
        return;
    }

    // LÓGICA YOPMAIL: Si el correo de cliente es yopmail, damos pasos de recuperación
    if (customerMail.toLowerCase().includes("@yopmail.com")) {
        clave = "(La configuras tú mismo siguiendo los pasos abajo)";
        const yopInstructions = `\n\n🔑 *PASOS PARA CONFIGURAR TU CLAVE:*\n1. Ve a www.yopmail.com\n2. Ingresa el correo: *${customerMail}*\n3. En la app de ${streamingName}, pide 'Olvidé mi contraseña' a ese correo.\n4. Revisa el código en Yopmail y activa tu cuenta. 📝`;
        formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${displayCorreo}\nCONTRASEÑA: ${clave}\nPERFIL: ${perfilDisplay}${yopInstructions}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
        return;
    }

    if (isExpired) {
        clave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
    }
    
    formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${displayCorreo}\nCONTRASEÑA: ${clave}\nPERFIL: ${perfilDisplay}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
  });
  
  return formattedAccounts.join('\n\n-------------------\n\n');
}

/**
 * Identifies the selected plan from a user's natural language message.
 * @param {string} messageContent 
 * @param {Array} availablePlans 
 * @returns {Promise<number|null>} The 1-based index of the plan or null.
 */
async function parsePlanSelection(messageContent, availablePlans) {
  const plansText = availablePlans.map((p, i) => `${i + 1}. ${p.name} ($${p.price})`).join('\n');
  const prompt = `
    El usuario debe elegir un plan de la siguiente lista:
    ${plansText}
    
    El mensaje del usuario es: "${messageContent}"
    
    Salida esperada JSON:
    {
        "selectedIndex": number | null // El número de la opción (1, 2, 3...) o null si no se entiende.
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un asistente que identifica la opción elegida por el usuario. Responde solo con JSON.", true);
    const result = JSON.parse(jsonString);
    return result.selectedIndex;
  } catch (error) {
    console.error("Error parsing plan selection:", error);
    return null;
  }
}

/**
 * Determina si una imagen es un comprobante de pago de un banco (Nequi, Daviplata, Bancolombia, etc.)
 * @param {object} mediaData 
 * @param {string} chatHistory 
 * @returns {Promise<{isReceipt: boolean, amount: number|null, bank: string|null}>}
 */
async function isPaymentReceipt(mediaData, chatHistory = "") {
  if (!mediaData) return { isReceipt: false, amount: null, bank: null };

  const prompt = `
    Analiza esta imagen adjunta y determina si es un COMPROBANTE DE PAGO, RECIBO DE TRANSFERENCIA o CAPTURA DE PANTALLA DE UNA TRANSACCIÓN EXITOSA.
    Contexto de la charla (puede que el usuario ya sepa el precio): ${chatHistory}

    Debes responder en formato JSON:
    {
      "isReceipt": boolean, // true si es claramente un recibo de banco (Nequi, Daviplata, Bancolombia, etc.)
      "amount": number | null, // El valor EXACTO de la transferencia (solo números) si es legible. Es vital para la validación automática.
      "bank": string | null, // Nombre del banco detectado (Nequi, Daviplata, etc.)
      "confidence": number, // 0 a 1
      "extractedDetails": string | null, // Cualquier texto extra como ID de transacción o fecha/hora visible.
      "inferredPlatform": string | null // Según el historial, ¿qué plataforma está pagando? (ej. 'Netflix', 'Spotify'). null si no es evidente.
    }

    Reglas:
    - Solo marca isReceipt: true si es una confirmación de envío/transferencia exitosa.
    - Sé muy riguroso con el 'amount'. Si hay varios números, busca el que diga 'Monto', 'Valor', 'Total' o esté resaltado.
    - No lo confundas con una foto de la plataforma de streaming.
    - Si el banco es Nequi, Daviplata, Bancolombia, dale prioridad.
    - Analiza el historial reciente: si el bot le estaba cobrando Netflix, o el usuario dijo "pago de Netflix", inferredPlatform DEBE ser "Netflix".
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un validador de comprobantes de pago bancarios.", true, mediaData);
    const result = JSON.parse(jsonString);
    return {
      isReceipt: result.isReceipt && result.confidence > 0.7,
      amount: result.amount,
      bank: result.bank,
      inferredPlatform: result.inferredPlatform || null
    };
  } catch (error) {
    console.error("Error recognizing payment proof:", error);
    return { isReceipt: false, amount: null, bank: null };
  }
}

/**
 * Clasifica la intención inicial de un mensaje para decidir qué flujo disparar.
 * También intenta extraer el nombre del usuario si se presenta.
 */
async function detectInitialIntent(messageContent, history = "", userName = null, userAccounts = []) {
  const prompt = `
    Eres "Sheerit", un asistente de ventas y soporte para una plataforma de streaming. 
    TU PERSONALIDAD: Eres un vendedor servicial, empático y muy profesional. No eres un robot rígido. Tu objetivo es ayudar al cliente a comprar o resolver sus dudas, explicando las ventajas de cada servicio si es necesario.

    CONVENCIÓN DE RESPUESTA:
    Responde ÚNICAMENTE en formato JSON.

    HISTORIAL Y CONTEXTO:
    - Nombre del usuario (si se conoce): ${userName || 'Desconocido'}
    - Cuentas del usuario (si tiene): ${JSON.stringify(userAccounts)}
    - Mensajes recientes:
    ${history}

    TAREA:
    Analiza el mensaje actual: "${messageContent}" y determina lo siguiente:

    1. "intent": 
       - "comprar": El usuario quiere adquirir un servicio nuevo o pregunta por precios/promociones.
       - "pagar": El usuario quiere renovar, pagar una deuda o pregunta cómo transferir.
       - "credenciales": El usuario pide su clave, pin, perfil o dice que no puede entrar.
       - "soporte": Problemas técnicos, fallos, dudas sobre el funcionamiento.
       - "cancelar": El usuario quiere dar de baja un servicio o no renovar.
       - "cierre": Despedidas, agradecimientos (gracias, listo, ok, vale).
       - "desconocido": Charla casual o algo que no encaja.

    2. "frustrationLevel": Un número del 1 al 10 indicando qué tan molesto o impaciente está el cliente.
    3. "userName": Si el usuario dice su nombre o se presenta, extráelo.
    4. "isNameComplete": Booleano, true si el nombre parece ser Nombre + Apellido.
    5. "detectedPlatform": Si menciona una plataforma específica (Netflix, Disney, etc.)
    6. "recoveredState": Si en el historial ves que la conversación se interrumpió en medio de un proceso (ej. iba a pagar y dejó de responder), sugiere el estado a recuperar ("awaiting_payment_method", "selecting_plans", etc.).

    REGLAS DE ORO:
    - Si el usuario pregunta por una plataforma distinta a la que se estaba hablando, marca intent "comprar" para que el bot pueda pivotar.
    - Si el usuario pregunta "qué significa" un plan o pide detalles, marca intent "soporte" o "comprar" según el contexto para explicarle.
    - No fuerces al usuario a seguir un flujo si su pregunta es válida y distinta.

    JSON esperado:
    {
      "intent": string,
      "frustrationLevel": number,
      "userName": string | null,
      "isNameComplete": boolean,
      "detectedPlatform": string | null,
      "recoveredState": string | null,
      "metadata": object // Cualquier dato extra útil
    }
  `;
async function detectInitialIntent(messageContent, chatHistory = "", mediaData = null, userAccounts = []) {
    const accountSummary = summarizeAccounts(userAccounts);
    const platformDocs = await getPlatformKnowledge();
    const platformContext = summarizePlatformKnowledge(platformDocs);

    const prompt = `
    Analiza el primer mensaje del usuario para identificar qué desea hacer.
    
    GUÍA DE FUNCIONAMIENTO DE PLATAFORMAS:
    ${platformContext}

    INFORMACIÓN DEL CLIENTE (Servicios actuales):
    ${accountSummary}

    Contexto previo: ${chatHistory}
    Mensaje actual: "${messageContent}"
    
    Categorías para "intent":
    - "comprar": El usuario quiere adquirir un servicio nuevo o pregunta por precios de algo que NO tiene.
    - "renovar": El usuario quiere pagar, renovar o pregunta el costo de un servicio que YA TIENE contratado (revisa la lista de cuentas del usuario).
    - "pagar": El usuario pregunta cómo pagar o envía un comprobante.
    - "soporte": Problemas técnicos, fallas de pantalla, o el usuario indica que ya pagó y el servicio no funciona/aparece cobro.
    - "cierre": El usuario se despide, da las gracias, confirma fin de charla o da un cierre natural (ej: "ok", "listo", "gracias", "vale").
    - "cancelar": El usuario manifiesta EXPRESAMENTE que no quiere renovar, que quiere cancelar el servicio, que no va a continuar o pide la baja.
    - "desconocido": Cualquier otro mensaje.

    Regla de Intents:
    - "comprar": PRIORIDAD si menciona plataforma nueva. Si el usuario ya tiene el servicio y pregunta "cuánto es", usa "renovar".
    - "renovar": PRIORIZA este intent si el usuario pregunta "cuánto es", "puedo pagar", "mándame el nequi" o "cuánto te debo" y ves que tiene cuentas activas o vencidas en su lista.
    - "credenciales": El usuario pide sus datos de acceso ("mi cuenta", "pásame el pin", "contraseña", "clave", "password"). PRIORIZA este intent si el usuario menciona palabras relacionadas con "llaves", "claves", "password" o "entrar".
    - "pagar": El usuario pregunta cómo pagar o envía un comprobante.
    - "soporte": Problemas técnicos, fallas, errores en pantalla, etc.
    - "cierre": El usuario indica que NO va a renovar, que quiere cancelar el servicio, que "deja así" o "ya no lo va a usar".
    - "desconocido": Otros temas que no encajan en lo anterior.

    Lógica de recuperación ("recoveredState"):
    - "awaiting_payment_method": 
        * Caso A: Si el mensaje menciona un medio de pago (Nequi, Daviplata, etc.) y en el historial el asistente ya dio un total a pagar.
        * Caso B (COLABORATIVO): Si el "Asistente" (humano, sin 🤖) negoció un precio (ej: "te queda en 21") y el usuario actual acepta (ej: "Listo", "Dale", "Vale"). EN ESTE CASO, el bot debe saltar aquí para dar los medios de pago. Si detectas el monto negociado, ponlo en metadata.total.
    - "waiting_human": 
        * Caso A (CONVERSACIÓN ACTIVA): Si en el historial reciente aparece un mensaje del "Asistente" (humano, sin el emoji 🤖) hablando con el usuario, pidiendo datos o dando soporte. ES VITAL que si ves al Asistente humano hablando, devuelvas "waiting_human" para no interrumpirlo.
        * Caso B (SILENCIO FORZADO): Si el usuario ha enviado múltiples mensajes de queja, insultos o insistencia extrema (ej: "hola???", "alguien??", "que pasa?") sin respuesta, y el bot no tiene una solución técnica inmediata. 
    - "awaiting_purchase_platforms": Si el usuario está preguntando por precios de plataformas específicas, comparando planes o preguntando "cuánto cuesta".
    - "awaiting_payment_confirmation": Si el mensaje es una imagen o texto indicando "ya pagué", "aquí el recibo", etc.
    - Si no hay un flujo claro a medias, pon null. 
    
    Regla de Frustración:
    - Analiza si el usuario suena desesperado, enojado o ha insistido mucho en corto tiempo sin ser atendido. Púntualo del 0 al 10 en "frustrationLevel". 
    - IMPORTANTE: Si el mensaje actual es un saludo (Hola, buenos días) o un ping (?, sigo esperando) y en el historial reciente (mensajes no leídos) hay una solicitud clara de **"credenciales", "comprar" o "pagar"** que NO fue respondida adecuadamente, PRIORIZA esa petición sobre el saludo. El intent debe ser el de la petición pendiente (ej: "comprar" si pidió Netflix).
    
    REGLA DE DEDUCCIÓN DE CONTEXTO Y CONTINUIDAD (MÁXIMA PRIORIDAD):
    Nunca analices el "Mensaje actual" de forma aislada. Debes deducir estrictamente a qué está respondiendo el cliente basándote en el historial:
    1. Si el "Mensaje actual" contiene varios mensajes (separados por \n), analízalos como una ráfaga lógica. Si hay contradicciones, dale prioridad al último mensaje de la ráfaga o al que sea más específico (ej: si dice "Hola" y luego "Quiero Netflix", el intent es "comprar").
    2. Si el Asistente (especialmente si es humano sin 🤖) acaba de hacer una pregunta o pedir un dato (ej: "¿Qué operador tienes?", "Confírmame tu correo", "Pásame el comprobante") y el cliente responde con ese dato (ej: "Claro", "Engativa", "Mi correo es..."), ES UNA CONTINUACIÓN DIRECTA.
    3. En este caso de continuación directa de una charla humana, TU ÚNICA ACCIÓN DEBE SER devolver "recoveredState": "waiting_human" y "intent": "desconocido". NO intentes resolver nada ni dar soporte, porque el humano ya está a cargo de recolectar esa información.
    4. Si el bot 🤖 estaba a la mitad de un flujo (ej: esperando método de pago) y el cliente responde a eso, recupera el estado correspondiente. ¡El contexto manda!
    5. **RELEVANCIA TEMPORAL:** Si el usuario menciona una plataforma (ej: Netflix) pero esa mención es de hace mucho tiempo (ej: más de 24 horas) y hoy solo envía un saludo inicial, usa el sentido común. No asumas que sigue queriendo comprar eso. El intent debe ser "desconocido" (saludo) y no "comprar", a menos que el usuario lo mencione de nuevo hoy o sea una continuación lógica clara.
    
    Salida esperada JSON:
    {
        "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "cierre" | "desconocido",
        "recoveredState": string | null,
        "frustrationLevel": number, // 0 a 10
        "userName": string | null,
        "isNameComplete": boolean,
        "detectedPlatform": string | null, 
        "metadata": object | null 
    }

    Si el mensaje actual es una imagen o el texto menciona un pago, revisa si es un comprobante. Si lo es, pon intent: "pagar".
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un clasificador de intenciones experto. Responde solo con JSON.", true, mediaData);
    const parsed = JSON.parse(jsonString);
    
    // Log debug explícito para afinar el prompt:
    console.log('\n--- [AI INTENT DEBUG] ---');
    console.log('Mensaje actual:', messageContent);
    console.log('Historial leído:', chatHistory ? chatHistory.substring(0, 500) + '...' : 'Ninguno');
    console.log('Resultado IA:', JSON.stringify(parsed, null, 2));
    console.log('-------------------------\n');

    return parsed;
  } catch (error) {
    console.error("Error detecting initial intent:", error);
    return { 
        intent: "desconocido",
        recoveredState: null,
        frustrationLevel: 0,
        userName: null,
        isNameComplete: false,
        detectedPlatform: null,
        metadata: null
    };
  }
}

/**
 * Analiza una consulta en lenguaje natural del administrador y extrae parámetros de búsqueda.
 * @param {string} query 
 * @returns {Promise<Object>} { action: string, filters: { name, platform, status, generic_search } }
 */
async function parseAdminQueryIntent(query) {
  const prompt = `
    Eres un asistente analítico experto en extraer parámetros de búsqueda sobre una base de datos de streaming.
    El administrador te ha pedido la siguiente consulta en lenguaje natural: "${query}"

    Salida esperada usando estricto JSON:
    {
      "action": "search_customer" | "get_available" | "check_history" | "summary_stats" | "liberate_user" | "broadcast_credentials" | "confirm_action" | "auto_cobros" | "list_functions" | "update_data" | "record_sale" | "general_query",
      "filters": {
        "name": string | null, // Nombre de la persona o nombre específico de la cuenta/correo
        "platform": string | null,
        "status": "libre" | "ocupado" | "vencido" | null,
        "phone": string | null,
        "generic_search": string | null, // Contexto adicional o destinatario masivo (ej: "todos los de spotify")
        "new_password": string | null,
        "custom_message": string | null,
        "only_fields": string[] | null,
        "target_field": string | null,
        "new_value": string | null
      }
    }

    Reglas de 'action':
    - Si el mensaje pide "pasa la cuenta de X a todos los de Y", es "broadcast_credentials".
    - En "broadcast_credentials", 'name' debe ser el nombre/correo de la cuenta que se va a enviar (la fuente), y 'generic_search' debe ser el público objetivo (el destino).
    - Si el mensaje es una confirmación afirmativa o respuesta positiva como "sí", "si", "dale", "proceder", "adelante", "confirmar", "hazlo", "envíaselo", "enviaselo", es "confirm_action".
    - Si pide "haz los cobros", "inicia cobranza", "pasa los recibos", "manda avisos", "cobros automáticos", es "auto_cobros".
    - Si pide "funciones", "qué puedes hacer", "ayuda", "comandos", "que haces", es "list_functions".
    - Si pide "envía", "notifica", "pasa", "reparte", "manda", "avisa", "dile" a un grupo de personas, es "broadcast_credentials". Prioriza esta acción si hay un verbo de envío o acción hacia el cliente.
    - Si pide "registra una venta", "haz una venta", "vende", "asigna una cuenta de...", es "record_sale".
    - Si pide "cambia", "ponle", "edita", "actualiza", "corrige" un valor o campo (ej: "ponle laura fonseca", "cambia el correo a..."), es "update_data".
    - Si pide "dame la cuenta de...", "que cuentas tiene...", "tienes la cuenta de...", "busca a...", "busca el correo...", es "search_customer".
    - Si pide "cuantas hay libre", "traeme una cuenta libre de...", "hay disponibles de...", es "get_available".
    - Si pide "historico", "que cuentas ha tenido...", es "check_history".
    - Si pide "cuantas hay en total", "resumen de...", "cuentas totales", es "summary_stats".
    - Si pide "atiende a...", "libera a...", "atender el pendiente de...", "encárgate de...", es "liberate_user".
    - Si pide "qué acabaste de hacer", "qué pasó", "explícame", "dame detalles de la última acción", es "explain_last_action".
    - Si no encaja, usa "general_query".

    Reglas de 'filters':
    - 'name': Extrae el nombre explícito que el admin busca (ej: "busca a laura fonseca" -> "laura fonseca"). Ignora palabras como "busca a", "dame la cuenta de".
    - 'target_field': Si es una actualización, identifica qué columna quiere cambiar (ej: "nombre", "correo", "clave", "vencimiento").
    - 'new_value': El nuevo valor que se debe escribir (ej: "laura bonita", "juan@gmail.com").
    - 'generic_search': Si el admin busca por cuenta/correo pero no está claro si es nombre o correo, ponlo aquí. También usa este campo para el destinatario de un broadcast (ej: "manda a los de disney" -> "disney", "avisa a juan@gmail.com" -> "juan@gmail.com").
    - 'custom_message': Si el admin pide enviar un broadcast diciendo algo específico (ej: "dile a los de netflix que su cuenta caducó", "avisa que cambien de cuenta"), extrae el MENSAJE EXACTO O PARAFRASEADO que el bot debe enviar ("Tu cuenta ha caducado", "Por favor, cambia de cuenta").
    - 'only_fields': Si el admin especifica qué partes de las credenciales enviar (ej: "solo la contraseña", "únicamente el pin", "no mandes el correo, solo clave y perfil"), llena este arreglo con las palabras clave ("clave", "contraseña", "pin", "pin perfil", "perfil"). Si debe enviar todo, déjalo null o vacío.
  `;
  try {
    const jsonString = await callGemini(prompt, "Eres un extractor de parámetros para consultas de base de datos JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error parsing admin query intent:", error);
    return { action: "general_query", filters: {} };
  }
}

/**
 * Genera el reporte final en texto plano amigable para el administrador usando los datos filtrados de la BD.
 * @param {string} query
 * @param {Array|Object} dataContext
 * @returns {Promise<string>}
 */
async function generateAdminReport(query, dataContext) {
  // Try to limit the size to avoid overloading the context, although Gemini flash can handle large contexts.
  let jsonContext = JSON.stringify(dataContext);
  if (jsonContext.length > 50000) {
      jsonContext = jsonContext.substring(0, 50000) + '... (Datos truncados por límite de tamaño)';
  }

  const prompt = `
    Eres el asistente personal de datos (Dashboard Conversacional) del administrador de Sheerit.
    El administrador te hizo la siguiente consulta: "${query}"

    Aquí están los resultados de la base de datos (filtrados) en formato JSON:
    ${jsonContext}

    Tu tarea es responder la pregunta del administrador basándote ESTRICTAMENTE en estos datos proporcionados.
    
    Reglas:
    - Sé directo, profesional, pero amigable. Usa formato de WhatsApp (*negrita*, emojis).
    - **IMPORTANTE (Confirmación)**: Si el JSON tiene status "pending_confirmation", informa al administrador que se han encontrado coincidencias (especifica cuántas y para qué cuenta) y pregúntale explícitamente si desea proceder con el envío de las credenciales (debe decir "Sí" o similar). Lista los perfiles involucrados. Usa la terminología exacta del JSON para referirte a los campos (ej: si el campo es "pin perfil", llámalo así, no "pin y el perfil").
    - **IMPORTANTE (Sugerencia)**: Si el JSON tiene status "suggestion", explica amistosamente que no encontraste el correo en la plataforma pedida, pero sí en otras, y pregúntale si se refiere a alguna de esas.
    - Si te pide los datos de una o más cuentas libres, dáselos de forma organizada (correo, clave, pin perfil si aplica).
    - Si te pide un resumen ("cuántas hay libres"), dáselo de forma contada e inteligible agrupado por plataforma.
    - Si te pregunta por el histórico de alguien, resume las cuentas que ha tenido de forma clara.
    - Si en el JSON dice que no se encontraron coincidencias o que el vector está vacío ([]), dile: "No encontré información en la base de datos para los parámetros solicitados sobre: ${query}".
    - NUNCA inventes correos o contraseñas que no estén en el JSON provisto.
  `;

  try {
    // Para esta tarea grande, si hay muchisimos datos forzamos modelo gemini-2.0-flash por si a caso.
    const responseText = await callGemini(prompt, "Eres un asistente analítico para WhatsApp. Responde en texto legible y estético.", false);
    return responseText.trim();
  } catch (error) {
    console.error("Error generating admin report:", error);
    return "❌ Ocurrió un error al generar tu reporte de datos utilizando la inteligencia artificial.";
  }
}

/**
 * Identifica si un mensaje del administrador indica interés en un modo específico o sugiere acciones.
 * @param {string} query 
 * @returns {Promise<Object>}
 */
/**
 * Genera una respuesta proactiva o explicativa para el administrador usando contexto de arquitectura y logs.
 */
async function suggestAdminActions(query, context = "") {
  const prompt = `
    Eres el asistente personal de datos (Dashboard Conversacional) del administrador de Sheerit.
    El administrador te ha escrito: "${query}"
    
    CONTEXTO TÉCNICO Y ARQUITECTURA:
    ${context}

    Tu tarea es responder de forma proactiva y transparente.
    
    REGLAS DE RESPUESTA:
    1. Si el usuario pregunta "qué hiciste" o pide detalles, usa la sección ARQUITECTURA y ÚLTIMA ACCIÓN del contexto para explicar exactamente qué filas o columnas se tocaron.
    2. Sé extremadamente específico (ej: "Actualicé la columna 'deben' en la fila 466").
    3. Si algo no se ve reflejado en el Excel, sugiere revisar los nombres de columna del README vs el Excel real.
    4. Si no hay una acción reciente clara, sugiere acciones administrativas (cobros, validación de pagos, stock).
    
    Salida esperada JSON:
    {
      "replyMessage": "Tu respuesta conversacional aquí."
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un asistente administrativo transparente y proactivo. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error in suggestAdminActions:", error);
    return { suggestedAction: "general_query", replyMessage: "No estoy seguro de qué deseas hacer, ¿puedes ser más específico? 🤖" };
  }
}

module.exports = { 
  parsePurchaseIntent, 
  detectPaymentMethod, 
  generateCredentialsResponse, 
  parsePlanSelection, 
  generateEmpatheticFallback, 
  detectInitialIntent,
  detectAdminIntent, 
  formatDirectCredentials, 
  isPaymentReceipt, 
  parseAdminQueryIntent, 
  generateAdminReport,
  suggestAdminActions
};
