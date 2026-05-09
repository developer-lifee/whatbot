const fetch = require('node-fetch');

const AZURE_API_URL = "https://jsondeexcel-c2f5befzdqgyfah9.canadaeast-01.azurewebsites.net/api/readexcelfunction";

async function checkColumns() {
    try {
        const response = await fetch(AZURE_API_URL);
        const json = await response.json();
        const data = json.data || [];
        if (data.length > 0) {
            console.log("Columnas detectadas:", Object.keys(data[0]).join(', '));
            console.log("Ejemplo de primera fila:", JSON.stringify(data[0], null, 2));
        } else {
            console.log("No se encontraron datos.");
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
}

checkColumns();
