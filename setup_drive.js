const readline = require('readline');
const { getOAuth2Client } = require('./googleAuthService');

async function main() {
    console.log("=== CONFIGURACIÓN DE GOOGLE DRIVE BACKUPS ===");
    // Intentar inicializar sin código primero para generar la URL si no existe el token
    const client = await getOAuth2Client('drive');
    
    if (client) {
        console.log("✅ Google Drive ya está autorizado y el token está activo.");
        process.exit(0);
    }
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    rl.question('\n👉 Ingresa el código de autorización obtenido de la URL de arriba: ', async (code) => {
        rl.close();
        try {
            const authorizedClient = await getOAuth2Client('drive', code.trim());
            if (authorizedClient) {
                console.log("🎉 ¡Configuración de Google Drive completada con éxito!");
            } else {
                console.log("❌ Error autorizando Google Drive. Verifica el código.");
            }
        } catch (e) {
            console.error("❌ Error en la autorización:", e.message);
        }
        process.exit(0);
    });
}

main().catch(console.error);
