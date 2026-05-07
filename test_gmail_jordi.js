const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Configuración específica para el correo de Jordi
const EMAIL_IDENTIFIER = 'jordimemesmomazosdick@gmail.com';
const TOKEN_PATH = path.join(__dirname, 'token_gmail.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json'); // Usamos el credentials.json que ya tienes

async function testGmailJordi() {
    console.log(`\n🔍 --- INICIANDO TEST DE GMAIL PARA: ${EMAIL_IDENTIFIER} ---`);

    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('❌ Error: No se encontró credentials.json en la raíz del proyecto.');
        return;
    }
    if (!fs.existsSync(TOKEN_PATH)) {
        console.error(`❌ Error: No se encontró token_gmail.json.`);
        console.error(`Este archivo es necesario para que el bot lea el correo ${EMAIL_IDENTIFIER}.`);
        console.error(`Acción: Ejecuta 'node setup_gmail.js' para generarlo.`);
        return;
    }

    try {
        const content = fs.readFileSync(CREDENTIALS_PATH);
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));

        const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

        console.log('⏳ Intentando conectar con la API de Google...');
        
        // Verificamos el perfil para confirmar la cuenta
        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log(`✅ Conexión establecida con la cuenta: ${profile.data.emailAddress}`);

        if (profile.data.emailAddress !== EMAIL_IDENTIFIER) {
            console.warn(`⚠️ ATENCIÓN: Estás conectado a ${profile.data.emailAddress}, pero esperabas ${EMAIL_IDENTIFIER}.`);
        }

        console.log('📬 Recuperando los últimos 5 correos...');
        const res = await gmail.users.messages.list({
            userId: 'me',
            maxResults: 5,
        });

        const messages = res.data.messages;
        if (messages && messages.length > 0) {
            console.log('--- Resumen de correos ---');
            for (const msg of messages) {
                const details = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                });
                console.log(`- [${msg.id}] Snippet: ${details.data.snippet.substring(0, 70)}...`);
            }
            console.log('\n✨ ¡TODO PARECE ESTAR CORRECTO! El bot podrá leer tus pagos.');
        } else {
            console.log('ℹ️ La conexión funciona, pero la bandeja de entrada está vacía.');
        }

    } catch (err) {
        console.error('\n❌ ERROR DETECTADO:');
        console.error(err.message);
        
        if (err.message.includes('insufficient authentication scopes')) {
            console.error('\n🛑 CAUSA: El token actual no tiene permisos de LECTURA.');
            console.error('SOLUCIÓN:');
            console.error('1. Borra el archivo token_gmail.json del servidor.');
            console.error('2. Ejecuta: node setup_gmail.js');
            console.error('3. Sigue el enlace y asegúrate de marcar la casilla "Ver tus mensajes de correo electrónico" en Google.');
        }
    }
}

testGmailJordi();
