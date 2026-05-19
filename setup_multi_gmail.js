const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { google } = require('googleapis');

// Scopes requeridos para leer correos
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// Asegurar que la carpeta tokens existe
const TOKENS_DIR = path.join(__dirname, 'tokens');
if (!fs.existsSync(TOKENS_DIR)) {
    fs.mkdirSync(TOKENS_DIR);
}

// Cargar credenciales: Priorizamos credentials_pagos.json si existe
const credFile = fs.existsSync('credentials_pagos.json') ? 'credentials_pagos.json' : 'credentials.json';

if (!fs.existsSync(credFile)) {
    console.error(`❌ Error: No se encontró el archivo de credenciales (${credFile}).`);
    process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

console.log('=============================================');
console.log('🚀 CONFIGURACIÓN MULTI-CUENTA GMAIL');
console.log('=============================================\n');

rl.question('📧 Ingresa el correo electrónico que deseas vincular: ', (email) => {
    if (!email || !email.includes('@')) {
        console.error('❌ Email no válido.');
        rl.close();
        return;
    }

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    const safeEmail = email.toLowerCase().trim();
    const tokenPath = path.join(TOKENS_DIR, `token_${safeEmail}.json`);

    if (fs.existsSync(tokenPath)) {
        console.log(`⚠️ Ya existe un token para ${email}.`);
        rl.question('¿Deseas sobrescribirlo? (si/no): ', (ans) => {
            if (ans.toLowerCase() === 'si') {
                getNewToken(oAuth2Client, email, tokenPath);
            } else {
                console.log('Operación cancelada.');
                rl.close();
            }
        });
    } else {
        getNewToken(oAuth2Client, email, tokenPath);
    }
});

function getNewToken(oAuth2Client, email, tokenPath) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });

    console.log('\n---------------------------------------------');
    console.log(`🔐 AUTORIZACIÓN PARA: ${email}`);
    console.log('---------------------------------------------');
    console.log('1. Abre esta URL en tu navegador web:');
    console.log('\n' + authUrl + '\n');
    console.log('2. Inicia sesión con la cuenta de Gmail especificada.');
    console.log('3. Acepta los permisos.');
    console.log('4. Pega aquí el código (o la URL completa si falló el localhost):');

    rl.question('\n👉 Ingresa el código/URL aquí: ', (codeOrUrl) => {
        rl.close();
        
        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
            const urlParts = new URL(codeOrUrl);
            code = urlParts.searchParams.get('code');
        }

        oAuth2Client.getToken(code, (err, token) => {
            if (err) return console.error('❌ Error recuperando token de acceso:', err);
            
            fs.writeFileSync(tokenPath, JSON.stringify(token));
            console.log(`\n✅ ¡ÉXITO! Token guardado para ${email}`);
            console.log(`📍 Ubicación: ${tokenPath}`);
            console.log('---------------------------------------------\n');
        });
    });
}
