const { fetchRawData } = require('../apiService');
async function test() {
    try {
        const data = await fetchRawData();
        if (data.length > 0) {
            console.log("Columnas detectadas:", Object.keys(data[0]));
            console.log("Muestra de una fila:", data[0]);
        } else {
            console.log("No hay datos.");
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}
test();
