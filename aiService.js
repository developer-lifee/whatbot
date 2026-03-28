require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// List of models to try in order. Prioritizes flash models.
const MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3-flash"
];

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
  if (mediaData && mediaData.data && mediaData.mimeType) {
    parts.push({
      inlineData: {
        data: mediaData.data,
        mimeType: mediaData.mimeType
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
      if (modelName === MODELS[MODELS.length - 1]) {
        throw new Error("All fallback models failed or exceeded quota.");
      }
    }
  }
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
    - Normaliza los nombres de planes y plataformas (ej. "Netflix - Básico" -> platform: "Netflix", plan: "Básico").
    - Si no se especifica plan, pon null en "plan".
    - Si detectas "ChatGPT", normalizalo como platform: "ChatGPT".
    - Revisa las fechas/horas en el contexto. Si ha pasado mucho tiempo (varias horas o 1 día) entre el último mensaje del usuario y la respuesta (Hora actual del sistema), genera un breve "empathyGreeting" (ej. "¡Hola! Qué pena la demora en responderte..."). Si no hay demora significativa, déjalo en null.
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
async function generateCredentialsResponse(userAccounts) {
  let cuentasTexto = "";
  if (!userAccounts || userAccounts.length === 0) {
     cuentasTexto = "El usuario no tiene cuentas activas en este momento o no encontramos registros asociados a su número.";
  } else {
     userAccounts.forEach(acc => {
       const streamingName = (acc.Streaming || "Servicio").toUpperCase();
       
       // Excluir cuentas familiares
       const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'family'];
       const isFamily = familyPlatforms.some(fp => streamingName.toLowerCase().includes(fp));
       if (isFamily) return;

       const correo = acc.correo || "N/A";
       let clave = acc["contraseña"] || "N/A";
       const perfil = `${acc.Nombre || ""}-${acc["pin perfil"] || ""}`;
       
       let fechaVencimiento = "Fecha desconocida";
       let isExpired = false;

       if (acc.deben && !isNaN(parseFloat(acc.deben))) {
           const excelDate = parseFloat(acc.deben);
           const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
           fechaVencimiento = jsDate.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

           const today = new Date();
           today.setHours(0,0,0,0);
           const compareDate = new Date(jsDate);
           compareDate.setHours(0,0,0,0);
           if (compareDate.getTime() < today.getTime()) {
               isExpired = true;
           }
       } else if (acc.vencimiento) {
           fechaVencimiento = acc.vencimiento;
       }

       if (isExpired) {
           clave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
       }

       cuentasTexto += `- Plataforma: ${streamingName}\n  Correo: ${correo}\n  Clave: ${clave}\n  Perfil: ${perfil}\n  Vencimiento: ${fechaVencimiento}\n\n`;
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

  Por favor, redacta un mensaje de WhatsApp para el cliente entregándole esta información de manera amable, clara y amigable.
  Si la lista está vacía, infórmale con tacto que no encontramos cuentas activas a su número.
  
  ⚠️ IMPORTANTE: Al final de tu mensaje, incluye el emoji 🤖 para indicar que eres un asistente automatizado.
  No incluyas saludos genéricos como "[Tu Nombre]". Puedes despedirte en nombre del equipo de Sheerit.
  `;

  try {
    const responseText = await callGemini(prompt, "Eres un asesor de servicio al cliente en WhatsApp para Sheerit. Escribe de forma humana, directa y empática.", false);
    return responseText.trim();
  } catch (error) {
    console.error("Error generating credentials response:", error);
    return "Hola! Aquí tienes tus credenciales:\n\n" + cuentasTexto + "\nSi necesitas ayuda, avísame.";
  }
}

/**
 * Formats credentials in a direct, plain-text format for mass sending without AI conversation.
 * @param {Array} userAccounts - The accounts found for the user.
 * @param {string} requestedPlatform - Optional. If provided, filters by this platform name.
 * @returns {string|null}
 */
function formatDirectCredentials(userAccounts, requestedPlatform = null) {
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

    // Excluir cuentas familiares
    const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'family'];
    const isFamily = familyPlatforms.some(fp => streamingName.toLowerCase().includes(fp));
    if (isFamily) return;

    const correo = acc.correo || "N/A";
    let clave = acc["contraseña"] || "N/A";
    const perfil = acc["pin perfil"] ? `${acc.Nombre || "N/A"} - ${acc["pin perfil"]}` : (acc.Nombre || "N/A");
    
    let fechaVencimiento = "Fecha desconocida";
    let isExpired = false;

    if (acc.deben && !isNaN(parseFloat(acc.deben))) {
        const excelDate = parseFloat(acc.deben);
        const jsDate = new Date((excelDate - 25569) * 86400 * 1000);
        const day = jsDate.getDate();
        const monthMatch = jsDate.toLocaleDateString('es-ES', { month: 'long' });
        const month = monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1);
        const year = jsDate.getFullYear();
        fechaVencimiento = `${day} de ${month} de ${year}`;

        const today = new Date();
        today.setHours(0,0,0,0);
        const compareDate = new Date(jsDate);
        compareDate.setHours(0,0,0,0);
        if (compareDate.getTime() < today.getTime()) {
            isExpired = true;
        }
    } else if (acc.vencimiento) {
        fechaVencimiento = acc.vencimiento;
    }
    
    if (isExpired) {
        clave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
    }
    
    formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${correo}\nCONTRASEÑA: ${clave}\nPERFIL: ${perfil}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
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
 * Generates an empathetic response for unsupported media or off-script messages.
 * @param {string} userMessage 
 * @param {boolean} isMedia 
 * @param {string} chatHistory 
 * @param {object|null} mediaData { data: 'base64', mimeType: 'image/jpeg' }
 * @returns {Promise<string>}
 */
async function generateEmpatheticFallback(userMessage, isMedia, chatHistory = "", mediaData = null) {
  const mediaInstruction = isMedia && mediaData 
    ? "El usuario ha enviado una imagen o sticker que está adjunta a este prompt. Obsérvala detenidamente y analiza su contenido/emoción."
    : "";

  let priceContext = "";
  try {
    const { getPlatforms } = require('./salesService');
    const platforms = getPlatforms();
    if (platforms && platforms.length > 0) {
      priceContext = "Lista de precios mensuales actuales (si preguntan valores, cíñete a esto): " + 
                     platforms.map(p => `${p.name}: $${p.price}`).join(', ') + ".";
    }
  } catch (e) { }

  const prompt = `
    El usuario envió un mensaje que el bot no puede procesar técnicamente mediante los flujos regulares.
    ${mediaInstruction}
    
    Contexto previo de la conversación:
    ${chatHistory}
    
    ${priceContext}
    
    Mensaje textual/Tipo: "${isMedia ? "[ARCHIVO MULTIMEDIA/STICKER]" : userMessage}"
    
    Instrucciones:
    1. Responde de forma cálida, empática y amigable.
    2. Si el usuario está preguntando por el precio de una plataforma o sobre un solo servicio antes de pagar, RESPÓNDE SU DUDA directamente basado en los "Precios actuales" listados arriba.
    3. Si adjuntó un sticker/imagen, haz referencia a lo que logras ver (la emoción, colores, meme, o error técnico) y explícale con tacto que por ahora prefieres texto.
    4. Si parece una captura de error técnico, recomiéndale visitar (sheerit.com.co/aiuda) o pedir la Opción 5 para hablar con un asesor.
    5. Cierra invitando sutilmente al usuario a continuar con su solicitud (ej. "¿Por dónde te gustaría transferir?").
    6. Sé directo, sin rodeos innecesarios. Máximo 4 líneas. Incluye el emoji 🤖 al final.
  `;

  try {
    const responseText = await callGemini(prompt, "Eres un asistente de servicio al cliente muy empático, perspicaz y humano.", false, mediaData);
    return responseText.trim();
  } catch (error) {
    console.error("Error generating empathetic fallback:", error);
    return "¡Me encantó! Aunque por ahora solo entiendo texto, ¿en qué te puedo ayudar con tu cuenta? 🤖";
  }
}

/**
 * Analyzes the first message to identify the user's intent.
 * @param {string} messageContent 
 * @param {string} chatHistory 
 * @returns {Promise<{intent: string, confidence: number}>}
 */
async function detectInitialIntent(messageContent, chatHistory = "") {
  const prompt = `
    Analiza el primer mensaje del usuario para identificar qué desea hacer.
    Contexto previo: ${chatHistory}
    Mensaje actual: "${messageContent}"
    
    Categorías:
    - "comprar": El usuario quiere adquirir una cuenta nueva.
    - "credenciales": El usuario pide sus claves, dice que no le sirven, no puede entrar, pide pin, contraseñas de perfil, o menciona perfiles bloqueados.
    - "pagar": El usuario quiere renovar, pagar, sabe precios o renovar suscripción.
    - "soporte": El usuario tiene problemas técnicos o pide ayuda general.
    - "desconocido": No se identifica una intención clara.
    
    Salida esperada JSON:
    {
        "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "desconocido"
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un clasificador de intenciones experto. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error detecting initial intent:", error);
    return { intent: "desconocido" };
  }
}

module.exports = { parsePurchaseIntent, detectPaymentMethod, generateCredentialsResponse, parsePlanSelection, generateEmpatheticFallback, detectInitialIntent, formatDirectCredentials };
