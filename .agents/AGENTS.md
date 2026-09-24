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

## Reglas del Asistente CLI y Flujo con Grupo 'Errors bot'
1. **PROHIBICIÓN ESTRICTA DE REINICIO AUTOMÁTICO**:
   - El CLI / agente NUNCA debe ejecutar automáticamente `pm2 start` ni `pm2 restart` en el VPS sin autorización explícita previa del usuario.
   - El servidor permanecerá corriendo para permitir la acumulación y revisión de soluciones sin interrupciones.
2. **COMMITS ALTAMENTE DETALLADOS**:
   - Cada cambio de código debe registrarse en Git con un commit altamente descriptivo que especifique:
     * Causa raíz del error.
     * Módulos, funciones y líneas modificadas.
     * Justificación técnica de por qué la solución previene la recurrencia.
   - Esto permite al usuario saber exactamente qué se modificó antes de decidir cuándo reiniciar o corregir.
3. **RESPUESTA DE PLAN DE RESOLUCIÓN EN WHATSAPP**:
   - Ante cualquier reporte de error en el grupo `Errors bot` (`120363427163636523@g.us`), el bot debe retornar un mensaje detallando:
     * Diagnóstico de Causa Raíz.
     * Plan de resolución que el CLI aplicó/diseñó en el código.
     * Resumen del commit detallado.
4. **FLUJO DE ITERACIÓN Y CONFIRMACIÓN CON @aceptar**:
   - El equipo en el grupo puede seguir conversando e iterando sobre la solución en el chat.
   - Cuando se escriba `@aceptar` (o se cite la propuesta con `@aceptar`), el bot marcará formalmente la solución como aceptada y lista para despliegue manual.

