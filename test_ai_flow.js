require('dotenv').config();
const { parsePurchaseIntent, detectPaymentMethod } = require('./aiService');

async function test() {
    console.log("--- Testing AI Service ---");
    if (!process.env.GEMINI_API_KEY) {
        console.warn("⚠️ Warning: GEMINI_API_KEY not found in .env. Tests will fail if they rely on real API calls.");
    }

    // Test Case 1: Purchase Intent
    const msg1 = "Hola, estoy interesado en el siguiente combo: Netflix - Básico, ChatGPT - Compartida. Precio total: $ 32.000/mes";
    console.log(`\nInput 1: "${msg1}"`);
    const result1 = await parsePurchaseIntent(msg1);
    console.log("Result 1:", JSON.stringify(result1, null, 2));

    // Test Case 2: Payment Method Detection
    const msg2 = "quiero pagar por nequi";
    console.log(`\nInput 2: "${msg2}"`);
    const result2 = await detectPaymentMethod(msg2);
    console.log("Result 2 (Payment Method):", result2);

    const msg3 = "claro que si pague";
    console.log(`\nInput 3: "${msg3}"`);
    // This might be handled by regex in index.js, but let's see if detectPaymentMethod picks up anything weird or just null
    const result3 = await detectPaymentMethod(msg3);
    console.log("Result 3 (Payment Method - Should be null?):", result3);
}

test();
