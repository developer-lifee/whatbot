const { updateExcelData, fetchRawData } = require('../apiService');

async function runTest() {
    try {
        console.log("=== PROBANDO ESCRITURA EN COLUMNA F ===");
        const updates = {
            "F": "'573183981522",
            "observaciones": "TEST COL F - " + new Date().toLocaleTimeString()
        };

        const res = await updateExcelData(14, updates);
        console.log("Respuesta de updateExcelData:", JSON.stringify(res, null, 2));

        console.log("=== LEYENDO FILA 14 COMPLETA DESPUÉS ===");
        const fresh = await fetchRawData();
        console.log("Fila 14 fresca:", JSON.stringify(fresh[12], null, 2));
    } catch (error) {
        console.error("Error en test:", error);
    }
}

runTest();
