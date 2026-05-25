const { updateExcelData, fetchRawData } = require('../apiService');

async function runTest() {
    try {
        console.log("=== INICIANDO BOMBARDEO DE ENCABEZADOS ===");
        
        // Bombardeamos con todos los posibles nombres para la columna 5 (index 4 de updatedValues)
        const bomb = {
            "numero": "BOMB_numero",
            "Numero": "BOMB_Numero",
            "Número": "BOMB_Número",
            "NUMERO": "BOMB_NUMERO",
            "NÚMERO": "BOMB_NÚMERO",
            "numero ": "BOMB_numero_space",
            "Numero ": "BOMB_Numero_space",
            "Número ": "BOMB_Número_space",
            " whatsapp": "BOMB_space_whatsapp",
            "whatsapp ": "BOMB_whatsapp_space",
            "whatsapp/numero": "BOMB_slash",
            "E": "BOMB_E",
            "col_5": "BOMB_col_5",
            "Col_5": "BOMB_Col_5",
            "Column_5": "BOMB_Column_5",
            "column_5": "BOMB_column_5"
        };

        const res = await updateExcelData(14, bomb);
        console.log("Respuesta de updateExcelData:", JSON.stringify(res, null, 2));

        // Leemos la fila 14 fresca para ver qué se guardó en cada columna
        console.log("=== LEYENDO FILA 14 COMPLETA DESPUÉS ===");
        const fresh = await fetchRawData();
        console.log("Fila 14 fresca:", JSON.stringify(fresh[12], null, 2));
    } catch (error) {
        console.error("Error en test:", error);
    }
}

runTest();
