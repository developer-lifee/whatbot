const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');

let personasAPI = null;
const recentlyAdded = new Set(); // Caché local para evitar duplicados en ráfagas rápidas
const PROCESSING_WINDOW = 1000 * 60 * 5; // 5 minutos de ventana de procesamiento

/**
 * Inicializa el cliente de Google People API
 */
async function initPeopleAPI() {
    const auth = await getOAuth2Client('contacts');
    if (!auth) return null;
    
    personasAPI = google.people({ version: 'v1', auth });
    return personasAPI;
}

// Initial attempted boot
initPeopleAPI().catch(err => console.error('[Google Contacts] Error in initial boot:', err.message));

/**
 * Crea un contacto nuevo en Google Contacts.
 * @param {string} name El nombre del cliente.
 * @param {string} phone El número de celular (de preferencia con código de país).
 * @returns {Promise<boolean>} Retorna true si fue exitoso, false si falló.
 */
async function addNewContact(name, phone) {
    if (!personasAPI) await initPeopleAPI();
    if (!personasAPI) {
        console.warn('⚠️ Google API no ha sido inicializada (faltan credenciales o token).');
        return false;
    }

    try {
        const digitsOnly = phone.toString().replace(/\D/g, '');
        if (digitsOnly.length < 10) return false;
        
        const coreNumber = digitsOnly.slice(-10);

        // 1. Verificar caché local (para ráfagas de mensajes)
        if (recentlyAdded.has(coreNumber)) {
            console.log(`[Google Contacts] ℹ️ Número ${coreNumber} ya está en proceso de creación o fue creado recientemente (Caché).`);
            return true;
        }

        // 2. Verificar existencia real en Google Contacts
        const existingName = await searchContactByPhone(phone);
        if (existingName) {
            console.log(`[Google Contacts] ℹ️ Contacto ya existe en Google: ${existingName} (${coreNumber}).`);
            recentlyAdded.add(coreNumber); // Agregamos a caché por si acaso
            return true;
        }

        // Marcar como en proceso
        recentlyAdded.add(coreNumber);
        // Limpiar del caché después de un tiempo para permitir actualizaciones si fuera necesario
        setTimeout(() => recentlyAdded.delete(coreNumber), PROCESSING_WINDOW);

        let formattedPhone = digitsOnly;
        if (formattedPhone.startsWith('57') && formattedPhone.length === 12) {
            formattedPhone = '+' + formattedPhone;
        } else if (formattedPhone.length === 10) {
            formattedPhone = '+57' + formattedPhone;
        }

        const response = await personasAPI.people.createContact({
            requestBody: {
                names: [
                    {
                        givenName: name,
                    }
                ],
                phoneNumbers: [
                    {
                        value: formattedPhone,
                        type: 'mobile'
                    }
                ]
            }
        });

        console.log(`✅ Contacto [${name} - ${formattedPhone}] creado exitosamente en Google Contacts.`);
        return true;
    } catch (error) {
        const errorMsg = error.message || "";
        if (errorMsg.includes('MY_CONTACTS_OVERFLOW_COUNT')) {
            console.warn(`⚠️ [Google Contacts] Límite de contactos alcanzado. No se pudo guardar a ${name}.`);
            console.warn(`💡 TIP: Vacía la PAPELERA (Trash) en tu cuenta de Google Contacts. Los contactos eliminados siguen contando para el límite de 25,000 por 30 días hasta que se eliminen definitivamente.`);
            // Silenciar futuras alertas para este número en la ventana de ráfaga
            const digitsOnly = phone.toString().replace(/\D/g, '');
            const coreNumber = digitsOnly.slice(-10);
            recentlyAdded.add(coreNumber);
            setTimeout(() => recentlyAdded.delete(coreNumber), PROCESSING_WINDOW);
        } else {
            console.error('❌ Error al crear el contacto en Google:', errorMsg);
        }
        return false;
    }
}

/**
 * Busca un contacto por su número de teléfono en Google Contacts.
 * @param {string} phone El número de celular a buscar.
 * @returns {Promise<string|null>} El nombre del contacto si se encuentra, null de lo contrario.
 */
async function searchContactByPhone(phone) {
    if (!personasAPI) await initPeopleAPI();
    if (!personasAPI) return null;

    try {
        const digitsOnly = phone.toString().replace(/\D/g, '');
        const coreNumber = digitsOnly.slice(-10);

        if (coreNumber.length < 10) return null;

        const response = await personasAPI.people.searchContacts({
            query: coreNumber,
            readMask: 'names,phoneNumbers',
        });

        const results = response.data.results || [];
        for (const res of results) {
            const person = res.person;
            const phoneNumbers = person.phoneNumbers || [];
            
            const matches = phoneNumbers.some(pn => {
                const pnValue = pn.value ? pn.value.replace(/\D/g, '') : '';
                return pnValue.endsWith(coreNumber);
            });

            if (matches && person.names && person.names.length > 0) {
                const foundName = person.names[0].displayName || person.names[0].givenName;
                return foundName;
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Error al buscar contacto en Google:', error.message);
        return null;
    }
}

/**
 * Busca un contacto por su nombre en Google Contacts.
 * @param {string} name El nombre a buscar.
 * @returns {Promise<string|null>} El número de teléfono si se encuentra, null de lo contrario.
 */
async function searchContactByName(name) {
    if (!personasAPI) await initPeopleAPI();
    if (!personasAPI) return null;

    try {
        const response = await personasAPI.people.searchContacts({
            query: name,
            readMask: 'names,phoneNumbers',
        });

        const results = response.data.results || [];
        if (results.length === 0) return null;

        // Tomamos el primero que tenga número de teléfono
        for (const res of results) {
            const person = res.person;
            const phoneNumbers = person.phoneNumbers || [];
            if (phoneNumbers.length > 0) {
                // Limpiar el número para devolver formato puro
                let rawNum = phoneNumbers[0].value.replace(/\D/g, '');
                if (rawNum.length === 10 && !rawNum.startsWith('57')) {
                    rawNum = '57' + rawNum;
                }
                return rawNum;
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Error al buscar contacto por nombre en Google:', error.message);
        return null;
    }
}

module.exports = {
    addNewContact,
    searchContactByPhone,
    searchContactByName,
    initGoogleClient: initPeopleAPI // Keep export for compatibility
};
