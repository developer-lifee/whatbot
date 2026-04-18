const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');

let personasAPI = null;

/**
 * Inicializa el cliente de Google People API
 */
function initPeopleAPI() {
    const auth = getOAuth2Client();
    if (!auth) return null;
    
    personasAPI = google.people({ version: 'v1', auth });
    return personasAPI;
}

// Initial attempted boot
initPeopleAPI();

/**
 * Crea un contacto nuevo en Google Contacts.
 * @param {string} name El nombre del cliente.
 * @param {string} phone El número de celular (de preferencia con código de país).
 * @returns {Promise<boolean>} Retorna true si fue exitoso, false si falló.
 */
async function addNewContact(name, phone) {
    if (!personasAPI) initPeopleAPI();
    if (!personasAPI) {
        console.warn('⚠️ Google API no ha sido inicializada (faltan credenciales o token).');
        return false;
    }

    try {
        let formattedPhone = phone.toString().replace(/\D/g, '');
        if (formattedPhone.startsWith('57') && formattedPhone.length === 12) {
            formattedPhone = '+' + formattedPhone;
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
        if (error.message && error.message.includes('MY_CONTACTS_OVERFLOW_COUNT')) {
            console.warn(`⚠️ [Google Contacts] Límite de contactos alcanzado. No se pudo guardar a ${name}.`);
        } else {
            console.error('❌ Error al crear el contacto en Google:', error.message);
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
    if (!personasAPI) initPeopleAPI();
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
    if (!personasAPI) initPeopleAPI();
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
