const { saveAvailabilityConfig, getAvailabilityConfig, getActiveIncidentsText } = require('../availabilityService');
const { generateEmpatheticFallback, generateCredentialsResponse } = require('../aiService');

async function run() {
    console.log("=== Testing Active Incident Text ===");
    
    // Set a test incident
    const config = getAvailabilityConfig();
    config["YouTube Premium"] = { immediate: true, incident: "Se cayó YouTube a nivel general. Estamos reasignando accesos." };
    config["Netflix"] = { immediate: false, reason: "Sin stock", incident: "Pérdida de hogares en algunas cuentas. Soporte está trabajando en ello." };
    saveAvailabilityConfig(config);

    const incidentsText = getActiveIncidentsText();
    console.log("Generated Incidents Text:\n", incidentsText);

    // Test calling fallbacks
    console.log("\n=== Testing AI Fallback with Incident ===");
    const fallbackResponse = await generateEmpatheticFallback("Hola, tengo problemas con mi cuenta de YouTube Premium, se cayó?", false, "", null, [
        { Streaming: "YouTube Premium", correo: "jorditest@gmail.com", deben: "45000", vencimiento: "2026-07-06" }
    ]);
    console.log("Fallback Response:\n", fallbackResponse.replyMessage);

    // Clean up
    delete config["YouTube Premium"];
    delete config["Netflix"];
    saveAvailabilityConfig(config);
    console.log("\n=== Cleaned up config ===");
}

run().catch(console.error);
