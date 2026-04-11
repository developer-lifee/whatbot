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
       
       // Excluir cuentas familiares y extras
       const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'netflix extra'];
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

    // Excluir cuentas familiares y extras
    const familyPlatforms = ['youtube', 'microsoft', 'apple', 'spotify', 'apple one', 'netflix extra'];
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
      "amount": number | null, // El valor de la transferencia (solo números) si es legible.
      "bank": string | null, // Nombre del banco detectado (Nequi, Daviplata, etc.)
      "confidence": number // 0 a 1
    }

    Reglas:
    - Solo marca isReceipt: true si es una confirmación de envío/transferencia exitosa.
    - No lo confundas con una foto de la plataforma de streaming.
    - Si el banco es Nequi, Daviplata, Bancolombia, dale prioridad.
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un validador de comprobantes de pago bancarios.", true, mediaData);
    const result = JSON.parse(jsonString);
    return {
      isReceipt: result.isReceipt && result.confidence > 0.7,
      amount: result.amount,
      bank: result.bank
    };
  } catch (error) {
    console.error("Error recognizing payment proof:", error);
    return { isReceipt: false, amount: null, bank: null };
  }
}

/**
 * Generates an empathetic response for unsupported media or off-script messages, and decides if it needs human escalation.
 * @param {string} userMessage 
 * @param {boolean} isMedia 
 * @param {string} chatHistory 
 * @param {object|null} mediaData { data: 'base64', mimeType: 'image/jpeg' }
 * @param {Array} userAccounts Cuentas del usuario obtenidas de la base
 * @returns {Promise<Object>} { replyMessage, needsEscalation, escalationSummary }
 */
