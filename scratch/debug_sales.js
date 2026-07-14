const { recordNewSale } = require('../salesRegistryService');
const { fetchRawData } = require('../apiService');

async function debugSantiago() {
    console.log("=== SIMULANDO REGISTRO SANTIAGO LOSADA ===");
    // Santiago Losada (Apple One + GPT = 42,000)
    const userId = "573209187908@c.us";
    const userState = {
        nombre: "Santiago Losada",
        total: 42000,
        items: [
            { name: "Apple One" },
            { name: "gpt" }
        ],
        subscriptionType: 'mensual'
    };

    const results = await recordNewSale(userId, userState, "Test Debug");
    console.log("Resultados de Santiago:", JSON.stringify(results, null, 2));
}

async function debugGraciela() {
    console.log("\n=== SIMULANDO REGISTRO GRACIELA RAMIREZ ===");
    // Graciela Ramirez ($26,000)
    const userId = "573105802358@c.us";
    const userState = {
        nombre: "Graciela Ramirez",
        total: 26000,
        items: [
            { name: "Netflix" }
        ],
        subscriptionType: 'mensual'
    };

    const results = await recordNewSale(userId, userState, "Test Debug");
    console.log("Resultados de Graciela:", JSON.stringify(results, null, 2));
}

async function run() {
    try {
        await debugSantiago();
        await debugGraciela();
    } catch (e) {
        console.error("Error running debug:", e);
    }
}

run();
