const { fetchRawData } = require('../apiService');

async function checkHBO() {
    const data = await fetchRawData();
    console.log("Analyzing Excel rows for HBO...");
    const hboRows = data.filter(d => (d.Streaming || "").toLowerCase().includes('hbo') || (d.Streaming || "").toLowerCase().includes('max'));
    
    const uniqueNames = new Set(hboRows.map(d => d.Streaming));
    console.log("Unique Streaming column values containing 'HBO' or 'Max':", Array.from(uniqueNames));
    
    // Veamos los primeros 5 ejemplos de filas vacías (libres) para ver qué nombres tienen
    const freeHbo = hboRows.filter(d => !d.whatsapp && (!d.Nombre || d.Nombre.toLowerCase() === 'libre'));
    console.log("\nExamples of FREE slots for HBO/Max:");
    freeHbo.slice(0, 10).forEach(d => {
        console.log(`Row ${d._rowNumber || 'N/A'}: Platform: "${d.Streaming}", Correo: "${d.correo || d.Correo || ''}"`);
    });
}

checkHBO();
