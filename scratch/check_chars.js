const fetch = require('node-fetch');
const AZURE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readexcelfunction";

async function checkChars() {
    try {
        const response = await fetch(AZURE_API_URL);
        const json = await response.json();
        const data = json.data || [];
        if (data.length > 0) {
            const firstRow = data[0];
            console.log("=== ANÁLISIS DE ENCABEZADOS ===");
            for (const key of Object.keys(firstRow)) {
                const charCodes = [...key].map(c => c.charCodeAt(0)).join(', ');
                console.log(`Key: "${key}" | Length: ${key.length} | Char Codes: [${charCodes}]`);
            }
        } else {
            console.log("No data found.");
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}

checkChars();
