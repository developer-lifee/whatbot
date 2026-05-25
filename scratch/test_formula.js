const { updateExcelData, fetchRawData } = require('../apiService');

async function runTest() {
    try {
        console.log("=== PROBANDO COMPORTAMIENTO DE FÓRMULA EN NUMERO ===");
        console.log("Escribiendo un nombre de contacto real ('Diana Munar') en 'whatsapp'...");

        const updates = {
            "whatsapp": "Diana Munar",
            "Nombre": "Diana",
            "apellido": "Munar",
            "observaciones": "TEST FORMULA - " + new Date().toLocaleTimeString()
        };

        const res = await updateExcelData(14, updates);
        console.log("Respuesta de updateExcelData:", JSON.stringify(res, null, 2));

        // Esperamos 4 segundos para que Excel en OneDrive/SharePoint recalcule las fórmulas
        console.log("Esperando recálculo en OneDrive...");
        await new Promise(r => setTimeout(r, 4000));

        console.log("=== LEYENDO FILA 14 COMPLETA DESPUÉS ===");
        const fresh = await fetchRawData();
        console.log("Fila 14 fresca:", JSON.stringify(fresh[12], null, 2));
    } catch (error) {
        console.error("Error en test:", error);
    }
}

runTest();
