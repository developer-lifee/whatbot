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
 * @param {string|Date} baseDate - Opcional, fecha base desde la cual sumar (ej: vencimiento anterior)
 * @returns {string} Fecha en formato YYYY-MM-DD
 */
function calculateNextPaymentDate(subscriptionType, overrideMonths = null, baseDate = null) {
    let now = new Date();

    if (baseDate) {
        const { getJsDateFromExcel } = require('./apiService');
        const parsedBase = (baseDate instanceof Date) ? baseDate : getJsDateFromExcel(baseDate);

        if (parsedBase && !isNaN(parsedBase.getTime())) {
            // Regla: Si la fecha base es mayor a 15 días en el pasado, usamos hoy para no "renovar en el pasado"
            // Pero si es solo un retraso normal (ej: 1-5 días), mantenemos el ciclo original.
            const diffDays = (new Date() - parsedBase) / (1000 * 60 * 60 * 24);
            if (diffDays < 15) {
                now = new Date(parsedBase.getTime());
            }
        }
    }

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

    return `${year}-${month}-${day}`;
}

/**
 * Formatea un número de teléfono al estilo Sheerit: "57 3XX XXXXXXX"
 * Asegura un espacio después del indicativo 57 para evitar formatos feos en Excel.
 */
function formatWhatsAppNumber(phone) {
    // Devolvemos solo dígitos como String puro para evitar conflictos de formato en Excel
    return phone.replace(/\D/g, '');
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

        // Intentar obtener el nombre real
        let name = userState.nombre;
        if (!name || name === "Cliente WhatsApp") {
            try {
                const { getContactNameByPhone } = require('./googleContactsService');
                const contactName = await getContactNameByPhone(userId.replace(/\D/g, ''));
                if (contactName) {
                    name = contactName;
                } else {
                    // Si no hay contacto, intentamos usar el pushname si está disponible en el estado
                    name = userState.pushname || "Cliente WhatsApp";
                }
            } catch (e) {
                name = "Cliente WhatsApp";
            }
        }
        
        console.log(`[Sales Registry] Nombre resuelto para el registro: ${name}`);
        // Limpiar el ID de WhatsApp para obtener solo el número (eliminar sufijos de multi-dispositivo como :12)
        const phone = userId.split('@')[0].split(':')[0].replace(/\D/g, '');
        const formattedPhone = formatWhatsAppNumber(phone);

        // Obtener todos los datos crudos para buscar cupos (solo si no es renovación)
        const allRows = !userState.isRenewal ? await fetchRawData() : [];

        const results = [];
        for (const item of items) {
            const platformName = (item.Streaming || (item.platform ? item.platform.name : "") || item.name || "");
            const lowerName = platformName.toLowerCase();

            // 1. CASO RENOVACIÓN: Ya tenemos la fila
            if (userState.isRenewal && (item._rowNumber || item.index)) {
                const targetRow = item._rowNumber || item.index;
                const baseDate = item.deben || null;
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, overrideMonths, baseDate);

                console.log(`[Sales Registry] RENOVACIÓN detectada para ${platformName} en fila ${targetRow}. Nueva fecha: ${nextPaymentDate}`);
                const updates = {
                    "deben": nextPaymentDate,
                    "observaciones": `Renovación Dashboard - ${new Date().toLocaleDateString()}`
                };
                await updateExcelData(targetRow, updates);
                results.push({ name: platformName, status: 'success', rowNumber: targetRow, type: 'renewal' });
                continue;
            }

            // 2. CASO INTELIGENTE: Si no viene marcado como renovación, BUSCAR si el usuario YA TIENE esta plataforma
            let finalRow = null;
            let matchedRow = null;
            let isAutoRenewal = false;

            if (!userState.isRenewal) {
                const existingAccount = allRows.find(r => {
                    const rowPhone = (r.numero || r.Numero || r.whatsapp || "").toString().replace(/\D/g, '');
                    const rowStreaming = (r.Streaming || "").toLowerCase();
                    return rowPhone.includes(phone.slice(-10)) && rowStreaming.includes(lowerName);
                });

                if (existingAccount) {
                    finalRow = existingAccount._rowNumber || allRows.indexOf(existingAccount) + 2;
                    matchedRow = existingAccount;
                    isAutoRenewal = true;
                    console.log(`[Sales Registry] Auto-detección: El cliente ya tiene ${platformName}. Procesando como RENOVACIÓN en fila ${finalRow}`);
                }
            }

            if (finalRow) {
                const baseDate = matchedRow ? (matchedRow.deben || matchedRow.Deben) : null;
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, overrideMonths, baseDate);

                const updates = {
                    "deben": nextPaymentDate,
                    "observaciones": `Renovación Auto - ${new Date().toLocaleDateString()}`
                };
                await updateExcelData(finalRow, updates);
                results.push({ name: platformName, status: 'success', rowNumber: finalRow, type: 'renewal' });
                continue;
            }

            // 3. CASO VENTA NUEVA: Buscar cupo
            // Verificamos si es un PLAN FAMILIAR (Saltar si es venta nueva, pero NO si es renovación)
            const isFamilyPlan = FAMILY_KEYWORDS.some(key => lowerName.includes(key));

            if (isFamilyPlan) {
                console.log(`[Sales Registry] ${platformName} es un plan FAMILIAR. Saltando registro automático.`);
                results.push({ name: platformName, status: 'manual_invitation_required' });
                continue;
            }

            const slot = findAvailableSlot(platformName, allRows);

            if (slot) {
                const nextPaymentDate = calculateNextPaymentDate(subscriptionType, overrideMonths);
                console.log(`[Sales Registry] Cupo encontrado para ${platformName} en fila ${slot.index}`);

                // Lógica de separación de nombres
                const nameParts = name.trim().split(/\s+/);
                const firstName = nameParts[0] || "";
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : "";

                const updates = {
                    "Nombre": firstName,
                    "apellido": lastName,
                    "Nombre Completo": name,
                    "whatsapp": name,
                    "numero": formattedPhone,
                    "deben": nextPaymentDate,
                    "observaciones": `Venta Auto (${nextPaymentDate}) - ${new Date().toLocaleDateString()}`
                };

                console.log(`[Sales Registry] Enviando actualización a Azure:`, JSON.stringify(updates, null, 2));

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
