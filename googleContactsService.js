const { google } = require('googleapis');
const { getOAuth2Client } = require('./googleAuthService');

let personasAPI = null;
const recentlyAdded = new Set(); // Caché local para evitar duplicados en ráfagas rápidas
const contactCache = new Map(); // Caché en memoria para evitar el lag de indexación de Google
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

        // 1. Verificar caché local INMEDIATAMENTE (para evitar race conditions en ráfagas)
        if (recentlyAdded.has(coreNumber)) {
            console.log(`[Google Contacts] ℹ️ Número ${coreNumber} ya está en proceso de creación o fue creado recientemente (Caché).`);
            return true;
        }
        
        // Marcar como en proceso antes de cualquier await
        recentlyAdded.add(coreNumber);
        // Limpiar del caché después de un tiempo para permitir actualizaciones si fuera necesario
        setTimeout(() => recentlyAdded.delete(coreNumber), PROCESSING_WINDOW);

        // 2. Verificar existencia real en Google Contacts
        const existingName = await searchContactByPhone(phone);
        if (existingName) {
            console.log(`[Google Contacts] ℹ️ Contacto ya existe en Google: ${existingName} (${coreNumber}).`);
            return true;
        }

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
        contactCache.set(coreNumber, { name, timestamp: Date.now() }); // Guardar en caché para evitar lag de indexación
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
        // 1. Extraer número del JID y limpiar caracteres
        const rawPhone = phone.toString().split('@')[0];
        const digitsOnly = rawPhone.replace(/\D/g, '');
        const coreNumber = digitsOnly.slice(-10);

        if (coreNumber.length < 10) return null;

        // Verificar en caché local primero (24 horas de expiración para búsquedas exitosas o negativas)
        if (contactCache.has(coreNumber)) {
            const cacheEntry = contactCache.get(coreNumber);
            if (Date.now() - cacheEntry.timestamp < 1000 * 60 * 60 * 24) {
                if (cacheEntry.name === '__NOT_FOUND__') {
                    return null;
                }
                return cacheEntry.name;
            }
        }

        // Búsqueda 1: Número completo
        let response = await personasAPI.people.searchContacts({
            query: coreNumber,
            readMask: 'names,phoneNumbers',
        });

        let results = response.data.results || [];
        
        // Búsqueda 2: Últimos 7 dígitos (ej: 1234567)
        if (results.length === 0) {
            response = await personasAPI.people.searchContacts({
                query: coreNumber.slice(-7),
                readMask: 'names,phoneNumbers',
            });
            results = response.data.results || [];
        }

        // Búsqueda 3: Últimos 7 dígitos con espacio (ej: "123 4567" para coincidir con "+57 300 123 4567")
        if (results.length === 0) {
            const formattedSeven = coreNumber.slice(-7, -4) + ' ' + coreNumber.slice(-4);
            response = await personasAPI.people.searchContacts({
                query: formattedSeven,
                readMask: 'names,phoneNumbers',
            });
            results = response.data.results || [];
        }

        for (const res of results) {
            const person = res.person;
            const phoneNumbers = person.phoneNumbers || [];
            
            const matches = phoneNumbers.some(pn => {
                const pnValue = pn.value ? pn.value.replace(/\D/g, '') : '';
                return pnValue.endsWith(coreNumber);
            });

            if (matches && person.names && person.names.length > 0) {
                const foundName = person.names[0].displayName || person.names[0].givenName;
                contactCache.set(coreNumber, { name: foundName, timestamp: Date.now() }); // Guardar en caché
                return foundName;
            }
        }

        // Registrar lookup negativo para no volver a preguntar en 24 horas
        contactCache.set(coreNumber, { name: '__NOT_FOUND__', timestamp: Date.now() });
        return null;
    } catch (error) {
        console.error('❌ Error al buscar contacto en Google:', error.message);
        // Si hay error (como quota limit), cacheamos por 15 minutos para silenciar ráfagas de logs
        contactCache.set(coreNumber, { name: '__NOT_FOUND__', timestamp: Date.now() - (1000 * 60 * 60 * 24 - 1000 * 60 * 15) }); // Expira en 15 mins
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
