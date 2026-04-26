const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Scopes específicos por servicio
const SERVICE_SCOPES = {
    'contacts': ['https://www.googleapis.com/auth/contacts'],
    'gmail': ['https://www.googleapis.com/auth/gmail.readonly']
};

const cachedClients = new Map();
let alertCallback = null;

function setAlertCallback(cb) {
    alertCallback = cb;
}

/**
 * Inicializa o retorna un cliente OAuth2 específico para un servicio (contacts, gmail, etc.)
 * @param {string} serviceName - El nombre del servicio para identificar el token
 * @param {string} code - Opcional. Si se provee, se usa para generar un nuevo token.
 */
async function getOAuth2Client(serviceName = 'contacts', code = null) {
    if (cachedClients.has(serviceName) && !code) return cachedClients.get(serviceName);

    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`❌ No se encontró credentials.json. Servicio ${serviceName} deshabilitado.`);
        return null;
    }

    try {
        const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';

        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
        const tokenPath = path.resolve(__dirname, `token_${serviceName}.json`);
        const legacyTokenPath = path.resolve(__dirname, `token.json`);
        console.log(`[GOOGLE AUTH DEBUG] Buscando token en: ${tokenPath}`);

        // Si recibimos un código, intentamos generar el token y guardarlo
        if (code) {
            console.log(`[GOOGLE AUTH] Intentando canjear código para ${serviceName}...`);
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(tokenPath, JSON.stringify(tokens));
            console.log(`✅ Token para ${serviceName} guardado con éxito en ${tokenPath}`);
            cachedClients.set(serviceName, oAuth2Client);
            return oAuth2Client;
        }

        // Si no existe el token específico, probamos con el token genérico
        let activeTokenPath = tokenPath;
        if (!fs.existsSync(tokenPath) && fs.existsSync(legacyTokenPath)) {
            console.log(`[GOOGLE AUTH] No hay token específico para ${serviceName}, usando token.json genérico.`);
            activeTokenPath = legacyTokenPath;
        }

        if (!fs.existsSync(activeTokenPath)) {
            const scopes = SERVICE_SCOPES[serviceName] || SERVICE_SCOPES['contacts'];
            const authUrl = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: scopes,
                prompt: 'consent'
            });
            console.warn(`\n⚠️ [GOOGLE AUTH] Se requiere autorización para el servicio: *${serviceName.toUpperCase()}*`);
            console.warn(`👉 Abre este enlace y usa la cuenta correspondiente:\n`, authUrl, '\n');
            
            if (alertCallback) {
                alertCallback(serviceName.toUpperCase(), authUrl);
            }
            return null;
        }

        const token = fs.readFileSync(activeTokenPath, 'utf8');
        oAuth2Client.setCredentials(JSON.parse(token));
        
        cachedClients.set(serviceName, oAuth2Client);
        return oAuth2Client;
    } catch (error) {
        console.error(`❌ Error inicializando Google OAuth2 para ${serviceName}:`, error.message);
        return null;
    }
}

module.exports = {
    getOAuth2Client,
    setAlertCallback
};
