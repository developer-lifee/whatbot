// Configuración PM2 de whatbot.
// kill_timeout: tiempo que PM2 espera tras SIGINT antes de enviar SIGKILL. El valor por defecto (1600 ms)
// no alcanza para que client.destroy() cierre Chromium, que queda muerto o huérfano a mitad de escritura del perfil.
module.exports = {
    apps: [
        {
            name: 'whatbot',
            script: 'index.js',
            cwd: __dirname,
            exec_mode: 'fork',
            instances: 1,
            kill_timeout: 15000,
            treekill: true,
            exp_backoff_restart_delay: 3000,
            autorestart: true
        }
    ]
};
