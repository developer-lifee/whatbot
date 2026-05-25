const { fetchRawData } = require('../apiService');

async function run() {
    try {
        console.log("=== LEYENDO FILA 14 FRESCA ===");
        const fresh = await fetchRawData();
        console.log("Fila 14:", JSON.stringify(fresh[12], null, 2));
    } catch (e) {
        console.error(e);
    }
}

run();
