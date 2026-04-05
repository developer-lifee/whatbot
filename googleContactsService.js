const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

let oAuth2Client = null;
let personasAPI = null;

/**
 * Inicializa el cliente de Google People API
 */
function initGoogleClient() {
    try {
        console.log('⏳ Iniciando servicio de Google Contacts...');
        
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            console.log('⚠️ No se encontró credentials.json. La integración con Google Contacts está deshabilitada.');
            return false;
        }

        const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        
        let redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
        
        oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        if (!fs.existsSync(TOKEN_PATH)) {
            console.warn('⚠️ No se encontró token.json. Google Contacts funcionará una vez que completes el flujo de autenticación.');
            return false;
        }

        const token = fs.readFileSync(TOKEN_PATH, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        
        personasAPI = google.people({ version: 'v1', auth: oAuth2Client });
        console.log('✅ Google Contacts Service inicializado exitosamente.');
        return true;
    } catch (error) {
        console.error('❌ Error inicializando Google Contacts:', error);
        return false;
    }
}

// Llama a la inicialización al cargar el módulo
initGoogleClient();

/**
 * Crea un contacto nuevo en Google Contacts.
 * @param {string} name El nombre del cliente.
 * @param {string} phone El número de celular (de preferencia con código de país).
 * @returns {Promise<boolean>} Retorna true si fue exitoso, false si falló.
 */
async function addNewContact(name, phone) {
    if (!personasAPI) {
        console.warn('⚠️ Google API no ha sido inicializada.');
        return false;
    }

    try {
        // Normalizamos el formato del celular un poco para Google (añade + si no existe y empieza con 57)
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
        console.error('❌ Error al crear el contacto en Google:', error);
        if (error.response && error.response.data && error.response.data.error) {
             console.error('Detalles del error:', error.response.data.error.message);
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
    if (!personasAPI) return null;

    try {
        // Obtenemos los últimos 10 dígitos (el número móvil core en Colombia)
        const digitsOnly = phone.toString().replace(/\D/g, '');
        const coreNumber = digitsOnly.slice(-10);

        if (coreNumber.length < 10) {
            console.log(`[Search] Número demasiado corto para buscar: ${digitsOnly}`);
            return null;
        }

        console.log(`[Search] Buscando contacto en Google para: *${coreNumber}* (Original: ${digitsOnly})`);

        // Buscamos solo por los últimos 10 dígitos para máxima compatibilidad
        const response = await personasAPI.people.searchContacts({
            query: coreNumber,
            readMask: 'names,phoneNumbers',
        });

        const results = response.data.results || [];
        console.log(`[Search] Resultados encontrados en Google para ${coreNumber}: ${results.length}`);

        for (const res of results) {
            const person = res.person;
            const phoneNumbers = person.phoneNumbers || [];
            
            // Verificamos que al menos uno de los números termine en los 10 dígitos buscados
            const matches = phoneNumbers.some(pn => {
                const pnValue = pn.value ? pn.value.replace(/\D/g, '') : '';
                return pnValue.endsWith(coreNumber);
            });

            if (matches && person.names && person.names.length > 0) {
                const foundName = person.names[0].displayName || person.names[0].givenName;
                console.log(`[Search] ✅ Usuario identificado como: ${foundName}`);
                return foundName;
            }
        }
        
        console.log(`[Search] ❌ No se encontró coincidencia exacta para los últimos 10 dígitos de ${digitsOnly}`);
        return null;
    } catch (error) {
        console.error('❌ Error al buscar contacto en Google:', error.message);
        return null;
    }
}

module.exports = {
    addNewContact,
    searchContactByPhone,
    initGoogleClient
};
