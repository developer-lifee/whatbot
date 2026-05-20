const readline = require('readline');
const { saveSecret, loadSecrets } = require('./totpService');
const { authenticator } = require('@otplib/preset-default');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('=============================================');
console.log('🔐 CONFIGURACIÓN DE SECRETOS GPT (2FA)');
console.log('=============================================');

function mainMenu() {
    console.log('\nOpciones:');
    console.log('1. Agregar/Actualizar secreto de cuenta');
    console.log('2. Listar cuentas configuradas');
    console.log('3. Eliminar cuenta');
    console.log('4. Monitor de Códigos en Vivo');
    console.log('5. Salir');
    
    rl.question('\n👉 Elige una opción: ', (opt) => {
        switch(opt) {
            case '1':
                addSecret();
                break;
            case '2':
                listSecrets();
                break;
            case '3':
                deleteSecret();
                break;
            case '4':
                startMonitor();
                break;
            case '5':
                rl.close();
                break;
            default:
                console.log('Opción inválida.');
                mainMenu();
        }
    });
}

function addSecret() {
    rl.question('\n📧 Ingresa el correo de la cuenta GPT: ', (email) => {
        rl.question('🔑 Ingresa la LLAVE/SECRETO (TOTP seed): ', (secret) => {
            if (!email || !secret) {
                console.log('❌ Error: El correo y el secreto son obligatorios.');
            } else {
                saveSecret(email, secret);
                console.log(`✅ Secreto guardado exitosamente para ${email}`);
            }
            mainMenu();
        });
    });
}

function listSecrets() {
    const secrets = loadSecrets();
    const emails = Object.keys(secrets);
    if (emails.length === 0) {
        console.log('\n📭 No hay cuentas configuradas.');
    } else {
        console.log('\n📋 Cuentas configuradas:');
        emails.forEach(e => console.log(`- ${e}`));
    }
    mainMenu();
}

function deleteSecret() {
    rl.question('\n📧 Ingresa el correo de la cuenta a eliminar: ', (email) => {
        const secrets = loadSecrets();
        const key = email.toLowerCase().trim();
        if (secrets[key]) {
            delete secrets[key];
            const SECRETS_FILE = path.join(__dirname, 'tokens', 'gpt_secrets.json');
            fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
            console.log(`✅ Cuenta ${email} eliminada.`);
        } else {
            console.log(`❌ No se encontró la cuenta ${email}.`);
        }
        mainMenu();
    });
}

function startMonitor() {
    const secrets = loadSecrets();
    const emails = Object.keys(secrets);

    if (emails.length === 0) {
        console.log('\n📭 No hay cuentas configuradas para monitorear.');
        return mainMenu();
    }

    const renderCodes = () => {
        process.stdout.write('\x1Bc'); // Clear console
        console.log('=============================================');
        console.log('👁️  MONITOR DE CÓDIGOS TOTP EN VIVO');
        console.log('Presiona Ctrl+C para salir del monitor.');
        console.log('=============================================\n');
        
        const now = new Date();
        console.log(`⏱️ Última actualización: ${now.toLocaleTimeString('es-CO')}\n`);

        emails.forEach(email => {
            const secret = secrets[email];
            try {
                const code = authenticator.generate(secret);
                const timeRemaining = authenticator.timeRemaining();
                console.log(`📧 Cuenta: ${email}`);
                console.log(`🔢 Código: \x1b[32m${code}\x1b[0m (Válido por ${timeRemaining}s)\n`);
            } catch (error) {
                console.log(`📧 Cuenta: ${email} - Error generando código.\n`);
            }
        });
    };

    renderCodes();
    setInterval(renderCodes, 2000);
}

mainMenu();
