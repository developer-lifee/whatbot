const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

// Scopes requeridos para gestionar contactos
const SCOPES = ['https://www.googleapis.com/auth/contacts'];
// Ruta donde se guardará tu token
const TOKEN_PATH = 'token.json';

// Cargar credenciales desde credentials.json
fs.readFile('credentials.json', (err, content) => {
  if (err) return console.log('❌ Error cargando credentials.json (¿Seguro que descargaste el archivo de Google Cloud?):', err);
  
  // Autorizar al cliente
  authorize(JSON.parse(content), auth => {
     console.log('✅ Autorización exitosa. Ahora el bot tiene acceso usando token.json');
  });
});

/**
 * Crea un cliente OAuth2 y pide autorización a los usuarios.
 * @param {Object} credentials Las credenciales de autorización.
 * @param {function} callback Función callback.
 */
function authorize(credentials, callback) {
  const {client_secret, client_id, redirect_uris} = credentials.installed || credentials.web;
  
  // URL de redirección (usualmente http://localhost)
  let redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
  
  const oAuth2Client = new google.auth.OAuth2(
      client_id, client_secret, redirectUri);

  // Intentar leer el token ya almacenado
  fs.readFile(TOKEN_PATH, (err, token) => {
    if (err) return getNewToken(oAuth2Client, callback);
    oAuth2Client.setCredentials(JSON.parse(token));
    callback(oAuth2Client);
  });
}

/**
 * Genera una nueva URL para enviar al usuario, le pide el código y guarda el token.
 * @param {google.auth.OAuth2} oAuth2Client El cliente OAuth2.
 * @param {getEventsCallback} callback Función callback a ejecutar de vuelta.
 */
function getNewToken(oAuth2Client, callback) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  
  console.log('=============================================');
  console.log('🔐 AUTORIZACIÓN DE GOOGLE REQUERIDA');
  console.log('=============================================');
  console.log('1. Abre esta URL en tu navegador web:');
  console.log('\n' + authUrl + '\n');
  console.log('2. Inicia sesión con la cuenta de Gmail de tu celular.');
  console.log('3. Dale a "Continuar" para aceptar los permisos de Contactos.');
  console.log('4. Si Google Cloud te da un código, cópialo. (Si la URL dice error de conexión (localhost) en tu navegador, copia en todo caso TODO LO QUE DIGA "code=..." en la barra de direcciones.)');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  rl.question('\n👉 Ingresa el código obtenido aquí: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('❌ Error recuperando token de acceso:', err);
      oAuth2Client.setCredentials(token);
      
      // Guardar el token en el disco para futuras ejecuciones
      fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log('✅ Token almacenado exitosamente en', TOKEN_PATH);
      });
      callback(oAuth2Client);
    });
  });
}
