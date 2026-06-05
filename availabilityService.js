const fs = require('fs');
const path = require('path');
const { fetchRawData } = require('./apiService');

const AVAILABILITY_FILE = path.join(__dirname, 'platform_availability.json');

function getAvailabilityConfig() {
    if (!fs.existsSync(AVAILABILITY_FILE)) {
        return {};
    }
    try {
        const content = fs.readFileSync(AVAILABILITY_FILE, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error("[Availability Service] Error reading platform_availability.json:", e.message);
        return {};
    }
}

function saveAvailabilityConfig(config) {
    try {
        fs.writeFileSync(AVAILABILITY_FILE, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
        console.error("[Availability Service] Error writing platform_availability.json:", e.message);
    }
}

/**
 * Checks if a platform has stock in the spreadsheet.
 * A platform has stock if there is at least one row where Status/Estado/Nombre is 'libre' or empty.
 */
async function checkSpreadsheetStock(platformName) {
    try {
        const data = await fetchRawData();
        const targetSearch = platformName.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        const matchingLibres = data.filter(row => {
            const rowStreaming = (row.Streaming || row.Plataforma || "").toString().toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!rowStreaming || rowStreaming.trim() === "") return false;
            
            if (rowStreaming.includes(targetSearch) || targetSearch.includes(rowStreaming)) {
                const whatsapp = (row.whatsapp || "").toString().trim();
                const nombre = (row.Nombre || "").toString().trim();
                return !whatsapp && (!nombre || nombre.toLowerCase() === 'libre');
            }
            return false;
        });
        
        return matchingLibres.length > 0;
    } catch (e) {
        console.error(`[Availability Service] Error checking spreadsheet stock for ${platformName}:`, e.message);
        return true; // Fallback optimista
    }
}

/**
 * Returns the availability status for a platform.
 * Returns: { immediate: boolean, reason: string | null }
 */
async function getPlatformAvailability(platformName) {
    const config = getAvailabilityConfig();
    
    // Normalizar nombre de búsqueda
    const normalizedQuery = platformName.toLowerCase().trim();
    let configKey = Object.keys(config).find(key => key.toLowerCase().trim() === normalizedQuery);
    
    if (!configKey) {
        configKey = Object.keys(config).find(key => {
            const k = key.toLowerCase().trim();
            return k.includes(normalizedQuery) || normalizedQuery.includes(k);
        });
    }
    
    // Si está deshabilitado manualmente
    if (configKey && config[configKey].immediate === false) {
        return {
            immediate: false,
            reason: config[configKey].reason || "Deshabilitado manualmente por administración."
        };
    }
    
    // Si no está deshabilitado manualmente, verificar si es un plan familiar/invitación
    const FAMILY_KEYWORDS = ['youtube', 'apple', 'microsoft', 'google', 'spotify individual', 'spotify personal', 'spotify familiar', 'familiar', 'family', 'xbox', 'netflix extra', 'extra', 'individual', 'personal', 'correo propio', 'tu correo'];
    const isFamily = FAMILY_KEYWORDS.some(key => normalizedQuery.includes(key));
    if (isFamily) {
        return {
            immediate: false,
            reason: "Este tipo de plan requiere de una invitación o activación personalizada por un asesor."
        };
    }
    
    // Si no es familiar, verificar el stock en el Excel
    const hasStock = await checkSpreadsheetStock(platformName);
    if (!hasStock) {
        return {
            immediate: false,
            reason: "No hay cupos libres disponibles en este momento en el sistema para entrega automática."
        };
    }
    
    return {
        immediate: true,
        reason: null
    };
}

module.exports = {
    getAvailabilityConfig,
    saveAvailabilityConfig,
    getPlatformAvailability,
    checkSpreadsheetStock
};
