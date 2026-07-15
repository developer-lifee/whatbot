const { getJsDateFromExcel, getTodayInBogota, getPlatformKnowledge, getWisdomKnowledge, getSupportKnowledge } = require('./apiService');
const fs = require('fs');
const path = require('path');

let cachedSystemPrompt = null;
let lastPromptFetchTime = 0;
const PROMPT_CACHE_TTL = 30000; // 30 seconds

function clearCachedSystemPrompt() {
  cachedSystemPrompt = null;
  lastPromptFetchTime = 0;
}

async function getSystemPromptTemplate() {
  const now = Date.now();
  if (cachedSystemPrompt && (now - lastPromptFetchTime < PROMPT_CACHE_TTL)) {
    return cachedSystemPrompt;
  }

  try {
    const { pool } = require('./database');
    const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "fallback_template"');
    if (rows && rows.length > 0) {
      cachedSystemPrompt = rows[0].cfg_value;
      lastPromptFetchTime = now;
      return cachedSystemPrompt;
    }
  } catch (err) {
    console.warn("[aiService] Error al leer prompt de la base de datos, usando archivo local:", err.message);
  }

  try {
    const templatePath = path.join(__dirname, 'prompts', 'fallback_template.txt');
    const promptContent = fs.readFileSync(templatePath, 'utf8');
    cachedSystemPrompt = promptContent;
    lastPromptFetchTime = now;
    return cachedSystemPrompt;
  } catch (e) {
    console.warn("No se pudo cargar la plantilla de archivo local, usando fallback básico.");
    return "Responde de forma amable a: {{MESSAGE_CONTENT}}";
  }
}

// Supported API Keys array for automated rotation and failover
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_182,
  process.env.GEMINI_API_KEY_6324,
  process.env.GEMINI_API_KEY
].filter(Boolean);

let currentKeyIndex = 0;

function getActiveGeminiKey() {
  if (GEMINI_KEYS.length === 0) return null;
  return GEMINI_KEYS[currentKeyIndex % GEMINI_KEYS.length];
}

function rotateGeminiKey() {
  if (GEMINI_KEYS.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % GEMINI_KEYS.length;
    const activeKey = getActiveGeminiKey() || "";
    console.log(`[Gemini Failover] Rotando clave a índice ${currentKeyIndex}. Clave activa ahora termina en: ...${activeKey.slice(-6)}`);
  }
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_BASE = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";

/**
 * Convierte el JSON de sabiduría en un texto legible para el prompt de la IA.
 */
function summarizeWisdom(wisdom) {
  if (!wisdom) return "";
  let summary = "";

  if (wisdom.company_info) {
    summary += `EMPRESA: ${wisdom.company_info.name}\nMISIÓN: ${wisdom.company_info.mission}\n\n`;
  }

  if (wisdom.human_support_schedule) {
    summary += "HORARIOS DE ATENCIÓN HUMANA:\n";
    wisdom.human_support_schedule.forEach(s => {
      summary += `- ${s.days} (${s.staff}): ${s.details}\n`;
    });
    summary += "\n";
  }

  if (wisdom.platform_rules) {
    summary += "REGLAS ESPECÍFICAS DE PLATAFORMAS:\n";
    for (const [plat, rule] of Object.entries(wisdom.platform_rules)) {
      summary += `- ${plat}: ${rule}\n`;
    }
    summary += "\n";
  }

  if (wisdom.general_policies) {
    summary += "POLÍTICAS GENERALES:\n";
    for (const [key, val] of Object.entries(wisdom.general_policies)) {
      summary += `- ${key.toUpperCase()}: ${val}\n`;
    }
    summary += "\n";
  }

  if (wisdom.support_protocol) {
    summary += `PROTOCOLO DE SOPORTE: ${wisdom.support_protocol.first_step} (${wisdom.support_protocol.rationale})\n`;
  }

  return summary;
}

/**
 * Determina si una cuenta es de tipo "Familiar" o "Extra" según su nombre.
 * Estas cuentas NUNCA deben mostrar el correo/clave principal del administrador.
 */
function isFamilyPlan(streamingName) {
  if (!streamingName) return false;
  const name = streamingName.toLowerCase();
  const familyKeywords = [
    'youtube', 'microsoft', 'office', 'apple', 'spotify',
    'apple one', 'extra', 'familiar', 'personal (tu correo)',
    'correo propio', 'tu correo', 'canje', 'invitacion', 'invitación'
  ];

  const isMatched = familyKeywords.some(kw => name.includes(kw));

  // Si contiene "owner", "dueño" o "proporcionado", NO es un plan tipo invitación para el cliente final, sino administrativo/proporcionado
  if (name.includes('owner') || name.includes('dueño') || name.includes('proporcionado')) {
    return false;
  }

  return isMatched;
}

/**
 * Obtiene los datos de acceso formateados para una cuenta, aplicando reglas de privacidad.
 * @param {object} acc - El objeto de la cuenta del Excel.
 * @returns {object} { streamingName, isFamily, correo, clave, customerMail }
 */
function getMaskedAccessData(acc) {
  const streamingName = (acc.Streaming || acc.streaming || acc.name || "Servicio").toUpperCase();
  const isFamily = isFamilyPlan(streamingName);

  const correoOriginal = acc.correo || acc.Correo || acc["E-mail"] || "N/A";
  let clave = acc["contraseña"] || acc["Clave"] || acc["clave"] || acc["password"] || acc["Password"] || "N/A";
  const customerMail = (acc["customer mail"] || acc["Customer Mail"] || acc.customerMail || "").trim();

  let displayCorreo = correoOriginal;
  let displayClave = clave;

  if (isFamily) {
    displayClave = "(Acceso por invitación/perfil propio)";
    if (customerMail) {
      displayCorreo = customerMail;
    } else {
      // Si es familiar pero no tiene customer mail, probablemente sea una invitación pendiente
      displayCorreo = "(Tu correo personal)";
    }
  }

  return {
    streamingName,
    isFamily,
    correo: displayCorreo,
    clave: displayClave,
    customerMail: customerMail
  };
}

const MODELS = [
  "gemini-3.1-flash-lite" // Solo el modelo Lite ultra económico y rápido
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
    - "liberar_bot": El jefe quiere que el bot vuelva a atender a un cliente que estaba silenciado (menciona "liberar", "atiende", "vuelve", "contesta", "te ayuda el bot", "ayúdame a explicar", "explícale").
    - "dame_cuenta": El jefe quiere que le des las credenciales de una plataforma para él mismo (menciona "dame una de", "pásame", "pasa cuenta", "quiero entrar a"). 
      *IMPORTANTE*: NO uses este intent si el mensaje menciona "envía", "manda", "pasa a todos", "notifica", "a los de", "código", "gmail", "correo" o "verificación", ya que eso indica un broadcast o la búsqueda de un código de acceso temporal.
    - "dormir_bot": El jefe quiere apagar las respuestas automáticas globales ("duérmete", "apágate").
    - "despertar_bot": El jefe quiere reactivar el bot globalmente ("despiértate", "actívate").
    - "programar_mensaje": El jefe quiere que el bot le envíe un mensaje a un cliente específico (ej: "dile a Juan...", "envía a 573...", "dile a este cliente..."). Puede ser programado para el futuro (ej: "a las 8 am", "mañana a las 10:30", "en 10 minutos") o puede ser inmediato (si no se especifica hora, el tiempo programado es null).
    - "desconocido": Consultas de códigos (menciona "código", "gmail", "correo", "2fa", "authenticator", "totp", "verificación"), consultas de datos, reportes, envíos masivos (broadcast), refinamientos de mensajes, o charla casual.
 
    Salida esperada JSON:
    {
      "intent": "confirmar_pago" | "confirm_action" | "liberar_bot" | "dame_cuenta" | "dormir_bot" | "despertar_bot" | "programar_mensaje" | "desconocido",
      "target_platform": string | null, // Ej: "Netflix", "HBO"
      "target_user": string | null, // Ej: "57304...", "Estefania Arias", o "este cliente"
      "message_text": string | null, // El contenido limpio del mensaje que el jefe quiere enviarle al cliente (sin el @bot dile a..., etc.)
      "scheduled_time": string | null, // La descripción del tiempo si la hay (ej: "8 am", "mañana a las 10:30", "en 10 minutos"), de lo contrario null
      "months": number | null // Si menciona duración para una confirmación
    }
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un analista de comandos administrativos. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    return { intent: "desconocido", target: null, months: null };
  }
}

/**
 * Genera un saludo de reactivación contextual ("Lectura Prematura").
 * Analiza el historial para llegar ayudando de una vez.
 */
