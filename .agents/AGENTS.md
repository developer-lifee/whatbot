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
   - Cuando se escriba `@aceptar` (o se cite la propuesta con `@aceptar`), el CLI ejecuta directamente el commit en Git en el VPS y reporta el hash y archivos afectados.

## Historial de Cambios y Despliegues (24 de Septiembre de 2026)

### 1. Corrección de Ruta Web Portal Clientes (`sheerit.co/actualizar/`)
- **Problema:** Nginx arrojaba error `403 Forbidden` al ingresar a `https://sheerit.co/actualizar/`.
- **Causa Raíz:** Existía un directorio físico heredado `/var/www/sheerit.com.co/actualizar` con un script PHP viejo y sin `index.html`. Nginx priorizaba la carpeta física y bloqueaba el acceso.
- **Solución:** Se renombró la carpeta legacy a `actualizar_legacy`. La ruta ahora retorna `HTTP 200 OK` y sirve limpiamente la SPA de React (`VerificationPage`).

### 2. Prevención de Cobros Indebidos (Avisos de Cobro Prematuros)
- **Problema:** Clientes con renovación ya pagada y asentada en Excel Online (ej. Jorge Fonseca hasta 2027) recibían recordatorios diarios de cobro basados en fechas viejas de `Columna4` (ej. Septiembre 2026).
- **Causa Raíz:** `apiService.js` mapeaba `cliente.deben = cliente.Columna4;` cuando la celda `deben` estaba vacía, ignorando la columna visible `vencimiento` que los asesores actualizan manualmente en Excel.
- **Solución:** En `apiService.js` y `billingService.js`, se implementó la resolución de fecha de vencimiento más reciente entre `vencimiento`, `Columna4` y `deben`. Si cualquiera de las fechas es futura, se bloquea terminantemente el envío del recordatorio de cobro.

### 3. Corrección del OCR de Comprobantes de Pago
- **Problema:** Comprobantes bancarios legítimos (Bancolombia en modo oscuro, Nequi con QR Bre-V) eran rechazados por el bot diciendo *"No pude identificar esta imagen como un comprobante de pago bancario"*.
- **Causa Raíz:** Modelos de Gemini desactualizados en el array `MODELS` y falta de manejo de fallback cuando la API arrojaba error o cuota, derivando en rechazo falso en lugar de transferencia a validación manual.
- **Solución:** Se actualizaron los modelos a `gemini-3.8-flash` y `gemini-3.5-flash`, se mejoraron los prompts con reconocimiento específico de modo oscuro y Bre-V, y se añadió fallback para notificar al grupo de administración en caso de fallo técnico en lugar de rechazar al cliente.

### 4. Actualización de Credenciales Netflix (`prime44544@gmail.com`)
- **Problema:** El bot entregó la contraseña vieja `rikoshe` al cliente Cristian Prieto a las 4:43 PM, obligando a un asesor a entregar manualmente la contraseña real `panini26col` a las 5:00 PM y reportar la falla en el grupo.
- **Causa Raíz:** El secreto de cliente de Microsoft Azure/Graph para sincronizar el Excel de OneDrive está expirado (error HTTP 500), por lo que el bot recurría a `excel_cache.json` donde aún permanecía la contraseña anterior en las filas 709 a 713 y 828-829.
- **Solución:** Se actualizaron todas las filas de `prime44544@gmail.com` en `excel_cache.json` en local y en el VPS con la clave vigente `panini26col`.

### 5. Integración Oficial de Antigravity CLI (`agy`) y Flujo de Aprobación
- **Implementación:**
  * Se instaló el binario oficial de Antigravity CLI (`agy` v1.2.10) en `/usr/local/bin/agy` y se configuraron las librerías `gnome-keyring`, `libsecret` y `dbus`.
  * Se vinculó con la cuenta oficial `nigadiagama@gmail.com` y el modelo `Gemini 3.8 Flash (High)`.
  * Se implementó el servicio `cliAgentService.js` y el comando global `agy-cli`.
  * Al recibir un error en `Errors bot` (`120363427163636523@g.us`), el CLI formula la causa raíz, plan y commit.
  * Al responder con `@aceptar`, el CLI ejecuta directamente el `git commit` en el repositorio del VPS y notifica con el hash generado.
  * Se mantiene la prohibición estricta de reinicio automático de PM2.



### 6. Renovación Integral de OneDrive Graph API, Alertas Proactivas y Comando @restart
- **Problema:** El token de acceso y refresh token de Microsoft Graph API estaban desactualizados/expirados, provocando que las lecturas y escrituras al archivo `Documentos/neflis_negro.xlsx` en OneDrive fallaran silenciosamente y recurrieran al `excel_cache.json` desactualizado sin que los administradores recibieran una alerta inmediata.
- **Solución y Mejoras Desarrolladas:**
  * **Módulo `oneDriveAuthService.js`:** Implementación con `@azure/msal-node` utilizando el flujo público Device Code Flow (`Files.Read Files.Read.All Files.ReadWrite.All offline_access`). Permite renovar el token en cualquier momento sin tocar la consola ni servidores.
  * **Token Renovado:** Se autorizó exitosamente con Microsoft la sesión de OneDrive, capturando un nuevo Refresh Token rotativo y sincronizando inmediatamente 1,114 filas vivas de Excel Online y 51 actualizaciones pendientes.
  * **Monitoreo Proactivo de Salud:** En `apiService.js`, se implementó `recordOneDriveHealth()`, `getOneDriveHealth()` y `notifyAdminOfOneDriveIssue()` que envía alertas automáticas a los grupos administrativos (`120363102144405222@g.us` y `120363427163636523@g.us`) ante cualquier fallo de sincronización con OneDrive o caída al fallback de caché (con límite inteligente de 1 alerta cada 4 horas para no saturar).
  * **Comandos de Autoservicio en WhatsApp:**
    - `@bot renovar-onedrive`: Genera un código de dispositivo de Microsoft y enlace directo en el chat para que cualquier administrador autorice OneDrive desde su celular/navegador en segundos.
    - `@bot estado`: Informa el estado en tiempo real de OneDrive, Antigravity CLI, WhatsApp Web y la fecha/hora de la última sincronización.
    - `@restart` / `!restart`: Permite a los administradores reiniciar el proceso PM2 de forma segura directamente desde WhatsApp.
  * **Endpoints Web de Administración:** Se expuso `/api/admin/system-health` y `/api/admin/onedrive/renew` para monitorear el estado y forzar renovaciones desde el dashboard web administrativo.
- **Despliegue:** Sincronizado en VPS y reiniciado en PM2 bajo autorización explícita.
