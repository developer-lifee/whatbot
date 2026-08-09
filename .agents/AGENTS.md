# Reglas y Configuración del Proyecto Whatbot

## Configuración del VPS Producción
- **Host**: `147.79.75.135`
- **Usuario**: `root`
- **Contraseña**: `Gianmarco0504.`
- **Directorio Bot en VPS**: `/root/whatbot`
- **Proceso PM2**: `whatbot`

## Reglas de Despliegue y Commit
1. **Mensajes de Commit**: Todos los mensajes de commit de Git DEBEN ser escritos estrictamente **en español** (ej. `fix: corregir ruta absoluta de LocalAuth y reinicio limpio`).
2. **Flujo de Despliegue**: Al realizar cambios en el bot:
   - Hacer commit local.
   - Hacer `git push origin main` localmente.
   - Conectarse al VPS via SSH, ejecutar `git pull origin main` y reiniciar el bot con `pm2 restart whatbot`.
3. **Limpieza de Sesión WhatsApp**: Si WhatsApp Web falla al iniciar (`Target closed`), hacer backup de `.wwebjs_auth`, limpiar archivos de bloqueo (`SingletonLock`, `SingletonSocket`) y reiniciar el servicio PM2.