async function generateReactivationResponse(chatHistory) {
  let promptTemplate = `Eres el Asistente Virtual de Sheerit Store. Acabas de ser RE-ACTIVADO por un administrador en este chat.
Tu objetivo es saludar al cliente amablemente y addressar (abordar) de inmediato lo último que estaba preguntando o reportando mientras tú estabas silenciado.

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

INSTRUCCIONES:
1. Saluda cordialmente (Ej: "¡Hola! He vuelto para ayudarte...").
2. Menciona que un asesor te pidió retomar la atención.
3. Analiza los mensajes del CLIENTE en el historial:
   - Si preguntó por precios, dale una pincelada de lo que buscaba.
   - Si reportó una falla, dile que ya estás revisando su caso.
   - Si pidió credenciales, dile que ya puedes entregárselas (y recuérdale que use el número 2).
4. Sé conciso y empático. No repitas todo el historial, solo demuestra que lo "leíste" y estás listo para ayudar.
5. Usa emojis amigables 🤖.

Responde solo con el texto del mensaje para el cliente.`;

  try {
    const { pool } = require('./database');
    const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "reactivation_prompt"');
    if (rows && rows.length > 0) {
      promptTemplate = rows[0].cfg_value;
    }
  } catch (err) {
    console.warn("[aiService] Error al leer reactivation_prompt de la base de datos:", err.message);
  }

  const prompt = promptTemplate.replace('{{CHAT_HISTORY}}', chatHistory);

  try {
    return await callDeepSeek(prompt, "Eres un asistente de atención al cliente empático y eficiente.", false);
  } catch (error) {
    return "🤖 ¡Hola! He vuelto para ayudarte. Un asesor me ha pedido retomar la atención automática en este chat. ¿En qué puedo ayudarte hoy?";
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
 * Resume la base de conocimientos de soporte técnico.
 */
function summarizeSupportKnowledge(supportData) {
  if (!supportData || supportData.length === 0) return "No hay guías de soporte técnico disponibles.";
  return supportData.map(plat => {
    let text = `PROBLEMAS CON ${plat.name.toUpperCase()}:\n`;
    plat.issues.forEach(issue => {
      text += `- Título: ${issue.title}\n`;
      text += `  Pasos de solución:\n`;
      issue.steps.forEach((step, i) => {
        text += `    ${i + 1}. ${step.text}\n`;
      });
    });
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
    let attempts = 4; // Increment to 4 to allow key rotation to happen within attempts
    let delay = 1000;
    
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const activeKey = getActiveGeminiKey();
      if (!activeKey) {
        throw new Error("No hay claves de Gemini configuradas en el archivo .env");
      }

      try {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
        const response = await fetch(`${API_URL}?key=${activeKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        // 429 Quota or 5xx temporary errors
        if (response.status === 429 || response.status === 503 || response.status === 502 || response.status === 504) {
          console.warn(`⚠️ [Gemini API] Error ${response.status} en intento ${attempt}/${attempts}. Rotando API Key...`);
          rotateGeminiKey();
          await new Promise(r => setTimeout(r, delay));
          delay *= 2;
          continue;
        }

        // If the key is blocked or auth fails (400/403/401)
        if (response.status === 400 || response.status === 403 || response.status === 401) {
          const errText = await response.text();
          console.warn(`⚠️ [Gemini API] Error de autenticación/clave ${response.status} en intento ${attempt}/${attempts}. Rotando API Key... Detalle: ${errText}`);
          rotateGeminiKey();
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (response.status === 404) {
          console.warn(`⚠️ Model ${modelName} not found (404). Trying next model...`);
          break;
        }

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Gemini API Error (${modelName}): ${response.status} - ${errText}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          return isJson ? "{}" : "";
        }

        return text;

      } catch (err) {
        console.warn(`⚠️ [Gemini API] Error de red en intento ${attempt}/${attempts}: ${err.message}. Rotando clave...`);
        rotateGeminiKey();
        if (attempt === attempts) {
          if (modelName === MODELS[MODELS.length - 1]) {
            throw err;
          }
        }
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      }
    }
  }

  throw new Error("No se pudo obtener respuesta de Gemini tras intentar con todos los modelos y claves disponibles.");
}

/**
 * Realiza una llamada a la API de DeepSeek para razonamiento y respuestas de texto.
 * Compatible con el formato de la API de OpenAI Chat Completions.
 */
async function callDeepSeek(prompt, systemInstruction = "Eres un asistente de soporte y ventas amable y profesional de Sheerit, un servicio de cuentas de streaming. Tu tono es servicial, claro y directo. Siempre buscas ayudar al cliente a completar su compra o resolver su duda.", isJson = true) {
  if (!DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is missing in .env");
    throw new Error("DEEPSEEK_API_KEY not configured");
  }

  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: prompt }
  ];

  const payload = {
    model: "deepseek-chat",
    messages: messages,
    temperature: 0.1
  };

  if (isJson) {
    payload.response_format = { type: "json_object" };
  }

  const API_URL = `${DEEPSEEK_API_BASE.replace(/\/$/, '')}/chat/completions`;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API Error: ${response.status} ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      return isJson ? "{}" : "";
    }

    return text;
  } catch (error) {
    console.error("Error in callDeepSeek:", error.message);
    console.warn("⚠️ DeepSeek failed. Falling back to Gemini as backup...");
    try {
      return await callGemini(prompt, systemInstruction, isJson);
    } catch (fallbackError) {
      console.error("❌ Gemini fallback also failed:", fallbackError.message);
      throw fallbackError;
    }
  }
}

/**
 * Utiliza Gemini para describir un comprobante de pago/imagen.
 * @param {object} mediaData
 * @returns {Promise<string>} La descripción de la imagen.
 */
async function describeImageWithGemini(mediaData) {
  const prompt = `Analiza detalladamente esta imagen. Puede ser un comprobante de pago, una captura de pantalla de un inicio de sesión/2FA, un mensaje de error o una consulta.

Realiza una extracción precisa (OCR) y describe detalladamente lo que se ve en la imagen:

1. Si es un COMPROBANTE DE PAGO o transferencia:
   - Extrae el nombre del banco (Nequi, Daviplata, Bancolombia, etc.).
   - Extrae el monto de la transacción, fecha, hora y número de referencia/transacción.
   - Detalla el nombre del remitente y del destinatario, y el estado (exitoso, rechazado, pendiente).

2. Si es una pantalla de INICIO DE SESIÓN, CÓDIGO DE ACCESO o 2FA:
   - Identifica claramente la plataforma (Netflix, Disney+, Max/HBO, Prime Video, Spotify, ChatGPT, etc.).
   - Extrae el correo o usuario mostrado en pantalla al que se envió el código (ej: "Hurkjua6554@outlook.com").
   - Especifica qué solicita la pantalla (ej: "Código de 6 dígitos que vencerá en 15 minutos", "Código de hogar", etc.).

3. Si es una pantalla de ERROR o falla técnica:
   - Transcribe textualmente el mensaje de error o aviso que aparece (ej: "Contraseña incorrecta", "Demasiados dispositivos", "Tu suscripción ha expirado", "Este dispositivo no forma parte de tu hogar").
   - Detalla el contexto técnico del error para que podamos identificar cómo solucionarlo.

Sé sumamente descriptivo y preciso. Transcribe textualmente los textos importantes. No inventes datos.`;

  return await callGemini(prompt, "Eres un analista de imágenes y lector OCR extremadamente preciso, capaz de procesar recibos de pago, pantallas de error y solicitudes de acceso/2FA.", false, mediaData);
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
      "subscriptionType": "mensual" | "trimestral" | "semestral" | "anual", // "mensual" por defecto.
      "empathyGreeting": string | null // Un saludo empático y MUY PERSUASIVO. Si el cliente pregunta por disponibilidad inmediata, dile que "Sí, tengo stock para entrega inmediata y yo mismo (el bot) puedo validar tu pago en segundos si usas el QR".
    }
    
    Reglas:
    - **REGLA DE ORO:** NO inventes productos. Si el usuario solo dice "Hola", "Buenas", o mensajes de saludo, "items" debe ser [].
    - **RELEVANCIA TEMPORAL:** Analiza las fechas y horas en el [Historial reciente]. Si hubo un pedido hace mucho tiempo (ej: más de 24 horas) y el usuario hoy solo envía un saludo inicial, usa el sentido común: lo más probable es que ese pedido ya no sea relevante. No lo incluyas en "items" a menos que el usuario lo mencione o confirme hoy.
    - **Hogar Netflix**: Si el problema es de "Hogar", indica que el bot puede intentar obtener el **enlace de actualización** o código de viaje directamente si el usuario lo solicita. No lo inventes. 🔗
    - **Precios**: Consulta siempre platforms.json. 🏷️
    - **Protocolo**: Si no hay datos claros, solicita la foto del error. 📸
    - Solo agrega plataformas si el mensaje actual ("${messageContent}") las menciona explícitamente o si el historial reciente indica una continuación lógica inmediata.
    - Normaliza los nombres de planes y plataformas (ej. "Netflix - Básico" -> platform: "Netflix", plan: "Básico").
    - **REGLA CRÍTICA PARA MICROSOFT:** 
        * Si el usuario dice "Microsoft" o "Office" a secas (sin la palabra "compartida"), el plan es "Personal".
        * Si el usuario dice explícitamente "Microsoft compartida" o "Microsoft 365 compartida", el plan es "Compartida".
    - **REGLA CRÍTICA PARA GEMINI:** 
        * Si el usuario dice "Gemini" o "Gemini Pro" a secas (sin la palabra "compartida"), el plan es "Correo Propio".
        * Si el usuario dice explícitamente "Gemini compartida", el plan es "Compartida".
    - **REGLA CRÍTICA PARA APPLE:** 
        * Si el usuario dice "Apple one", el plan es "Apple One (345GB)".
        * Si el usuario dice "Apple tv", el plan es "Apple TV+".
    - **REGLA CRÍTICA PARA SPOTIFY:** 
        * Si el usuario dice "Spotify" a secas o "cuenta de spotify", el plan es "Cuenta Nueva o Renovación".
        * Si menciona "en mi correo", "personal", "mi cuenta" o "activación", el plan es "Personal (Tu Correo)".
    - Si no se especifica plan para otras plataformas, pon null en "plan".
    - Si detectas "ChatGPT", normalizalo como platform: "ChatGPT".
    - Revisa las fechas/horas en el contexto. Si ha pasado mucho tiempo (varias horas o 1 día) entre el último mensaje del usuario y la respuesta (Hora actual del sistema), genera un breve "empathyGreeting". Si no hay demora significativa, déjalo en null.
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un asistente que extrae datos estructurados de pedidos.", true);
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
    Opciones válidas: "nequi", "daviplata", "bancolombia", "banco caja social", "transfiya", "llave", "qr negocios".
    
    Salida esperada JSON:
    {
        "method": "nombre_metodo" | null
    }
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un clasificador de métodos de pago. Responde solo con JSON.", true);
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
function formatVencimientoDate(venceVal) {
  if (!venceVal) return "N/A";
  const strVal = venceVal.toString().trim();
  if (!isNaN(parseFloat(strVal))) {
    const jsDate = getJsDateFromExcel(parseFloat(strVal));
    if (jsDate) {
      return jsDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    }
  }
  
  if (typeof venceVal === 'string') {
      // Intentar limpiar espacios residuales
      const cleanVal = venceVal.trim();
      const parsed = new Date(cleanVal.includes('T') ? cleanVal : cleanVal + 'T12:00:00');
      if (!isNaN(parsed.getTime())) {
          return parsed.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
      }
  }
  return venceVal;
}

/**
 * Generates a text summary of the user's accounts for prompt context.
 */
function summarizeAccounts(userAccounts) {
  if (!userAccounts || userAccounts.length === 0) return "El usuario NO tiene servicios activos registrados.";

  return userAccounts.map(acc => {
    const { streamingName, correo, clave } = getMaskedAccessData(acc);
    const vence = formatVencimientoDate(acc.deben || acc.vencimiento);
    return `- ${streamingName} (Usuario/Correo de acceso: ${correo}) - Vence: ${vence} - Contraseña/Método: ${clave}`;
  }).join("\n");
}

async function generateCredentialsResponse(userAccounts, userMessage = "", chatHistory = "") {
  let cuentasTexto = "";
  if (!userAccounts || userAccounts.length === 0) {
    cuentasTexto = "El usuario no tiene cuentas activas en este momento o no encontramos registros asociados a su número.";
  } else {
    userAccounts.forEach(acc => {
      const { streamingName, correo, clave } = getMaskedAccessData(acc);

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
        compareDate.setHours(0, 0, 0, 0);

        // Si la fecha de vencimiento es HOY o anterior, se considera vencida
        if (compareDate.getTime() <= today.getTime()) {
          isExpired = true;
        }
      } else if (acc.vencimiento) {
        fechaVencimiento = acc.vencimiento;
      }

      let displayClave = clave;
      if (isExpired) {
        displayClave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
      }

      cuentasTexto += `- Plataforma: ${streamingName}\n  Correo: ${correo}\n  Clave: ${displayClave}\n  Perfil/PIN: ${perfilCompleto}\n  Vencimiento: ${fechaVencimiento}\n\n`;
    });

    if (cuentasTexto === "") {
      cuentasTexto = "El usuario no tiene cuentas activas o mostradas en este momento.";
    }
  }

  const { getActiveIncidentsText, getSpecificAccountsIncidentsText } = require('./availabilityService');
  const activeIncidents = getActiveIncidentsText();
  const specificAccountIncidents = getSpecificAccountsIncidentsText(userAccounts);

  let credentialsListText = cuentasTexto;
  if (activeIncidents) {
    credentialsListText += `\nALERTAS DE INCIDENTES / FALLAS ACTIVAS EN ESTE MOMENTO:\n${activeIncidents}\n(IMPORTANTE: Si el cliente tiene alguno de estos servicios o tiene problemas con ellos, infórmale de inmediato sobre esta falla general / incidente con amabilidad para que no se preocupe, y pídele que por favor tenga paciencia mientras lo resolvemos. No le ocultes la información, sé directo pero empático).\n`;
  }
  if (specificAccountIncidents) {
    credentialsListText += `\nALERTAS ESPECÍFICAS DE LAS CUENTAS DE ESTE CLIENTE:\n${specificAccountIncidents}\n(IMPORTANTE: Si la cuenta específica del cliente tiene un reporte / advertencia, infórmale inmediatamente con claridad para que entienda por qué no puede ingresar o qué ocurrió, y pídele paciencia mientras se resuelve).\n`;
  }

  let promptTemplate = `Eres un agente humano y empático de servicio al cliente de "Sheerit".
Un cliente nos ha pedido revisar sus credenciales de streaming.

Aquí están los datos de sus plataformas:
{{CREDENTIALS_LIST}}

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

MENSAJE DEL CLIENTE:
"{{MESSAGE_CONTENT}}"

INSTRUCCIONES:
1. Si el cliente tiene una duda específica (ej: "¿cambió la clave?", "¿cuál es mi pin?", "no puedo entrar"), RESPÓNDELA directamente usando los datos arriba.
2. Luego de responder la duda, entrega la información de sus cuentas de forma amable, clara y amigable.

⚠️ REGLAS CRÍTICAS:
1. Muestra SIEMPRE el Correo, la Clave y el Perfil/PIN para CADA cuenta de la lista. NUNCA resumas u omitas esta información.
2. **PROHIBIDO INVENTAR / ALUCINAR**: Transcribe EXACTAMENTE el Correo, la Clave y el Perfil proporcionados en la lista de arriba. Queda estrictamente prohibido inventar correos ficticios, nombres de usuario o contraseñas. Si el usuario te pide credenciales de una plataforma que NO está en la lista de arriba (por ejemplo, si pide Paramount+ pero en la lista solo hay YouTube), dile de forma muy amable que en este momento no encuentras esa plataforma activa en su registro y pídele esperar un momento a que un asesor humano la asigne o revise su caso. NUNCA inventes datos para plataformas ausentes. Si el dato dice "N/A" o está vacío, indícalo tal cual y pídele al usuario esperar a que el asesor lo asigne.
3. **IMPORTANTE (Cuentas Familiares/Extras)**: Si en los datos dice que la clave es "(Acceso por invitación/perfil propio)", explica amablemente al usuario que para ese servicio (ej. YouTube, Microsoft, Netflix Extra) no se usa una clave compartida, sino que él accede con su propio correo o mediante una invitación que le llegará.
4. Si la cuenta está vencida, mantén el aviso de que la clave está oculta por seguridad.
5. Si la lista está vacía, infórmale con tacto que no encontramos cuentas activas a su número.
6. **IGNORAR CONTEXTO INCORRECTO DEL HISTORIAL**: Si en el historial de chat o en los mensajes anteriores el bot o el usuario mencionaron por error otra plataforma o una contraseña que falló (ej: si el bot o el usuario hablaron de una clave incorrecta como 'Gomez15435' o mencionaron por error 'Netflix'), IGNORA por completo esa información. Concéntrate exclusivamente en las plataformas y claves reales especificadas en la sección 'Aquí están los datos de sus plataformas' de arriba. Nunca repitas contraseñas del historial que el cliente reportó como incorrectas, ni asumas plataformas que no están registradas.
7. Al final de tu mensaje, incluye el emoji 🤖 para indicar que eres un asistente automatizado.

No incluyas saludos genéricos como "[Tu Nombre]". Puedes despedirte en nombre del equipo de Sheerit.`;

  try {
    const { pool } = require('./database');
    const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "credentials_delivery_prompt"');
    if (rows && rows.length > 0) {
      promptTemplate = rows[0].cfg_value;
    }
  } catch (err) {
    console.warn("[aiService] Error al leer credentials_delivery_prompt de la base de datos:", err.message);
  }

  const prompt = promptTemplate
    .replace('{{CREDENTIALS_LIST}}', credentialsListText)
    .replace('{{CHAT_HISTORY}}', chatHistory)
    .replace('{{MESSAGE_CONTENT}}', userMessage);

  try {
    const responseText = await callDeepSeek(prompt, "Eres un asesor de servicio al cliente en WhatsApp para Sheerit. Escribe de forma humana, directa y empática.", false);
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
    const { streamingName, isFamily, correo, clave, customerMail } = getMaskedAccessData(acc);

    const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
    const perfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "N/A";

    const isSpotify = streamingName.toLowerCase().includes('spotify');

    const labelPin = isSpotify ? "DIRECCIÓN/LINK" : "PIN";
    const perfilDisplay = pin ? `${perfil} - ${labelPin}: ${pin}` : perfil;

    let fechaVencimiento = "Fecha desconocida";
    let isExpired = false;

    if (acc.deben && !isNaN(parseFloat(acc.deben))) {
      const jsDate = getJsDateFromExcel(acc.deben);
      const day = jsDate.getDate();
      const monthMatch = jsDate.toLocaleDateString('es-ES', { month: 'long' });
      const month = monthMatch.charAt(0).toUpperCase() + monthMatch.slice(1);
      const year = jsDate.getFullYear();
      fechaVencimiento = `${day} de ${month} de ${year}`;

      const today = getTodayInBogota();
      const compareDate = new Date(jsDate);
      compareDate.setHours(0, 0, 0, 0);
      if (compareDate.getTime() <= today.getTime()) {
        isExpired = true;
      }
    } else if (acc.vencimiento) {
      fechaVencimiento = acc.vencimiento;
    }

    const isConcise = options.concise || (requestedPlatform && (requestedPlatform.includes('solo pin') || requestedPlatform.includes('unicamente pin')));

    if (isConcise) {
      let conciseMsg = `🚨 *ACTUALIZACIÓN ${streamingName}*\n\n📧 Cuenta: ${correo}`;
      if (!isFamily) conciseMsg += `\n🔑 Clave: ${isExpired ? '(Vencida)' : clave}`;
      if (pin) conciseMsg += `\n📍 ${labelPin}: ${pin}`;
      conciseMsg += `\n\nSi tienes inconvenientes, escribe "ayuda". 🤖`;
      formattedAccounts.push(conciseMsg);
      return;
    }

    if (isFamily) {
      const msgFamily = isExpired
        ? `⚠️ *SERVICIO VENCIDO*: Este servicio (${streamingName}) requiere renovación para seguir funcionando.`
        : `ℹ️ *NOTA*: Para este servicio, recibirás una invitación por correo o usarás tu perfil propio. La contraseña la manejas tú mismo. Un asesor te contactará si necesitas ayuda adicional.`;

      formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${correo}\nPERFIL: ${perfilDisplay}\n\n${msgFamily}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
      return;
    }

    let displayClave = clave;
    // LÓGICA YOPMAIL: Si el correo de cliente es yopmail, damos pasos de recuperación
    if (customerMail.toLowerCase().includes("@yopmail.com")) {
      displayClave = "(La configuras tú mismo siguiendo los pasos abajo)";
      const yopInstructions = `\n\n🔑 *PASOS PARA CONFIGURAR TU CLAVE:*\n1. Ve a www.yopmail.com\n2. Ingresa el correo: *${customerMail}*\n3. En la app de ${streamingName}, pide 'Olvidé mi contraseña' a ese correo.\n4. Revisa el código en Yopmail y activa tu cuenta. 📝`;
      formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${correo}\nCONTRASEÑA: ${displayClave}\nPERFIL: ${perfilDisplay}${yopInstructions}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
      return;
    }

    if (isExpired) {
      displayClave = "(OCULTA PORQUE LA CUENTA ESTÁ VENCIDA)";
    }

    formattedAccounts.push(`*${streamingName}*\n\nCORREO: ${correo}\nCONTRASEÑA: ${displayClave}\nPERFIL: ${perfilDisplay}\n\nEL SERVICIO VENCERÁ EL DÍA: ${fechaVencimiento}`);
  });

  return formattedAccounts.join('\n\n-------------------\n\n');
}

/**
 * Identifies the selected plan from a user's natural language message.
 * @param {string} messageContent 
 * @param {Array} availablePlans 
 * @returns {Promise<number|null>} The 1-based index of the plan or null.
 */
async function parsePlanSelection(messageContent, availablePlans, currentPlatformName = '', selectedItems = []) {
  const plansText = availablePlans.map((p, i) => {
    const details = p.characteristics ? p.characteristics.join(', ') : '';
    return `${i + 1}. ${p.name} ($${p.price}): ${details}`;
  }).join('\n');
  
  let cartText = "";
  if (selectedItems && selectedItems.length > 0) {
    cartText = "El usuario tiene en su combo/interés actual las siguientes plataformas:\n" + 
      selectedItems.map(item => {
        const planName = item.chosenPlan ? item.chosenPlan.name : "Plan por definir";
        const priceText = item.chosenPlan ? `($${item.chosenPlan.price})` : "";
        return `- ${item.platform.name}: ${planName} ${priceText}`;
      }).join('\n');
  }

  let promptTemplate = `El usuario está en el proceso de elegir un plan de la siguiente lista de opciones disponibles para la plataforma "{{PLATFORM_NAME}}":
{{PLANS_LIST}}

{{CART_LIST}}

El mensaje actual del usuario es: "{{MESSAGE_CONTENT}}"

Analiza la intención del usuario y clasifícala en uno de los siguientes sub-intents:
1. "plan_selection": El usuario está eligiendo o confirmando uno de los planes (ej. dice "la 1", "netflix 4k", "el de 17000" o escribe un número directamente).
2. "service_doubt_or_ignorance": El usuario tiene dudas sobre los servicios, precios, características, expresa desconocimiento, no entiende qué está eligiendo, o tiene confusión/inquietudes sobre cómo funciona su combo o si incluye otras plataformas del carrito (por ejemplo, si pregunta "¿Y paramount?", "¿Este plan incluye ambos?", "¿Qué diferencia hay?", "pero es que no entiendo", etc.).
3. "other": Cualquier otro tipo de mensaje.

Si el sub-intent es "service_doubt_or_ignorance", debes activar el ESPÍRITU DEL VENDEDOR:
- Escribe una respuesta comercial (salesReply) sumamente amable, persuasiva, vendedora y clara.
- Explica detalladamente y con paciencia qué plataformas están en su pedido y que primero estamos definiendo el plan de "{{PLATFORM_NAME}}".
- Resuelve la duda con base en las características y dile que al final sumaremos los servicios con un descuento por combo.

Salida esperada en formato JSON estricto:
{
    "subIntent": "plan_selection" | "service_doubt_or_ignorance" | "other",
    "salesReply": string | null, // Si subIntent es "service_doubt_or_ignorance", escribe la respuesta vendedora y aclaratoria detallada. En otro caso, null.
    "selectedIndex": number | null // Si subIntent es "plan_selection", indica el número de la opción elegida (1, 2, 3...) o null si no se entiende. En otro caso, null.
}`;

  try {
    const { pool } = require('./database');
    const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "plan_selection_prompt"');
    if (rows && rows.length > 0) {
      promptTemplate = rows[0].cfg_value;
    }
  } catch (dbErr) {
    console.warn("[aiService] Error querying plan_selection_prompt from database, using default.");
  }

  const prompt = promptTemplate
    .replace(/{{PLATFORM_NAME}}/g, currentPlatformName)
    .replace('{{PLANS_LIST}}', plansText)
    .replace('{{CART_LIST}}', cartText)
    .replace('{{MESSAGE_CONTENT}}', messageContent);

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un asistente de ventas de Sheerit que ayuda a resolver dudas de planes. Responde solo con JSON.", true);
    const result = JSON.parse(jsonString);
    return {
      selectedIndex: result.selectedIndex || null,
      isQuestion: result.subIntent === 'service_doubt_or_ignorance' || result.subIntent === 'other',
      salesReply: result.salesReply || null
    };
  } catch (error) {
    console.error("Error parsing plan selection:", error);
    return { selectedIndex: null, isQuestion: false, salesReply: null };
  }
}

/**
 * Determina si una imagen es un comprobante de pago de un banco (Nequi, Daviplata, Bancolombia, etc.)
 * @param {object} mediaData 
 * @param {string} chatHistory 
 * @returns {Promise<{isReceipt: boolean, amount: number|null, bank: string|null}>}
 */
async function isPaymentReceipt(mediaData, chatHistory = "") {
  if (!mediaData) return { isReceipt: false, amount: null, bank: null, destinationKey: null, destinationName: null };

  try {
    // 1. Pre-procesar la imagen con Gemini para extraer la descripción visual / OCR
    const imageDescription = await describeImageWithGemini(mediaData);

    // 2. Pasar la descripción a DeepSeek para la clasificación estructurada
    let promptTemplate = `Analiza la siguiente descripción textual de una imagen/comprobante y determina si corresponde a un COMPROBANTE DE PAGO, RECIBO DE TRANSFERENCIA o CAPTURA DE PANTALLA DE UNA TRANSACCIÓN EXITOSA.
Contexto de la charla: {{CHAT_HISTORY}}

DESCRIPCIÓN DE LA IMAGEN DE PAGO:
"""
{{IMAGE_DESCRIPTION}}
"""

Debes responder en formato JSON:
{
  "isReceipt": boolean, // true si la descripción detalla claramente un recibo de banco con una transferencia exitosa.
  "amount": number | null, // El valor EXACTO de la transferencia (solo números enteros) si es legible.
  "bank": string | null, // Nombre del banco o medio detectado (Nequi, Daviplata, Bancolombia, Bre-B, etc.)
  "confidence": number, // Confianza de que es un recibo real y válido (0 a 1)
  "destinationKey": string | null, // Número exacto de la llave, cuenta, CVU, o destino al que se envió el dinero. Ej: "0087387259", "300 123 4567", "esteban@nequi.com". Extráelo aunque aparezca parcial. MUY IMPORTANTE.
  "destinationName": string | null, // Nombre del destinatario/negocio si aparece en lugar de la llave. Ej: "SHEERIT ESTEBAN AVILA", "TIENDA EJEMPLO". Aparece frecuentemente en pagos por QR de Negocios.
  "extractedDetails": string | null, // Detalles extra como ID de transacción o fecha/hora.
  "inferredPlatform": string | null // ¿Qué plataforma está pagando según el historial? null si no es evidente.
}

Reglas:
- Solo marca isReceipt: true si indica una confirmación de envío/transferencia exitosa.
- Si indica ERROR, CUENTA SUSPENDIDA o fallo, marca isReceipt: false.
- Sé muy riguroso con 'amount'. Busca el valor de la transferencia, no montos secundarios.
- Para 'destinationKey': busca cualquier número que sea la cuenta, llave, Llave Bre-V, número de celular destino o alias al que se envió. Puede aparecer como "A la llave", "Cuenta destino", "Para", "Número", etc.`;

    try {
      const { pool } = require('./database');
      const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "payment_receipt_prompt"');
      if (rows && rows.length > 0) {
        promptTemplate = rows[0].cfg_value;
      }
    } catch (dbErr) {
      console.warn("[aiService] Error querying payment_receipt_prompt from database, using default.");
    }

    const prompt = promptTemplate
      .replace('{{CHAT_HISTORY}}', chatHistory)
      .replace('{{IMAGE_DESCRIPTION}}', imageDescription);

    const jsonString = await callDeepSeek(prompt, "Eres un validador de comprobantes de pago bancarios.", true);
    const result = JSON.parse(jsonString);
    console.log("[PAYMENT RECEIPT DEBUG] Resultado IA (DeepSeek + Gemini) Raw:", JSON.stringify(result, null, 2));

    let inferred = result.inferredPlatform || null;
    if (inferred) {
      const lower = inferred.toLowerCase();
      const forbidden = ['sheerit', 'esteban', 'avila', 'store', 'nequi', 'daviplata', 'bancolombia', 'transfiya', 'ahorros', 'corriente', 'transferencia', 'pago', 'comprobante'];
      if (forbidden.some(word => lower.includes(word))) {
        inferred = null;
      }
    }

    return {
      isReceipt: result.isReceipt && result.confidence > 0.7,
      amount: result.amount,
      bank: result.bank,
      destinationKey: result.destinationKey || null,
      destinationName: result.destinationName || null,
      inferredPlatform: inferred
    };
  } catch (error) {
    console.error("Error recognizing payment proof:", error);
    return { isReceipt: false, amount: null, bank: null, destinationKey: null, destinationName: null };
  }
}

async function generateEmpatheticFallback(messageContent, isMedia, chatHistory = "", mediaData = null, userAccounts = [], userId = null, userStates = null) {
  const trimmedMsg = (messageContent || "").trim();
  const isOnlySymbols = trimmedMsg.length > 0 && /^[?¿!¡\s\-_.,*#@]+$/.test(trimmedMsg);
  
  if (isOnlySymbols) {
    let namePrompt = "";
    if (userStates && userId) {
      const stateData = userStates.get(userId);
      if (stateData && stateData.nombre) {
        namePrompt = ` *${stateData.nombre}*`;
      }
    }
    return {
      replyMessage: `🤖 ¡Hola${namePrompt}! Veo que respondiste con signos de pregunta o símbolos.\n\n¿Me podrías detallar en qué consiste tu duda o consulta? O si lo prefieres, elige una opción escribiendo el número correspondiente:\n\n1️⃣ *Comprar cuenta nueva*\n2️⃣ *Revisar mis credenciales*\n3️⃣ *Pagar o renovar mis cuentas*\n4️⃣ *Soporte Técnico*\n5️⃣ *Hablar con un asesor*`,
      needsEscalation: false
    };
  }

  const accountSummary = summarizeAccounts(userAccounts);
  const platformDocs = await getPlatformKnowledge();
  const wisdomData = await getWisdomKnowledge();
  const supportDocs = await getSupportKnowledge();

  const platformContext = summarizePlatformKnowledge(platformDocs);
  const wisdomContext = summarizeWisdom(wisdomData);
  const supportContext = summarizeSupportKnowledge(supportDocs);

  const { getActiveIncidentsText, getSpecificAccountsIncidentsText } = require('./availabilityService');
  const activeIncidents = getActiveIncidentsText();
  const specificAccountIncidents = getSpecificAccountsIncidentsText(userAccounts);

  const { isSupportOpen, getSupportScheduleConfig, getQueuePosition } = require('./supportScheduleService');
  const supportStatus = await isSupportOpen();
  const queuePos = (userId && userStates) ? getQueuePosition(userId, userStates) : null;
  const supportScheduleConfig = getSupportScheduleConfig();

  const supportStatusText = `
ESTADO ACTUAL DEL SOPORTE HUMANO EN ESTE MOMENTO:
- Horario de Atención Asesores: Lunes a Viernes de ${supportScheduleConfig.weekday_start} a ${supportScheduleConfig.weekday_end}, Sábado y Domingo de ${supportScheduleConfig.weekend_start} a ${supportScheduleConfig.weekend_end}.
- Estado del Canal de Soporte Humano: ${supportStatus.open ? 'ONLINE / ABIERTO' : 'OFFLINE / CERRADO'}
- Contexto del Estado: ${supportStatus.reason}
- Mensaje Fuera de Horario: "${supportScheduleConfig.offline_message}"
${queuePos ? `- Turno actual del cliente en la cola de espera: #${queuePos}\n` : ''}

REGLAS DE ATENCIÓN DE SOPORTE HUMANO:
1. Si el cliente pide hablar con un asesor o requiere soporte que requiere escalamiento, y el soporte está OFFLINE/CERRADO, infórmale con amabilidad y calidez que en este momento no hay asesores activos, indicando el horario de soporte y pidiéndole que tenga paciencia, ya que su ticket fue guardado.
2. Si el soporte está ONLINE/ABIERTO y el cliente está en la cola, menciónale amablemente que ya tiene el turno #${queuePos || 'X'} en la cola y que un asesor lo atenderá muy pronto.
`;

  const template = await getSystemPromptTemplate();

  let paymentLines = [];
  try {
    const { getPaymentConfig } = require('./paymentConfigService');
    const config = getPaymentConfig();
    for (const [key, method] of Object.entries(config)) {
      if (method.enabled) {
        if (method.sub_methods) {
          const activeSubs = method.sub_methods.filter(s => s.enabled);
          activeSubs.forEach(sub => {
            paymentLines.push(`- ${method.label} (${sub.label}): Valor/Número \`${sub.value}\` (${sub.automatic ? 'AUTOMÁTICO ⚡' : 'VERIFICACIÓN MANUAL'})`);
          });
        } else {
          paymentLines.push(`- ${method.label}: ${method.description.replace(/\n/g, ' ')} (${method.automatic ? 'AUTOMÁTICO ⚡' : 'VERIFICACIÓN MANUAL'})`);
        }
      }
    }
  } catch (err) {
    console.error("Error building dynamic paymentContext for AI fallback:", err.message);
  }

  const paymentContext = `
MÉTODOS DE PAGO DE LA EMPRESA (Reales y Oficiales actualmente ACTIVOS):
${paymentLines.length > 0 ? paymentLines.join('\n') : '- QR de Negocios\n- Llave Bre-V: 0087387259'}

INSTRUCCIÓN DE SEGURIDAD ABSOLUTA:
Promociona ÚNICAMENTE los métodos de pago listados arriba que estén ACTIVOS. Queda estrictamente prohibido inventar o sugerir cualquier otro número de cuenta, método de pago o Llave que no esté explícitamente listado en la sección anterior.
`;

  let mediaDescription = "";
  if (isMedia && mediaData) {
    try {
      mediaDescription = await describeImageWithGemini(mediaData);
      
      if (mediaDescription) {
        const descLower = mediaDescription.toLowerCase();
        const isNetflixCodeScreen = (descLower.includes('ingresa el código') || descLower.includes('ingresar el código') || descLower.includes('código que enviamos') || descLower.includes('codigo que enviamos') || descLower.includes('enviamos a tu email') || descLower.includes('enviamos a tu correo')) && descLower.includes('netflix');
        if (isNetflixCodeScreen) {
          return {
            replyMessage: `🤖 *Tip de Inicio de Sesión de Netflix:* 💡\n\nVeo que tu pantalla te está solicitando un código enviado al correo.\n\n*No es necesario que esperes por un código.* Por favor realiza lo siguiente:\n\n1. Selecciona el botón **"Obtener ayuda"** (ubicado abajo a la izquierda en tu pantalla).\n2. Elige la opción **"Usar contraseña"**.\n3. Ingresa la contraseña de Netflix que te proporcionamos.\n\n¡De esta forma podrás iniciar sesión de inmediato sin esperar un código! 😊 🤖`,
            needsEscalation: false
          };
        }
      }
    } catch (e) {
      console.error("Error generating media description in fallback:", e);
    }
  }

  const prompt = template
    .replace('{{ASSISTANT_NAME}}', wisdomData?.company_info?.assistant_name || "Asistente")
    .replace('{{COMPANY_NAME}}', wisdomData?.company_info?.name || "Sheerit Store")
    .replace('{{WISDOM_CONTEXT}}', wisdomContext + "\n" + paymentContext + (activeIncidents ? "\n" + activeIncidents : "") + (specificAccountIncidents ? "\n" + specificAccountIncidents : "") + "\n" + supportStatusText)
    .replace('{{PLATFORM_CONTEXT}}', platformContext)
    .replace('{{SUPPORT_CONTEXT}}', supportContext)
    .replace('{{ACCOUNT_SUMMARY}}', accountSummary)
    .replace('{{CHAT_HISTORY}}', chatHistory)
    .replace('{{MESSAGE_CONTENT}}', messageContent)
    .replace('{{MEDIA_STATUS}}', isMedia ? `[El usuario envió una imagen/archivo. Descripción visual de la imagen extraída por OCR: ${mediaDescription}]` : "");

  try {
    const response = await callDeepSeek(prompt, "Eres un asesor de ventas empático y experto. Responde de forma humana y servicial.", false);
    let replyText = response.trim();
    if (!replyText.includes('🤖')) {
      replyText += ' 🤖';
    }

    let needsEscalation = false;
    if (replyText.includes('[ESCALAR]')) {
      needsEscalation = true;
      replyText = replyText.replace('[ESCALAR]', '').trim();
      // Ensure the bot icon 🤖 is still appended nicely at the end if we stripped it
      if (!replyText.includes('🤖')) {
        replyText += ' 🤖';
      }
    }

    return {
      replyMessage: replyText,
      needsEscalation: needsEscalation
    };
  } catch (error) {
    console.error("Error in generateEmpatheticFallback:", error);
    return {
      replyMessage: "¡Hola! He notificado a tu asesor para que te ayude con este caso específico. Dame unos minutos. 🤖",
      needsEscalation: true
    };
  }
}