async function generateEmpatheticFallback(userMessage, isMedia, chatHistory = "", mediaData = null, userAccounts = []) {
  const mediaInstruction = isMedia && mediaData 
    ? "El usuario ha enviado una imagen o sticker que está adjunta a este prompt. Obsérvala detenidamente y analiza su contenido/emoción."
    : "";

  let priceContext = "";
  let supportContext = "";
  try {
    const { getPlatforms } = require('./salesService');
    const platforms = await getPlatforms();
    if (platforms && platforms.length > 0) {
      priceContext = "Lista de precios mensuales actuales (si preguntan valores, cíñete a esto): " + 
                     platforms.map(p => `${p.name}: $${p.plans[0].price}`).join(', ') + ".";
    }
  } catch (e) { }

  try {
    const { getSupportKnowledge } = require('./apiService');
    const supportData = await getSupportKnowledge();
    if (supportData && supportData.length > 0) {
      supportContext = "Base de conocimiento de Soporte Técnico (SOLUCIONARIO DE PROBLEMAS):\n" + JSON.stringify(supportData) + "\n\n(Usa ESTOS pasos si el problema del usuario o la captura de pantalla coincide con alguno de estos errores. Dale las instrucciones o pídele los datos que ahí se mencionan. Sé asertivo, es el conocimiento oficial.)";
    }
  } catch (e) { }

  let accountsContext = "";
  if (userAccounts && userAccounts.length > 0) {
     const simplifiedAccounts = userAccounts.map(acc => ({
        Plataforma: acc.Streaming,
        Correo: acc.correo,
        Vencimiento: acc.vencimiento || acc.deben
     }));
     accountsContext = "Cuentas del usuario en nuestro sistema:\n" + JSON.stringify(simplifiedAccounts);
  }

  const prompt = `
    El usuario envió un mensaje que el bot no puede procesar técnicamente mediante los flujos regulares o requiere soporte técnico.
    ${mediaInstruction}
    
    Contexto previo de la conversación:
    ${chatHistory}
    
    ${priceContext}
    
    ${supportContext}

    ${accountsContext}
    
    Mensaje textual/Tipo: "${isMedia ? "[ARCHIVO MULTIMEDIA/STICKER]" : userMessage}"
    
    Instrucciones:
    Eres un asistente de servicio al cliente. Debes dar una respuesta estructurada en formato JSON estricto.
    1. Si es una duda comercial o sobre cómo pagar, responde la duda en "replyMessage" y manda "needsEscalation": false. PROHIBIDO INVENTAR NÚMEROS DE CUENTAS BANCARIAS, NEQUI O NOMBRES DE TITULARES. Dile ÚNICAMENTE que aceptamos Nequi, Llave Bre-B, Daviplata, Banco Caja Social y Bancolombia, y que los números se proporcionan durante el flujo de compra.
    2. Si es una solicitud de soporte técnico (o el usuario subió una captura de pantalla intentando actualizar hogar o pidiendo código) y el problema ESTÁ en la base de datos de soporte: PUEDES y DEBES darle el paso a paso ("steps") directamente en el "replyMessage" usando una lista amigable y pon "needsEscalation": false. NO escales el caso si el solucionario te da instrucciones claras que el usuario puede seguir autónomamente (como entrar a sheerit.com.co/actualizar). SOLO escálalo (poniendo "needsEscalation": true) si la guía explícitamente dice cosas como "contacta a soporte", "envíanos", o requiere labor manual humana; en ese caso da un resumen en "escalationSummary".
    3. Si el problema es técnico, muy complejo o no está en la base, pon "needsEscalation": true y escribe un reporte en "escalationSummary".
    4. El "replyMessage" debe ser directo, humano, máximo 5 líneas, incluye el emoji 🤖 al final.

    Salida esperada JSON:
    {
       "replyMessage": "Texto empático para el usuario...",
       "needsEscalation": boolean,
       "escalationSummary": "Reporte para operadores o null"
    }
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un asistente de servicio al cliente experto. Responde ÚNICAMENTE con formato JSON.", true, mediaData);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error generating empathetic fallback JSON:", error);
    return {
       replyMessage: "¡He notificado a tu asesor! Dame unos minutos en lo que entra a revisar tu caso en detalle. 🤖",
       needsEscalation: true,
       escalationSummary: "Falla de conectividad local con la IA al procesar: " + userMessage
    };
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
    
    Categorías para "intent":
    - "comprar": El usuario quiere iniciar una compra o saber precios.
    - "credenciales": El usuario pide sus claves o reporta fallas de acceso.
    - "pagar": El usuario quiere renovar, pagar, o identifica un medio de pago para una transacción pendiente (ej: "nequi", "daviplata").
    - "soporte": Problemas técnicos.
    - "desconocido": Sin intención clara.

    Lógica de recuperación ("recoveredState"):
    - "awaiting_payment_method": 
        * Caso A: Si el mensaje menciona un medio de pago (Nequi, Daviplata, etc.) y en el historial el asistente ya dio un total a pagar.
        * Caso B (COLABORATIVO): Si el "Asistente" (humano, sin 🤖) negoció un precio (ej: "te queda en 21") y el usuario actual acepta (ej: "Listo", "Dale", "Vale"). EN ESTE CASO, el bot debe saltar aquí para dar los medios de pago. Si detectas el monto negociado, ponlo en metadata.total.
    - "waiting_human": Si en el historial aparece un mensaje del "Asistente" (humano, sin 🤖) y es una charla social, técnica compleja o el usuario no ha aceptado aún una oferta comercial.
    - "awaiting_purchase_platforms": Si el usuario está preguntando por precios de plataformas específicas, comparando planes o preguntando "cuánto cuesta".
    - "awaiting_payment_confirmation": Si el mensaje es una imagen o texto indicando "ya pagué", "aquí el recibo", etc.
    - Si no hay un flujo claro a medias, pon null. 
    
    Regla Crítica para "intent": 
    - No lo marques como "desconocido" si el usuario está haciendo una pregunta válida sobre precios o servicios. Si pregunta un precio, el intent es "comprar".
    
    Salida esperada JSON:
    {
        "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "desconocido",
        "recoveredState": string | null,
        "userName": string | null, // Si el usuario se presentó o dijo su nombre en el historial, extráelo aquí.
        "metadata": object | null // { total: number, items: string[] } si es recuperación de pago.
    }

    Si el mensaje actual es una imagen, revisa si es un comprobante de pago. Si lo es, pon intent: "pagar".
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un clasificador de intenciones experto. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error detecting initial intent:", error);
    return { intent: "desconocido" };
  }
}

module.exports = { parsePurchaseIntent, detectPaymentMethod, generateCredentialsResponse, parsePlanSelection, generateEmpatheticFallback, detectInitialIntent, formatDirectCredentials, isPaymentReceipt };
