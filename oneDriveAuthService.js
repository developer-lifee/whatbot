const msal = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');

const MS_TOKEN_PATH = path.join(__dirname, 'ms_graph_token.json');
const CLIENT_ID = "dd590625-bd57-487f-94c9-c8fb4c44ebfb";
const TENANT_ID = "common";

const config = {
    auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    }
};

let activeRenewalSession = false;

/**
 * Inicia el flujo Device Code para renovar el token de OneDrive
 * y llama a onCodeReceived con la URL y el código para enviarlo por WhatsApp.
 */
async function startOneDriveRenewal(onCodeReceived) {
    if (activeRenewalSession) {
        throw new Error("Ya hay una sesión de vinculación activa en curso. Revisa el código enviado previamente.");
    }

    activeRenewalSession = true;
    const pca = new msal.PublicClientApplication(config);

    const getTokenRequest = {
        scopes: ["Files.Read", "Files.Read.All", "Files.ReadWrite.All", "offline_access"],
        deviceCodeCallback: (response) => {
            console.log(`[OneDrive Auth] 🔑 Código generado: ${response.userCode}`);
            if (typeof onCodeReceived === 'function') {
                onCodeReceived({
                    userCode: response.userCode,
                    verificationUri: response.verificationUri || 'https://microsoft.com/devicelogin',
                    message: response.message
                });
            }
        }
    };

    try {
        const response = await pca.acquireTokenByDeviceCode(getTokenRequest);
        const tokenCache = pca.getTokenCache().serialize();
        const parsedCache = JSON.parse(tokenCache);

        let refreshToken = "";
        if (parsedCache.RefreshToken) {
            const keys = Object.keys(parsedCache.RefreshToken);
            if (keys.length > 0) {
                refreshToken = parsedCache.RefreshToken[keys[0]].secret;
            }
        }

        if (refreshToken) {
            const tokenData = {
                client_id: CLIENT_ID,
                refresh_token: refreshToken,
                updated_at: new Date().toISOString()
            };
            fs.writeFileSync(MS_TOKEN_PATH, JSON.stringify(tokenData, null, 2), 'utf8');
            console.log('[OneDrive Auth] ✅ Nuevo Refresh Token guardado exitosamente en ms_graph_token.json');
            activeRenewalSession = false;
            return { success: true, tokenData };
        } else {
            activeRenewalSession = false;
            throw new Error("No se pudo extraer el Refresh Token del caché de autenticación.");
        }
    } catch (err) {
        activeRenewalSession = false;
        console.error('[OneDrive Auth] ❌ Error en acquireTokenByDeviceCode:', err.message);
        throw err;
    }
}

/**
 * Verifica la salud del token de OneDrive
 */
function getOneDriveTokenInfo() {
    try {
        if (!fs.existsSync(MS_TOKEN_PATH)) {
            return { exists: false, status: 'MISSING' };
        }
        const data = JSON.parse(fs.readFileSync(MS_TOKEN_PATH, 'utf8'));
        return {
            exists: true,
            updatedAt: data.updated_at || null,
            clientId: data.client_id || CLIENT_ID,
            status: 'CONFIGURED'
        };
    } catch (e) {
        return { exists: false, status: 'ERROR', error: e.message };
    }
}

module.exports = {
    startOneDriveRenewal,
    getOneDriveTokenInfo,
    CLIENT_ID
};
