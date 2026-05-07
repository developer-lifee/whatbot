const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

// Scopes requeridos para leer correos
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// Ruta donde se guardará tu token de Gmail
const TOKEN_PATH = 'token_gmail.json';

// Cargar credenciales: Priorizamos credentials_pagos.json si existe
const credFile = fs.existsSync('credentials_pagos.json') ? 'credentials_pagos.json' : 'credentials.json';

fs.readFile(credFile, (err, content) => {
  if (err) return console.log(`❌ Error cargando ${credFile} (¿Seguro que descargaste el archivo de Google Cloud?):`, err);
  
  console.log(`ℹ️ Cargando credenciales desde: ${credFile}`);
  // Autorizar al cliente
  authorize(JSON.parse(content), auth => {
     console.log('✅ Autorización exitosa. Ahora el bot tiene acceso a Gmail usando token_gmail.json');
  });
});

function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
  let redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  
  console.log('=============================================');
  console.log('🔐 AUTORIZACIÓN DE GMAIL REQUERIDA');
  console.log('=============================================');
  console.log('1. Abre esta URL en tu navegador web:');
  console.log('\n' + authUrl + '\n');
  console.log('2. Inicia sesión con la cuenta de Gmail donde recibes los avisos de pago.');
  console.log('3. Dale a "Continuar" para aceptar los permisos de lectura de Gmail.');
  console.log('4. Si Google te da un código, cópialo. (Si la URL dice error de conexión en localhost, copia TODO lo que diga "code=..." en la barra de direcciones.)');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  rl.question('\n👉 Ingresa el código obtenido aquí: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('❌ Error recuperando token de acceso:', err);
      oAuth2Client.setCredentials(token);
      
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('✅ Token de Gmail almacenado exitosamente en', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}
