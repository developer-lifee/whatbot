const fs = require('fs');
const path = require('path');

const STATES_FILE = path.join(__dirname, 'user_states.json');

/**
 * Carga los estados de los usuarios desde el archivo JSON.
 * @returns {Map} Un Map con los estados cargados.
 */
function loadStates() {
    try {
        if (fs.existsSync(STATES_FILE)) {
            const data = fs.readFileSync(STATES_FILE, 'utf8');
            const obj = JSON.parse(data);
            console.log(`[Memory] Cargados ${Object.keys(obj).length} estados de usuario.`);
            return new Map(Object.entries(obj));
        }
    } catch (error) {
        console.error('[Memory] Error cargando estados:', error.message);
    }
    return new Map();
}

/**
 * Guarda los estados de los usuarios en el archivo JSON.
 * @param {Map} statesMap El Map de estados a guardar.
 */
function saveStates(statesMap) {
    try {
        const obj = Object.fromEntries(statesMap);
        fs.writeFileSync(STATES_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (error) {
        console.error('[Memory] Error guardando estados:', error.message);
    }
}

module.exports = {
    loadStates,
    saveStates
};
