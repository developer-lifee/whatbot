require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/**
 * Call Gemini API with a given prompt and system instruction.
 * @param {string} prompt 
 * @param {string} systemInstruction 
 * @returns {Promise<string>}
 */
async function callGemini(prompt, systemInstruction = "You are a helpful assistant.") {
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

  try {
    const response = await fetch(`${API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} ${response.statusText} - ${errText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw error;
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
    Opciones válidas: "nequi", "daviplata", "bancolombia", "banco caja social", "transfiya", "llaves bre-v".
    
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
