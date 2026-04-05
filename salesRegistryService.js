const { updateExcelData, fetchRawData } = require('./apiService');

/**
 * Calcula la fecha del próximo pago sumando los meses correspondientes.
 * @param {string} subscriptionType - 'mensual', 'semestral', 'anual'
 * @returns {string} Fecha en formato DD/MM/YYYY
 */
function calculateNextPaymentDate(subscriptionType) {
    const now = new Date();
    let monthsToAdd = 1;
    
    if (subscriptionType === 'semestral') monthsToAdd = 6;
    else if (subscriptionType === 'anual') monthsToAdd = 12;
    
    now.setMonth(now.getMonth() + monthsToAdd);
    
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    
    return `${day}/${month}/${year}`;
}

/**
 * Intenta convertir una cadena de fecha (DD/MM/YYYY o similar) a objeto Date.
 */
function parseExcelDate(dateStr) {
    if (!dateStr || dateStr.toString().trim() === "") return null;
    try {
        const parts = dateStr.toString().split('/');
        if (parts.length === 3) {
            // Asumimos DD/MM/YYYY
            return new Date(parts[2], parts[1] - 1, parts[0]);
        }
        return new Date(dateStr);
    } catch (e) {
        return null;
    }
}

/**
 * Busca un cupo disponible para una plataforma específica.
 * Un cupo es "disponible" si la plataforma coincide y el campo 'Deben' está vacío o vencido.
 */
function findAvailableSlot(platformName, allRows) {
    const now = new Date();
    const targetPlatform = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        const rowStreaming = (row.Streaming || row.Plataforma || "").toString().toLowerCase().replace(/[^a-z0-9]/g, '');
        
        // Si la plataforma coincide
        if (rowStreaming.includes(targetPlatform) || targetPlatform.includes(rowStreaming)) {
            const debenStr = row.Deben || "";
            const debenDate = parseExcelDate(debenStr);
            
            // Si está vacío o vencido (anterior a hoy)
            if (!debenDate || debenDate < now) {
                return { rowData: row, index: i + 2 }; // Index en Excel (1-based, +1 for header)
            }
        }
    }
    return null;
}

/**
 * Registra una venta intentando llenar cupos existentes.
 */
async function recordNewSale(userId, userState, paymentMethod) {
    console.log(`[Sales Registry] Procesando registro inteligente para ${userId}...`);
    
    try {
        const items = userState.items || [];
        const subscriptionType = userState.subscriptionType || 'mensual';
        const nextPaymentDate = calculateNextPaymentDate(subscriptionType);
        const name = userState.nombre || "Cliente WhatsApp";
        const phone = userId.replace('@c.us', '');

        // Obtener todos los datos crudos para buscar cupos
        const allRows = await fetchRawData();
        
        for (const item of items) {
            const platformName = item.platform.name;
            const slot = findAvailableSlot(platformName, allRows);
            
            if (slot) {
                console.log(`[Sales Registry] Cupo encontrado para ${platformName} en fila ${slot.index}`);
                const updates = {
                    "numero": phone,
                    "Nombre": name,
                    "Deben": nextPaymentDate,
                    "Metodo Pago": paymentMethod || "Confirmado",
                    "Estado": "ACTIVO (Auto)"
                };
                
                await updateExcelData(slot.index, updates);
                // Marcar el row en nuestro array local como usado para que el siguiente item no tome el mismo
                allRows[slot.index - 2].Deben = "RESERVADO"; 
            } else {
                console.log(`[Sales Registry] NO se encontró cupo disponible para ${platformName}.`);
                // Aquí podrías agregar lógica para crear una fila nueva si no hay cupos
            }
        }
        
    } catch (error) {
        console.error("[Sales Registry] Error en proceso inteligente:", error.message);
    }
}

module.exports = {
    recordNewSale
};
