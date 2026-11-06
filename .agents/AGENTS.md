# Reglas y Configuración del Proyecto Whatbot

## Configuración del VPS Producción
- **Host**: `147.79.75.135`
- **Usuario**: `root`
- **Contraseña**: `Gianmarco0504.`
- **Directorio Bot en VPS**: `/root/whatbot`
- **Proceso PM2**: `whatbot`
- **Directorio Web Frontend**: `/var/www/sheerit.com.co`
- **Servidor Web**: Nginx con SSL (Certbot Let's Encrypt)

## Repositorios y Rutas Locales
- **Backend Whatbot**: `/Users/estebanavila/desarrollo/whatbot` (Rama `main`)
- **Frontend Sheeritpage**: `/Users/estebanavila/desarrollo/sheeritpage` (Rama `main`)

## Reglas de Despliegue y Commit
1. **Mensajes de Commit**: Todos los mensajes de commit de Git DEBEN ser escritos estrictamente **en español** (ej. `fix: corregir ruta absoluta de LocalAuth y reinicio limpio`).
2. **Flujo de Despliegue**: Al realizar cambios en el bot:
   - Hacer commit local.
   - Hacer `git push origin main` localmente.
   - Conectarse al VPS via SSH, ejecutar `git pull origin main` y reiniciar el bot con `pm2 restart whatbot` (únicamente bajo autorización).
3. **Flujo de Despliegue Web (Frontend)**:
   - Compilar localmente con `npm run build` en `sheeritpage`.
   - Transferir la carpeta generada: `scp -r dist/assets dist/index.html root@147.79.75.135:/var/www/sheerit.com.co/`.
   - Verificar permisos y correcta entrega de activos en Nginx.
4. **Limpieza de Sesión WhatsApp**: Si WhatsApp Web falla al iniciar (`Target closed`), hacer backup de `.wwebjs_auth`, limpiar archivos de bloqueo (`SingletonLock`, `SingletonSocket`) y reiniciar el servicio PM2.

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

---

## Arquitectura del Ecosistema Sheerit

```
┌────────────────────────────────────────────────────────────────────────┐
│                          PORTAL CLIENTES & ADMIN                       │
│              https://sheerit.co (React + Vite + Tailwind)              │
│                /var/www/sheerit.com.co (Servido por Nginx)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / REST / WebSockets
┌───────────────────────────────────▼────────────────────────────────────┐
│                       BACKEND WHATSAPP BOT & APIS                      │
│                Proceso Node.js (PM2: whatbot en VPS)                   │
├───────────────────────────────────┬────────────────────────────────────┤
│ • whatsapp-web.js (Puppeteer)     │ • Sincronización Microsoft Graph   │
│ • Sistema de Tickets y Colas      │ • OCR Pagos Gemini 3.8 Flash       │
│ • Motor Contable y Flujo de Caja  │ • Dinámica de Stock y Perfiles     │
└─────────────┬─────────────────────┴───────────────┬────────────────────┘
              │                                     │
┌─────────────▼──────────────┐        ┌─────────────▼────────────────────┐
│   MARIADB LOCAL (VPS)      │        │      MICROSOFT ONEDRIVE          │
│ • tickets & resolved_logs  │        │ • Documentos/neflis_negro.xlsx   │
│ • cash_flow_entries        │        │ • Auth Device Code Flow rotativo │
│ • account_renewals         │        │ • excel_cache.json (Fallback)    │
│ • streaming_costs          │        │ • pending_excel_updates.json     │
└────────────────────────────┘        └──────────────────────────────────┘
```

---

## Historial Detallado de Cambios, Despliegues y Módulos

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

### 7. Contabilidad Avanzada, Costos Implícitos y Registro de Salidas (`AccountingView.tsx`)
- **Problema 1 (Cuentas Owner y Compartidas con márgenes irreales):** Cuentas como Spotify Owner, YouTube Owner o Platzi Compartida arrojaban márgenes de 800,000% y costos inflados porque su costo base ya estaba amortizado en la cuenta matriz.
- **Solución 1:** En `accountingService.js` se definieron `IMPLICIT_COST_PLATFORMS` con `is_implicit_cost: true`, fijando su costo en `$0 COP`, cuentas compradas en `0 (En Matriz)` y margen limpio del 100%.
- **Problema 2 (Productos obsoletos):** Gamma y Xbox figuraban con egresos automáticos a pesar de ya no existir en la matriz de Excel.
- **Solución 2:** Se eliminaron los cargos automáticos de plataformas retiradas y se sincronizó con el catálogo real.
- **Problema 3 (Falta de registro exacto de salidas y método de pago en renovaciones):** En Excel los asesores registran vencimiento de cuenta matriz, CCV temporal, medio de pago o proveedor (ej. transferencias o 'net') de forma desestructurada, impidiendo cuadrar el flujo de caja real.
- **Solución 3:**
  * Se creó la tabla `account_renewals` en MariaDB (con campos: `account_email`, `platform`, `provider`, `payment_method`, `renewal_date`, `expiration_date`, `amount_paid`, `notes`, `registered_by`).
  * Se añadieron endpoints `/api/admin/accounting/renewals` (GET, POST `/save`, DELETE `/delete`).
  * Cada renovación registrada descuenta automáticamente del balance contable mensual.
  * Se implementó el panel modal interactivo en `sheerit.co/contabilidad` para consulta y registro rápido por asesores.

### 8. Corrección de Casilla Virgen al Cortar Servicio (`Nombre: ""` en vez de `"libre"`)
- **Problema:** Al liberar un cupo desde `ClientsView.tsx` ("Dejar casilla virgen"), el sistema guardaba literalmente `"libre"` en el campo `Nombre`, provocando que en Excel Online el perfil quedara registrado como si el cliente se llamara "libre".
- **Causa Raíz:** En `ClientsView.tsx` y en el endpoint `/api/admin/client/cut-service` se asignaba `"Nombre": "libre"` de forma explícita.
- **Solución:**
  * En `ClientsView.tsx` (líneas 319-320) y en `whatbot/index.js` (líneas 2078 y 5069) se sustituyó `"libre"` por cadena vacía `""`.
  * Se corrió un script de saneamiento contra Microsoft Graph API blanqueando todas las filas en OneDrive. Verificación actual: 0 filas con el texto `"libre"`.

### 9. Tabla Dinámica de Perfiles Libres y Stock en Tiempo Real (`AnalyticsDashboard.tsx`)
- **Objetivo:** Reproducir y potenciar la tabla dinámica de Excel que calcula cuántos perfiles libres quedan por cuenta y por plataforma, integrándola directamente en el módulo de Analítica web.
- **Implementación Técnica:**
  * **Endpoint `/api/admin/analytics/free-profiles`:** Agrupa en menos de 3ms todas las filas de la matriz viva de Excel calculando cupos totales, ocupados, libres, tasa de ocupación y desglose de cuentas maestras.
  * **Pestaña `Perfiles Libres y Stock (Dinámica)`:** Con badge contador en vivo (`summary.totalLibres`) y tarjeta de acceso directo en el panel de finanzas.
  * **4 KPIs Principales:** Perfiles Libres Totales, Cuentas con Disponibilidad, Ocupación Matriz y Alerta de Plataformas Agotadas (0 cupos).
  * **Doble Modo de Visualización:**
    - *Vista Dinámica por Plataforma*: Acordeón por servicio con barra visual de ocupación, listado de cuentas con botón de copiar correo, fecha de corte y desplegable de cupos (Fila de Excel, cliente o `✨ LIBRE`).
    - *Vista Plana de Cuentas*: Tabla tabular ordenada con búsqueda rápida y filtros (`Todas`, `🟢 Con Stock (>0)`, `🔴 Agotadas (0)`).
  * **Sincronización:** Botón "Sincronizar Stock" para forzar lectura inmediata contra OneDrive.

### 10. Corrección de Turnos Inflados (#300+) y Purgado de Estados (`supportScheduleService.js`)
- **Problema:** Los tickets en el panel mostraban números de turno superiores a 300 (ej. `Turno #301`, `Turno #355`) a pesar de haber solo ~30 tickets activos en la interfaz.
- **Causa Raíz:** En `user_states.json` habían quedado acumulados **272 estados en espera** (`waiting_human`) de meses anteriores sin cerrar. La función `getQueuePosition` los incluía a todos en la cola antes de los tickets nuevos.
- **Solución:**
  * Se actualizó `getQueuePosition` en `supportScheduleService.js` con una ventana de corte `MAX_QUEUE_AGE_MS = 48 horas`, computando únicamente chats con actividad reciente y donde el cliente esté activamente esperando.
  * Se ejecutó un script de saneamiento en el VPS marcando como `resolved` los 272 chats inactivos mayores a 7 días.
  * Resultado: La numeración de turnos es ahora real, consecutiva y limpia (ej. Steven pasó de #355 a **Turno #24**).

---

## Estructura de Tablas Clave en MariaDB

```sql
-- Historial de tickets resueltos por asesores
CREATE TABLE IF NOT EXISTS resolved_tickets_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(30) NOT NULL,
    customerName VARCHAR(100),
    agent VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    claimedAt DATETIME NULL,
    durationSeconds INT DEFAULT 0,
    resolvedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Registro exacto de salidas a proveedores por renovaciones
CREATE TABLE IF NOT EXISTS account_renewals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_email VARCHAR(150) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    provider VARCHAR(100) DEFAULT NULL,
    payment_method VARCHAR(100) DEFAULT NULL,
    renewal_date DATE NOT NULL,
    expiration_date DATE NOT NULL,
    amount_paid DECIMAL(12,2) NOT NULL,
    notes TEXT,
    registered_by VARCHAR(100) DEFAULT 'Admin',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Costos base de streaming y categorización
CREATE TABLE IF NOT EXISTS streaming_costs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    platform VARCHAR(50) NOT NULL UNIQUE,
    provider VARCHAR(100) DEFAULT 'Proveedor General',
    cost_per_account DECIMAL(12,2) NOT NULL,
    profiles_per_account INT DEFAULT 1,
    sale_price_per_profile DECIMAL(12,2) NOT NULL,
    total_cost DECIMAL(12,2) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## Guía Rápida de Comandos Administrativos (WhatsApp)

| Comando | Grupo / Chat | Descripción |
| :--- | :--- | :--- |
| `@bot estado` | Grupos Admin | Reporta salud de OneDrive, Antigravity CLI, WhatsApp Web y filas sincronizadas |
| `@bot renovar-onedrive` | Grupos Admin | Genera código Device Code de Microsoft para re-autorizar OneDrive en 1 clic |
| `@restart` / `!restart` | Grupos Admin | Reinicia de forma segura el proceso PM2 `whatbot` |
| `@aceptar` | Errors Bot (`120363427163636523@g.us`) | Aprueba y ejecuta directamente el commit en Git formulado por el CLI |