async function detectInitialIntent(messageContent, chatHistory = "", mediaData = null, userAccounts = []) {
  const accountSummary = summarizeAccounts(userAccounts);
  const platformDocs = await getPlatformKnowledge();
  const platformContext = summarizePlatformKnowledge(platformDocs);

  let mediaDescription = "";
  if (mediaData) {
    try {
      mediaDescription = await describeImageWithGemini(mediaData);
    } catch (e) {
      console.error("Error generating media description in detectInitialIntent:", e);
    }
  }

  let promptTemplate = `Analiza el primer mensaje del usuario para identificar qué desea hacer.

{{MEDIA_DESCRIPTION}}

GUÍA DE FUNCIONAMIENTO DE PLATAFORMAS:
{{PLATFORM_CONTEXT}}

INFORMACIÓN DEL CLIENTE (Servicios actuales):
{{ACCOUNT_SUMMARY}}

Contexto previo: {{CHAT_HISTORY}}
Mensaje actual: "{{MESSAGE_CONTENT}}"

Categorías para "intent":
- "comprar": El usuario quiere adquirir un servicio nuevo o pregunta por disponibilidad/precios de algo que NO tiene.
  *IMPORTANTE*: Si el usuario solicita, pide o pregunta por una plataforma que YA TIENE contratada (según la INFORMACIÓN DEL CLIENTE), clasifícalo SIEMPRE como "renovar", incluso si usa palabras como "adquirir", "comprar", "quiero", "necesito", etc. Solo usa "comprar" si es para una plataforma que no tiene en su resumen de servicios.
  *IMPORTANTE*: Si el usuario pregunta "¿tienes disponible?", "¿entregas ya?", "¿qué tienes para entrega inmediata?", clasifícalo como "comprar" con frustración 0 y genera un mensaje que invite a la venta con total confianza.
- "credenciales": El usuario solicita las credenciales (correo/contraseña) de su cuenta actual, reporta explícitamente "la contraseña no corresponde", "clave incorrecta", pide recordar su pin de acceso, o pregunta cuándo se vence / fecha de vencimiento / fecha de pago de su cuenta actual.
- "renovar": El usuario quiere pagar, renovar o pregunta el costo de un servicio que YA TIENE contratado.
- "pagar": El usuario pregunta cómo pagar o envía un comprobante.
- "soporte": Problemas técnicos, fallas de conexión, errores en el cobro, perfiles caídos, o si pide explícitamente hablar con un humano/asesor. (NO usar si es explícitamente un error de clave).
- "cierre": El usuario se despide, da las gracias, confirma fin de charla o da un cierre natural (ej: "ok", "listo", "gracias", "vale", "chao", "adiós").
- "cancelar": El usuario manifiesta EXPRESAMENTE que no quiere renovar, que quiere cancelar el servicio o pide la baja.
- "duda_contexto": El usuario tiene dudas o realiza preguntas sobre información recién discutida en el chat actual (por ejemplo: qué significa "manual", de quién es la cuenta de Nequi/Daviplata, cómo proceder, etc.) o realiza preguntas de consulta sobre características de las plataformas, precios de planes o detalles técnicos específicos que funcionan como un paréntesis en la charla actual.
- "desconocido": Cualquier otro mensaje, incluyendo saludos iniciales sin petición específica.

Regla de Intents (MÁXIMA PRIORIDAD):
1. **MENÚ NUMÉRICO:** Si el mensaje es exactamente "1", "2", "3", "4" o "5", clasifícalo según el menú: "1"->comprar, "2"->credenciales, "3"->renovar, "4"->soporte, "5"->soporte.
2. **CONTINUIDAD:** Si es una respuesta corta ("sí", "nequi") a una pregunta previa, usa el intent de esa charla.
3. **STOCK:** Si pregunta por "disponibilidad", "stock", "entrega ya", el intent es "comprar".
4. **SOPORTE:** PRIORIDAD si hay errores o fallas.
5. **PAGAR:** Si pregunta cómo pagar o envía comprobante.

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
3. En este caso de continuación directa de una charla humana (donde el humano acaba de preguntar algo hace poco), puedes devolver "recoveredState": "waiting_human" para no estorbar. Sin embargo, si el usuario reporta una falla técnica clara, prioriza ayudarlo si el humano no ha respondido en más de 20-30 minutos.
4. Si el bot 🤖 estaba a la mitad de un flujo (ej: esperando método de pago) y el cliente responde a eso, recupera el estado correspondiente. ¡El contexto manda!
5. **RELEVANCIA TEMPORAL Y REANUDACIÓN:** 
   - Si han pasado más de 2 horas (compara la hora actual del sistema vs la del historial) desde el último mensaje del "Asistente" humano, NO devuelvas "waiting_human" a menos que el usuario esté respondiendo a una pregunta muy específica que aún tenga sentido. 
   - Si el "Mensaje actual" es una queja técnica clara (intent: "soporte" o "credenciales") y han pasado más de 30 minutos desde la última intervención humana, el bot DEBE retomar la ayuda si tiene la respuesta técnica. No dejes al cliente esperando si el humano ya no está activamente en el chat.
   - Si el mensaje del humano fue solo un "gracias", "listo" o un cierre, no bloquees el bot para futuras dudas del usuario.

Salida esperada JSON:
{
    "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "cierre" | "catalogo" | "duda_contexto" | "desconocido",
    "recoveredState": string | null,
    "frustrationLevel": number,
    "userName": string | null,
    "isNameComplete": boolean,
    "detectedPlatform": string | null, 
    "explanation": string | null,
    "metadata": {
        "duration_months": number | null,
        "is2faScreen": boolean | null
    } | null 
}

En "explanation", escribe una breve explicación en español del contenido de la imagen (OCR, textos principales, errores detectados, códigos) o del mensaje del usuario.
Si el mensaje actual es una imagen o el texto menciona un pago, revisa si es un comprobante. Si lo es, pon intent: "pagar".
Si la imagen muestra una PANTALLA DE INICIO DE SESIÓN pidiendo un CÓDIGO DE VERIFICACIÓN (2FA, código enviado al correo/teléfono), pon intent: "soporte" (para que el bot asista con el código o lo derive al humano).`;

  try {
    const { pool } = require('./database');
    const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = "initial_intent_prompt"');
    if (rows && rows.length > 0) {
      promptTemplate = rows[0].cfg_value;
    }
  } catch (err) {
    console.warn("[aiService] Error al leer initial_intent_prompt de la base de datos:", err.message);
  }

  const mediaSection = mediaDescription ? `DESCRIPCIÓN DE LA IMAGEN ENVIADA POR EL USUARIO (OCR/VISIÓN): \n"""\n${mediaDescription}\n"""\n` : "";
  const prompt = promptTemplate
    .replace('{{MEDIA_DESCRIPTION}}', mediaSection)
    .replace('{{PLATFORM_CONTEXT}}', platformContext)
    .replace('{{ACCOUNT_SUMMARY}}', accountSummary)
    .replace('{{CHAT_HISTORY}}', chatHistory)
    .replace('{{MESSAGE_CONTENT}}', messageContent);

  // --- FALLBACK BASADO EN PALABRAS CLAVE (Ante fallos de IA) ---
  const txt = (messageContent || "").toLowerCase();
  let keywordIntent = null;

  if (txt.includes("comprobante") || txt.includes("pagué") || txt.includes("pagado") || txt.includes("captura") || txt.includes("transferencia")) {
    keywordIntent = "pagar";
  } else if (txt.includes("cuando se vence") || txt.includes("cuándo se vence") || txt.includes("cuando vence") || txt.includes("cuándo vence") || txt.includes("fecha de vencimiento") || txt.includes("fecha de pago")) {
    keywordIntent = "credenciales";
  } else if (txt.includes("vence") || txt.includes("cuanto") || txt.includes("cuánto") || txt.includes("debo") || txt.includes("valor")) {
    keywordIntent = "pagar"; // En este bot pagar/cobros es la opción 3
  } else if (txt.includes("clave") || txt.includes("correo") || txt.includes("entrar") || txt.includes("funciona") || txt.includes("fallando") || txt.includes("codigo") || txt.includes("código") || txt.includes("verificacion") || txt.includes("verificación") || txt.includes("digitos") || txt.includes("dígitos")) {
    keywordIntent = "credenciales";
  } else if (txt.includes("precio") || txt.includes("catalogo") || txt.includes("catálogo") || txt.includes("planes")) {
    keywordIntent = "catalogo";
  } else if (txt === "1") keywordIntent = "comprar";
  else if (txt === "2") keywordIntent = "credenciales";
  else if (txt === "3") keywordIntent = "pagar";
  else if (txt === "4" || txt === "5") keywordIntent = "soporte";

  // Prioridad absoluta a palabras clave muy específicas ante la clasificación de la IA
  const isCodeRequest = txt.includes("codigo") || txt.includes("código") || txt.includes("verificacion") || txt.includes("verificación");

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un clasificador de intenciones experto. Responde solo con JSON.", true);
    const parsed = JSON.parse(jsonString);

    if (parsed && parsed.detectedPlatform) {
      const lowerPlat = parsed.detectedPlatform.toLowerCase();
      const forbidden = ['sheerit', 'esteban', 'avila', 'store'];
      if (forbidden.some(word => lowerPlat.includes(word))) {
        parsed.detectedPlatform = null;
      }
    }

    // Si la IA devuelve desconocido pero tenemos un keywordIntent, lo usamos
    if (parsed.intent === "desconocido" && keywordIntent) {
      parsed.intent = keywordIntent;
    }

    // Prioridad absoluta para códigos de verificación
    if (isCodeRequest) {
      parsed.intent = "credenciales";
    }

    // Log debug explícito para afinar el prompt:
    console.log('\n--- [AI INTENT DEBUG] ---');
    console.log('Mensaje actual:', messageContent);
    console.log('Resultado IA:', JSON.stringify(parsed, null, 2));
    console.log('-------------------------\n');

    return { ...parsed, mediaDescription: mediaDescription || null };
  } catch (error) {
    console.error("Error detecting initial intent (DeepSeek fail):", error.message);

    // Devolvemos el intent detectado por palabras clave si la IA falló
    return {
      intent: keywordIntent || "desconocido",
      recoveredState: null,
      frustrationLevel: 0,
      userName: null,
      isNameComplete: false,
      detectedPlatform: null,
      metadata: null,
      mediaDescription: mediaDescription || null
    };
  }
}

