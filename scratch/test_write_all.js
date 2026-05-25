const { updateExcelData, fetchRawData } = require('../apiService');

async function runTest() {
    try {
        console.log("=== PROBANDO ESCRITURA EN TODAS LAS COLUMNAS ===");
        
        const updates = {
            "Nombre": "TestNombre",
            "apellido": "TestApellido",
            "whatsapp": "TestWhatsapp",
            "numero": "123456",
            "correo": "test@test.com",
            "contraseña": "testpwd",
            "vencimiento": "2026-12-31",
            "Metodo de pago": "Nequi",
            "customer mail": "cust@test.com",
            "operador": "Claro",
            "pin perfil": "1234",
            "deben": "2026-12-31",
            "observaciones": "TestObs"
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
