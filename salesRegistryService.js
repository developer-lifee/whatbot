const { updateExcelData, fetchRawData } = require('./apiService');

const FAMILY_KEYWORDS = ['youtube', 'apple', 'microsoft', 'google', 'spotify', 'familiar', 'family', 'xbox', 'netflix extra', 'extra'];

/**
 * Calcula la fecha del próximo pago sumando los meses correspondientes.
 * @param {string} subscriptionType - 'mensual', 'semestral', 'anual'
 * @returns {string} Fecha en formato DD/MM/YYYY
 */
/**
 * Calcula la fecha del próximo pago sumando los meses correspondientes.
 * @param {string} subscriptionType - 'mensual', 'semestral', 'anual'
 * @param {number} overrideMonths - Opcional, cantidad de meses a sumar
 * @returns {string} Fecha en formato DD/MM/YYYY
 */
function calculateNextPaymentDate(subscriptionType, overrideMonths = null) {
    const now = new Date();
    let monthsToAdd = 1;
    
    if (overrideMonths) {
        monthsToAdd = overrideMonths;
    } else {
        if (subscriptionType === 'semestral') monthsToAdd = 6;
        else if (subscriptionType === 'anual') monthsToAdd = 12;
    }
    
    now.setMonth(now.getMonth() + monthsToAdd);
    
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    
    return `${day}/${month}/${year}`;
}

/**
 * Formatea un número de teléfono al estilo Sheerit: "57 3XX XXXXXXX"
 */
function formatWhatsAppNumber(phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 12) {
        return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
    }
    return phone; // Fallback
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
 * Un cupo es "disponible" si la plataforma coincide y el campo 'whatsapp' o 'Nombre' está vacío.
 */
function findAvailableSlot(platformName, allRows) {
    const targetPlatform = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        const rowStreaming = (row.Streaming || row.Plataforma || "").toString().toLowerCase().replace(/[^a-z0-9]/g, '');
        
        // Si la plataforma coincide
        if (rowStreaming.includes(targetPlatform) || targetPlatform.includes(rowStreaming)) {
            const whatsapp = (row.whatsapp || row.whatsapp || "").toString().trim();
            const nombre = (row.Nombre || row.nombre || "").toString().trim();
            const debenStr = row.deben || row.Deben || "";
            
            // Solo usamos filas que están vacías o marcadas como 'libre' (STOCK real)
            if (!whatsapp && (!nombre || nombre.toLowerCase() === 'libre')) {
                return { rowData: row, index: i + 2 }; 
            }
        }
    }
    return null;
}

/**
 * Registra una venta intentando llenar cupos existentes.
 */
async function recordNewSale(userId, userState, paymentMethod, overrideMonths = null) {
    console.log(`[Sales Registry] Procesando registro inteligente para ${userId} (${overrideMonths || 'auto'} meses)...`);
    
    try {
        const items = userState.items || [];
        const subscriptionType = userState.subscriptionType || 'mensual';
        const nextPaymentDate = calculateNextPaymentDate(subscriptionType, overrideMonths);
        const name = userState.nombre || "Cliente WhatsApp";
        const phone = userId.replace('@c.us', '');

        // Obtener todos los datos crudos para buscar cupos (solo si no es renovación)
        const allRows = !userState.isRenewal ? await fetchRawData() : [];
        
        const results = [];
        for (const item of items) {
            const platformName = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "");
            const lowerName = platformName.toLowerCase();
            
            // 1. CASO RENOVACIÓN: Ya tenemos la fila
            if (userState.isRenewal && (item._rowNumber || item.index)) {
                const targetRow = item._rowNumber || item.index;
                console.log(`[Sales Registry] RENOVACIÓN detectada para ${platformName} en fila ${targetRow}`);
                const updates = {
                    "deben": nextPaymentDate,
                    "Metodo de pago": paymentMethod || "Renovado (Auto)",
                    "observaciones": `Renovación Dashboard - ${new Date().toLocaleDateString()}`
                };
                await updateExcelData(targetRow, updates);
                results.push({ name: platformName, status: 'success', rowNumber: targetRow, type: 'renewal' });
                continue;
            }

            // 2. CASO VENTA NUEVA: Buscar cupo
            // Verificamos si es un PLAN FAMILIAR (Saltar si es venta nueva, pero NO si es renovación)
            const isFamilyPlan = FAMILY_KEYWORDS.some(key => lowerName.includes(key));
            
            if (isFamilyPlan) {
                console.log(`[Sales Registry] ${platformName} es un plan FAMILIAR. Saltando registro automático.`);
                results.push({ name: platformName, status: 'manual_invitation_required' });
                continue;
            }

            const slot = findAvailableSlot(platformName, allRows);
            
            if (slot) {
                console.log(`[Sales Registry] Cupo encontrado para ${platformName} en fila ${slot.index}`);
                
                // Lógica de separación de nombres
                const nameParts = name.trim().split(/\s+/);
                const firstName = nameParts[0] || "";
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";
                
                const updates = {
                    "Nombre": firstName,
                    "apellido": lastName,
                    "Nombre Completo": name,
                    "whatsapp": formatWhatsAppNumber(phone),
                    "numero": phone,
                    "deben": nextPaymentDate,
                    "Metodo de pago": paymentMethod || "Confirmado (Auto)",
                    "observaciones": `Venta Auto - ${new Date().toLocaleDateString()}`
                };

                // Si es Netflix o Disney y tenemos operador en el estado, lo llenamos
                if (lowerName.includes('netflix') || lowerName.includes('disney')) {
                    if (userState.netflixIsp) {
                        updates["operador"] = userState.netflixIsp;
                    }
                }

                // Customer mail (si lo tenemos en el estado)
                if (userState.correo) {
                    updates["customer mail"] = userState.correo;
                }
                
                await updateExcelData(slot.index, updates);
                // Marcar el row en nuestro array local como usado para evitar colisiones
                if (allRows[slot.index - 2]) {
                    allRows[slot.index - 2].whatsapp = phone;
                    allRows[slot.index - 2].deben = "RESERVADO";
                }
                results.push({ name: platformName, status: 'success', rowNumber: slot.index, type: 'new_sale' });
            } else {
                console.log(`[Sales Registry] NO se encontró cupo disponible para ${platformName}.`);
                results.push({ name: platformName, status: 'no_slots_found' });
            }
        }
        return results;
        
    } catch (error) {
        console.error("[Sales Registry] Error en proceso inteligente:", error.message);
    }
}

module.exports = {
    recordNewSale
};