/**
 * Analiza una consulta en lenguaje natural del administrador y extrae parámetros de búsqueda.
 * @param {string} query 
 * @returns {Promise<Object>} { action: string, filters: { name, platform, status, generic_search } }
 */
async function parseAdminQueryIntent(query, previousContext = "") {
  const prompt = `
    Eres un asistente analítico experto en extraer parámetros de búsqueda sobre una base de datos de streaming.
    
    ${previousContext ? "CONTEXTO PREVIO:\n" + previousContext + "\n" : ""}

    El administrador te ha pedido la siguiente consulta en lenguaje natural: "${query}"

    Salida esperada usando estricto JSON:
    {
      "action": "search_customer" | "get_available" | "check_history" | "summary_stats" | "liberate_user" | "broadcast_credentials" | "confirm_action" | "auto_cobros" | "list_functions" | "update_data" | "record_sale" | "get_gmail_code" | "get_totp_code" | "general_query",
      "filters": {
        "name": string | null, // Nombre de la persona o nombre específico de la cuenta/correo (ej: "sheerit102")
        "platform": string | null,
        "status": "libre" | "ocupado" | "vencido" | null,
        "phone": string | null,
        "generic_search": string | null, // Contexto adicional o destinatario masivo (ej: "todos los de spotify")
        "new_password": string | null,
        "custom_message": string | null,
        "only_fields": string[] | null,
        "target_field": string | null,
        "new_value": string | null,
        "exclude_keyword": string | null, // Si pide "descarta los extra", "quita los de disney", etc.
        "only_active": boolean // Si pide "solo los que no estén vencidos", "solo activos", "vigentes", etc.
      }
    }

    Regla de Refinamiento (IMPORTANTE):
    - Si hay un CONTEXTO PREVIO, úsalo para rellenar los filtros que falten en el mensaje actual. 
    - Por ejemplo, si se está preparando un envío masivo para "sheeritsbox@gmail.com" y el admin dice "descarta los extra", el JSON debe mantener 'action': "broadcast_credentials", 'name': "sheeritsbox@gmail.com" (extraído del contexto) y 'exclude_keyword': "extra".
    - Si el admin dice "solo los activos" o "solo los no vencidos", pon 'only_active': true.
    - Si el admin dice "cambia el mensaje a...", extrae el nuevo 'custom_message'.

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
    - Si pide "atiende a...", "libera a...", "atender el pendiente de...", "encárgate de...", "ayúdame a explicar", "explícale", "contéstale", es "liberate_user".
    - Si pide "qué acabaste de hacer", "qué pasó", "dame detalles de la última acción", "por qué se envió eso", es "explain_last_action". (NO usar para peticiones de ayuda con clientes).
    - Si pide "dame el código de...", "llegó correo de...", "busca el link de...", "que dice el gmail de...", es "get_gmail_code".
    - Si pide "dame el código 2fa de...", "dame the authenticator de...", "codigo de gpt de...", "codigo totp de...", es "get_totp_code".
    - Si no encaja, usa "general_query".

    Reglas de 'filters':
    - 'name': Extrae el nombre explícito que el admin busca (ej: "busca a laura fonseca" -> "laura fonseca"). Ignora palabras como "busca a", "dame la cuenta de".
    - 'target_field': Si es una actualización, identifica qué columna quiere cambiar (ej: "nombre", "correo", "clave", "vencimiento").
    - 'new_value': El nuevo valor que se debe escribir (ej: "laura bonita", "juan@gmail.com").
    - 'generic_search': Si el admin busca por cuenta/correo pero no está claro si es nombre o correo, ponlo aquí, pero NUNCA incluyas el nombre de la plataforma en este campo. Extrae SOLO la palabra clave o prefijo del correo (ej: "los de sheerit08 de disney" -> extrae solo "sheerit08"). También usa este campo para el destinatario de un broadcast.
    - 'custom_message': Si el admin pide enviar un broadcast, extrae el MENSAJE EXACTO que el bot debe enviar. Si el admin pone el mensaje entre comillas ("" o ''), DEBES extraer únicamente el texto literal que está dentro de las comillas sin alterarlo.
    - 'only_fields': Si el admin especifica qué partes de las credenciales enviar (ej: "solo la contraseña", "únicamente el pin", "no mandes el correo, solo clave y perfil", "pasa solo el vencimiento"), llena este arreglo con las palabras clave ("clave", "contraseña", "pin", "pin perfil", "perfil", "vencimiento", "fecha", "deben"). Si debe enviar todo, déjalo null o vacío.
  `;
  try {
    const jsonString = await callDeepSeek(prompt, "Eres un extractor de parámetros para consultas de base de datos JSON.", true);
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
    - **IMPORTANTE (Mensajes del Sistema)**: Si el JSON contiene un campo "message" (especialmente si "status" es "error" o "success"), tu respuesta debe basarse y comunicar clara y literalmente la información de ese campo "message". NO la reemplaces por frases genéricas.
    - **IMPORTANTE (Confirmación)**: Si el JSON tiene status "pending_confirmation", informa al administrador que se han encontrado coincidencias (especifica cuántas y para qué cuenta). Pregúntale explícitamente si desea proceder con el envío. **Debes aclarar si el envío incluye la actualización de credenciales (correo/clave) o si es solo un mensaje personalizado.** Lista los perfiles involucrados. Usa la terminología exacta del JSON para referirte a los campos.
    - **IMPORTANTE (Sugerencia)**: Si el JSON tiene status "suggestion", explica amistosamente que no encontraste el correo en la plataforma pedida, pero sí en otras, y pregúntale si se refiere a alguna de esas.
    - Si te pide los datos de una o más cuentas libres, dáselos de forma organizada (correo, clave, pin perfil si aplica).
    - Si te pide un resumen ("cuántas hay libres"), dáselo de forma contada e inteligible agrupado por plataforma.
    - Si te pregunta por el histórico de alguien, resume las cuentas que ha tenido de forma clara.
    - Si el vector de datos está completamente vacío ([]), dile: "No encontré información en la base de datos para los parámetros solicitados sobre: ${query}".
    - NUNCA inventes correos o contraseñas que no estén en el JSON provisto.
  `;

  try {
    // Para esta tarea grande, si hay muchisimos datos forzamos modelo gemini-2.0-flash por si a caso.
    const responseText = await callDeepSeek(prompt, "Eres un asistente analítico para WhatsApp. Responde en texto legible y estético.", false);
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
    const jsonString = await callDeepSeek(prompt, "Eres un asistente administrativo transparente y proactivo. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error in suggestAdminActions:", error);
    return { suggestedAction: "general_query", replyMessage: "No estoy seguro de qué deseas hacer, ¿puedes ser más específico? 🤖" };
  }
}

/**
 * Permite la edición interactiva de un payload de broadcast
 */
async function editBroadcastPayload(query, currentPayload) {
  const prompt = `
    El administrador está editando el borrador de un mensaje masivo (broadcast) antes de enviarlo.
    
    PAYLOAD ACTUAL (Borrador):
    ${JSON.stringify({
    custom_message: currentPayload.custom_message,
    only_fields: currentPayload.only_fields,
    platform: currentPayload.platform,
    target_account: currentPayload.target_account
  }, null, 2)}
    
    INSTRUCCIÓN DEL ADMINISTRADOR: "${query}"
    
    Tu tarea es aplicar los cambios solicitados por el administrador al payload actual.
    - Si pide "cambia el mensaje a X", actualiza 'custom_message' al texto X exacto. Si el mensaje está entre comillas ("" o ''), EXTRAE TEXTUALMENTE lo de las comillas.
    - Si pide "quita el mensaje" o "no mandes mensaje", pon 'custom_message' en null.
    - Si pide "solo manda el correo" o "quita la contraseña", ajusta el arreglo 'only_fields' agregando o quitando las palabras clave ("clave", "contraseña", "pin", "perfil", "correo"). Si debe mandar todo de nuevo, déjalo vacío o null.
    
    Responde ÚNICAMENTE con el JSON actualizado con esta estructura exacta:
    {
       "custom_message": string | null,
       "only_fields": string[] | null
    }
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un editor JSON experto.", true);
    const result = JSON.parse(jsonString);

    return {
      ...currentPayload,
      custom_message: result.custom_message !== undefined ? result.custom_message : currentPayload.custom_message,
      only_fields: result.only_fields !== undefined ? result.only_fields : currentPayload.only_fields
    };
  } catch (error) {
    console.error("Error in editBroadcastPayload:", error);
    return currentPayload; // Devolver intacto si falla
  }
}

