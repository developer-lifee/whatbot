const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, '..', 'token_gmail.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials_gmail.json');

async function testGmail() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('❌ Error: No se encontró credentials_gmail.json en la raíz.');
        return;
    }
    if (!fs.existsSync(TOKEN_PATH)) {
        console.error('❌ Error: No se encontró token_gmail.json en la raíz. Debes generarlo con setup_gmail.js');
        return;
    }

    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

    try {
        console.log('⏳ Intentando leer los últimos 5 correos...');
        const res = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 5,
        });

        const messages = res.data.messages;
        if (messages && messages.length > 0) {
            console.log('✅ ¡Conexión exitosa! Mensajes encontrados:');
            for (const msg of messages) {
                const details = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                });
                console.log(`- ID: ${msg.id} | Snippet: ${details.data.snippet.substring(0, 50)}...`);
            }
        } else {
            console.log('ℹ️ Conexión exitosa, pero no se encontraron mensajes en la bandeja de entrada.');
        }
    } catch (err) {
        console.error('❌ Error al acceder a Gmail API:', err.message);
        if (err.message.includes('insufficient authentication scopes')) {
            console.error('\n⚠️ EL TOKEN NO TIENE PERMISOS SUFICIENTES.');
            console.error('Solución: Borra token_gmail.json y vuelve a correr node setup_gmail.js asegurándote de usar los scopes correctos.');
        }
    }
}

testGmail();
