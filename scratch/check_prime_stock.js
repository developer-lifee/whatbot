const { fetchRawData } = require('../apiService');

async function check() {
    try {
        const data = await fetchRawData();
        const primeRows = data.filter(row => {
            const rowStreaming = (row.Streaming || row.Plataforma || "").toString().toLowerCase();
            return rowStreaming.includes('prime') || rowStreaming.includes('amazon');
        });
        console.log(`Found ${primeRows.length} rows for Prime/Amazon`);
        primeRows.forEach((row, i) => {
            console.log(`${i+1}: rowNumber: ${row._rowNumber || 'N/A'}, Streaming: "${row.Streaming}", Nombre: "${row.Nombre}", whatsapp: "${row.whatsapp}", correo: "${row.correo}"`);
        });
    } catch (e) {
        console.error("Error:", e.message);
    }
}
check();