/**
 * Detecta si el mensaje del usuario expresa una promesa o fecha de pago futuro.
 */
async function detectPaymentPromise(messageContent, chatHistory = "") {
  const prompt = `
    Analiza el siguiente mensaje del usuario e identifica si expresa un compromiso, promesa o fecha de pago futuro (ej: "mañana pago", "consigno el 25", "el viernes pago", "más tarde transfiero").
    
    MENSAJE DEL USUARIO: "${messageContent}"
    CONTEXTO PREVIO:
    ${chatHistory}

    FECHA DE REFERENCIA DEL SISTEMA: ${new Date().toLocaleDateString('es-CO')} (Bogotá, Colombia)

    Salida esperada usando estricto JSON:
    {
      "isPromise": boolean, // true si promete pagar en el futuro
      "dateStr": string | null, // Ejemplo: "2026-05-25" (SIEMPRE en formato YYYY-MM-DD. Si dice "mañana" y la referencia es 24/5/2026, debe ser "2026-05-25". Calcula el día, mes y año correspondientes)
      "platform": string | null // Si se menciona o se infiere de qué servicio habla (ej: "HBO", "Netflix"), de lo contrario null.
    }
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un analista de intenciones de pago. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error en detectPaymentPromise:", error);
    return { isPromise: false, dateStr: null, platform: null };
  }
}

async function analyzeAdvisorReason(reason, chatHistory = "") {
  const prompt = `
    Analiza la siguiente explicación de un cliente sobre por qué desea hablar con un asesor humano:
    Explicación: "${reason}"
    
    Historial reciente de la conversación:
    ${chatHistory}
    
    Determina si la petición del cliente corresponde a un flujo que el bot de Sheerit puede resolver AUTOMÁTICAMENTE.
    El bot puede resolver automáticamente:
    1. Comprar un servicio nuevo ("comprar").
    2. Pagar, renovar o consultar el precio de su cuenta actual ("pagar" / "renovar").
    3. Solicitar credenciales, cambiar contraseña o consultar PIN ("credenciales").
    4. Fallas técnicas comunes o errores de pantalla en plataformas ("soporte").
    
    Si el cliente está enojado, tiene problemas de saldos, quejas de atención, o pide un reembolso, el bot NO puede resolverlo y debe ser atendido por un humano (canResolve: false).
    
    Salida esperada JSON:
    {
      "canResolve": boolean, // true si el bot puede resolverlo automáticamente usando uno de los flujos de arriba.
      "action": "comprar" | "pagar" | "renovar" | "credenciales" | "soporte" | null, // null si canResolve es false.
      "detectedPlatform": string | null, // Ej: "Netflix", "Disney" si se menciona, de lo contrario null.
      "explanation": string // Una frase muy corta justificando la decisión (ej. "Quiere comprar Amazon Prime").
    }
  `;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un clasificador de intenciones de soporte. Responde solo con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error en analyzeAdvisorReason:", error);
    return { canResolve: false, action: null, detectedPlatform: null, explanation: "Error de análisis" };
  }
}

async function parseScribePdfToRecipe(pdfBuffer) {
  const prompt = "Analiza detalladamente este PDF de Scribe y genera la receta JSON estructurada de pasos de Puppeteer para automatizar la acción descrita.";
  
  const systemInstruction = `Eres un experto en automatización web, RPA y scripting con Puppeteer.
Tu tarea es analizar un documento PDF de Scribe que contiene una guía paso a paso con capturas de pantalla y descripciones de cada paso para realizar una tarea en un sitio web externo (como iniciar sesión, solicitar códigos, etc.).
Debes interpretar cada paso e identificar las acciones correspondientes para automatizar ese flujo con Puppeteer.

Para cada paso, debes extraer:
1. La acción a realizar: 'navigate', 'type', 'click', 'wait_selector', 'wait_navigation', 'extract_text'.
2. El selector CSS exacto o sugerido (ej: "#user-email", ".btn-login", "input[type='password']", etc.). Si el selector no es evidente, deduce uno lógico basado en el texto y etiquetas HTML que describe el PDF.
3. El valor a rellenar si la acción es 'type'. Si se trata de ingresar la cuenta o correo del cliente, usa el marcador "{{CUSTOMER_EMAIL}}". Si es para ingresar el usuario administrador o contraseña del panel del proveedor, usa "ADMIN_USER" o "ADMIN_PASSWORD".
4. Una descripción corta del paso.

Salida esperada usando formato JSON estricto:
{
  "name": "Nombre descriptivo de la receta (ej: Extracción Disney+ Proveedor X)",
  "platform": "Nombre de la plataforma (ej: disney, netflix, max, etc.)",
  "steps": [
    {
      "action": "navigate" | "type" | "click" | "wait_selector" | "wait_navigation" | "extract_text",
      "url": "URL a navegar (solo si la acción es navigate)",
      "selector": "Selector CSS (para type, click, wait_selector, extract_text)",
      "value": "Valor a rellenar (para type)",
      "save_as": "Nombre de la variable (solo para extract_text, ej: 'otp_code')",
      "description": "Explicación breve del paso"
    }
  ]
}`;

  const mediaData = {
    data: pdfBuffer.toString('base64'),
    mimeType: 'application/pdf'
  };

  try {
    const jsonString = await callGemini(prompt, systemInstruction, true, mediaData);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error en parseScribePdfToRecipe:", error);
    throw error;
  }
}

async function analyzeRenewalModification(messageContent, currentItems) {
  const itemsSummary = (currentItems || []).map(item => {
    const name = item.Streaming || (item.platform ? item.platform.name : '') || item.name || '';
    return `- Fila: ${item._rowNumber || item.index || 'N/A'}, Plataforma: ${name}`;
  }).join('\n');

  const prompt = `Analiza el mensaje del cliente que está en proceso de renovación/pago de sus servicios.
Determina si el cliente desea MODIFICAR los servicios a renovar: ya sea excluyendo (no renovar, quitar, cancelar) o incluyendo (solo renovar ciertas plataformas) algún servicio de la lista actual.

Lista de servicios actualmente en el carrito de renovación:
${itemsSummary}

Mensaje del cliente: "${messageContent}"

REGLAS DE CLASIFICACIÓN:
1. Si el cliente dice que no desea renovar alguna plataforma, que la cancele, que la quite, o que solo desea pagar por cierta plataforma (y por ende quitar las demás), pon "shouldModify": true.
2. Identifica en "platformsToRenew" los nombres de las plataformas que el cliente SÍ desea conservar/renovar. Deben coincidir con el campo 'Plataforma' de la lista actual.
3. Identifica en "platformsToExclude" los nombres de las plataformas que el cliente desea EXCLUIR/NO renovar/cancelar.
4. Genera una respuesta empática y clara en "reply" en español confirmando la modificación. Sé muy directo y breve (máximo 2 líneas), informando el cambio y diciendo que recalculas el total. Firma con 🤖 al final.
5. Si el mensaje no indica ninguna intención de quitar o seleccionar un subconjunto de plataformas (por ejemplo, solo saluda, hace una pregunta genérica, o envía un comprobante), pon "shouldModify": false.

Salida esperada JSON:
{
  "shouldModify": boolean,
  "platformsToRenew": string[], // plataformas de la lista actual que desea renovar
  "platformsToExclude": string[], // plataformas de la lista actual que desea quitar/cancelar
  "reply": string // Mensaje de confirmación para el cliente con el emoji 🤖 al final
}
`;

  try {
    const jsonString = await callDeepSeek(prompt, "Eres un asistente de ventas experto. Responde estrictamente con JSON.", true);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Error en analyzeRenewalModification:", error);
    return { shouldModify: false, platformsToRenew: [], platformsToExclude: [], reply: "" };
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
  suggestAdminActions,
  editBroadcastPayload,
  generateReactivationResponse,
  isFamilyPlan,
  detectPaymentPromise,
  analyzeAdvisorReason,
  clearCachedSystemPrompt,
  parseScribePdfToRecipe,
  getMaskedAccessData,
  callGemini,
  callDeepSeek,
  analyzeRenewalModification
};
