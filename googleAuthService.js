const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Paths to your credentials and token files
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// Combined scopes for both Contacts and Gmail
const SCOPES = [
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/gmail.readonly'
];

let cachedClient = null;

/**
 * Initializes or returns the cached Google OAuth2 client.
 */
function getOAuth2Client() {
    if (cachedClient) return cachedClient;

    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('❌ No se encontró credentials.json. Google APIs deshabilitadas.');
        return null;
    }

    try {
        const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';

        cachedClient = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        if (!fs.existsSync(TOKEN_PATH)) {
            const authUrl = cachedClient.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'consent'
            });
            console.warn('\n⚠️ [GOOGLE AUTH] Se requiere re-autorización debido a los nuevos permisos (Gmail).');
            console.warn('👉 Abre este enlace en tu navegador:\n', authUrl, '\n');
            return null;
        }

        const token = fs.readFileSync(TOKEN_PATH, 'utf8');
        cachedClient.setCredentials(JSON.parse(token));
        
        // Return the client even if it might be expired (it handles refresh internally with the refresh_token)
        return cachedClient;
    } catch (error) {
        console.error('❌ Error inicializando Google OAuth2:', error.message);
        return null;
    }
}

module.exports = {
    getOAuth2Client,
    SCOPES,
    TOKEN_PATH
};
