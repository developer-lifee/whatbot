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
            console.log('⚠️ No se encontró token.json. Por favor corre "node setup_google_auth.js" primero.');
            return false;
        }

        const token = fs.readFileSync(TOKEN_PATH, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        
        personasAPI = google.people({ version: 'v1', auth: oAuth2Client });
        console.log('✅ Google Contacts Service inicializado.');
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
        let formattedPhone = phone.toString().replace(/\D/g, '');
        if (formattedPhone.startsWith('57') && formattedPhone.length === 12) {
             formattedPhone = '+' + formattedPhone;
        }

        // Usamos searchContacts para buscar por el número
        const response = await personasAPI.people.searchContacts({
            query: formattedPhone,
            readMask: 'names,phoneNumbers',
        });

        const results = response.data.results || [];
        for (const res of results) {
            const person = res.person;
            const phoneNumbers = person.phoneNumbers || [];
            // Verificar que el número sea el correcto (search puede dar coincidencias parciales)
            const matches = phoneNumbers.some(pn => {
                const pnValue = pn.value ? pn.value.replace(/\D/g, '') : '';
                const searchVal = formattedPhone.replace(/\D/g, '');
                return pnValue.endsWith(searchVal);
            });

            if (matches && person.names && person.names.length > 0) {
                return person.names[0].displayName || person.names[0].givenName;
            }
        }
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
