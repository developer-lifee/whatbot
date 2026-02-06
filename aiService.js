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
 * @returns {Promise<string>}
 */
async function callGemini(prompt, systemInstruction = "Eres un asistente de soporte y ventas amable y profesional de Sheerit, un servicio de cuentas de streaming. Tu tono es servicial, claro y directo. Siempre buscas ayudar al cliente a completar su compra o resolver su duda.") {
  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing in .env");
    throw new Error("GEMINI_API_KEY not configured");
  }

  const payload = {
    contents: [{
      role: 'user',
      parts: [{ text: prompt }]
    }],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

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
        // Sometimes response might be empty or blocked, treat as failure to try next?
        // Or throw? Let's just return "{}" if it looks valid but empty.
        return "{}";
      }

      // console.log(`Success with ${modelName}`);
      return text;

    } catch (error) {
      console.error(`Error with ${modelName}:`, error.message);
      // If it's the last model, throw the error
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
async function parsePurchaseIntent(messageContent) {
  const prompt = `
    Analiza el siguiente mensaje de un usuario interesado en servicios de streaming y extrae la información en formato JSON.
    El mensaje es: "${messageContent}"

    Salida esperada JSON:
    {
      "items": [
        { "platform": "NombrePlataforma", "plan": "NombrePlan" }
      ],
      "statedPrice": number | null, // Si el usuario menciona un precio total, inclúyelo (solo números).
      "subscriptionType": "mensual" | "semestral" | "anual" // "mensual" por defecto.
    }
    
    Reglas:
    - Normaliza los nombres de planes y plataformas (ej. "Netflix - Básico" -> platform: "Netflix", plan: "Básico").
    - Si no se especifica plan, pon null en "plan".
    - Si detectas "ChatGPT", normalizalo como platform: "ChatGPT".
  `;

  try {
    const jsonString = await callGemini(prompt, "Eres un asistente que extrae datos estructurados de pedidos.");
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
    const jsonString = await callGemini(prompt, "Eres un clasificador de métodos de pago. Responde solo con JSON.");
    const result = JSON.parse(jsonString);
    return result.method; // Puede ser null
  } catch (error) {
    console.error("Error detecting payment method:", error);
    return null;
  }
}

module.exports = { parsePurchaseIntent, detectPaymentMethod };
