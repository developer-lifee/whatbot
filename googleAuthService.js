const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Scopes específicos por servicio
const SERVICE_SCOPES = {
    'contacts': ['https://www.googleapis.com/auth/contacts'],
    'gmail': ['https://www.googleapis.com/auth/gmail.readonly'],
    'drive': ['https://www.googleapis.com/auth/drive.file']
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
 * @param {string} email - Opcional. El correo específico para buscar su token en tokens/
 */
async function getOAuth2Client(serviceName = 'contacts', code = null, email = null) {
    const cacheKey = email ? `${serviceName}_${email}` : serviceName;
    if (cachedClients.has(cacheKey) && !code) return cachedClients.get(cacheKey);

    // Permitir archivo de credenciales específico por servicio
    let activeCredentialsPath = CREDENTIALS_PATH;
    if (serviceName === 'gmail') {
        const specificGmailCreds = path.join(__dirname, 'credentials_pagos.json');
        if (fs.existsSync(specificGmailCreds)) {
            activeCredentialsPath = specificGmailCreds;
            console.log(`[GOOGLE AUTH] Usando credenciales específicas de PAGOS para GMAIL: ${activeCredentialsPath}`);
        }
    } else if (serviceName === 'drive') {
        const specificDriveCreds = path.join(__dirname, 'credentials_drive.json');
        if (fs.existsSync(specificDriveCreds)) {
            activeCredentialsPath = specificDriveCreds;
            console.log(`[GOOGLE AUTH] Usando credenciales específicas para DRIVE: ${activeCredentialsPath}`);
        }
    }

    if (!fs.existsSync(activeCredentialsPath)) {
        console.error(`❌ No se encontró el archivo de credenciales (${activeCredentialsPath}). Servicio ${serviceName} deshabilitado.`);
        return null;
    }

    try {
        const content = fs.readFileSync(activeCredentialsPath, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';

        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
        
        // Determinar ruta del token
        let tokenPath;
        if (email) {
            const safeEmail = email.toLowerCase().trim();
            tokenPath = path.resolve(__dirname, 'tokens', `token_${safeEmail}.json`);
        } else {
            tokenPath = path.resolve(__dirname, `token_${serviceName}.json`);
        }
        
        const legacyTokenPath = path.resolve(__dirname, `token.json`);
        console.log(`[GOOGLE AUTH DEBUG] Buscando token en: ${tokenPath}`);

        // Si recibimos un código, intentamos generar el token y guardarlo
        if (code) {
            console.log(`[GOOGLE AUTH] Intentando canjear código para ${serviceName}...`);
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(tokenPath, JSON.stringify(tokens));
            console.log(`✅ Token para ${serviceName}${email ? ' ('+email+')' : ''} guardado con éxito en ${tokenPath}`);
            cachedClients.set(cacheKey, oAuth2Client);
            return oAuth2Client;
        }

        // Si no existe el token específico, probamos con el token genérico (solo para el servicio contacts)
        let activeTokenPath = tokenPath;
        if (serviceName === 'contacts' && !fs.existsSync(tokenPath) && fs.existsSync(legacyTokenPath)) {
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
        
        cachedClients.set(cacheKey, oAuth2Client);
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
