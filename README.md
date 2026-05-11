# 🤖 Sheerit WhatBot Documentation

Este repositorio contiene el código fuente del bot de WhatsApp para **Sheerit**, encargado de automatizar ventas, gestión de credenciales y cobranza de servicios de streaming.

## 🌟 Características Principales

### 1. 🧠 Inteligencia Artificial (Gemini Powered)
El bot utiliza modelos de Google Gemini (`gemini-2.0-flash`, `gemini-3-flash`, etc.) para entender el lenguaje natural del usuario en puntos clave:
- **Intención de Compra**: Detecta qué plataformas, planes y periodos (mensual, anual) desea el usuario, incluso si lo escribe de forma coloquial (ej: _"Quiero netfi y disni por un año"_).
- **Métodos de Pago**: Identifica dinámicamente el banco o billetera que el usuario quiere usar (Nequi, Daviplata, Bancolombia, etc.).
- **Fallback Automático**: Si un modelo de IA falla o excede la cuota de uso, el sistema rota automáticamente a otro modelo disponible.

### 2. 🛒 Flujo de Compra Automatizado
- **Activación**: Opción 1 del menú o frase "Hola, estoy interesado en...".
- **Selección Inteligente**:
    1. El usuario dice qué quiere.
    2. La IA extrae los items (Plataformas/Planes).
    3. El bot valida contra `data/platforms.json`.
    4. Se calculan precios, descuentos por combo y ajustes por periodo (anual/semestral).
- **Proceso de Pago**: El bot entrega los datos de la cuenta bancaria correcta según la elección del usuario.

### 3. 🔐 Consulta de Credenciales
- **Activación**: Opción 2 del menú.
- **Funcionamiento**: Consulta la base de datos MySQL (`datos_de_cliente`, `perfil`, `datosCuenta`) usando el número de teléfono del usuario.
- **Resultado**: Entrega correo, contraseña, perfil, PIN y fecha de vencimiento de las cuentas activas.

### 4. 💰 Sistema de Cobranza (Modo Operador)
Comandos especiales para el administrador (definido en `OPERATOR_NUMBER`):
- **Calculadora de Cobros**: Enviando `@bot porfa haz los cobros para hoy de: <lista>`, el bot parsea la lista, contacta a los usuarios individualmente y gestiona las confirmaciones.
- **Liberar Sesión**: `liberar 3001234567` para desconectar al bot de un usuario y permitir atención humana. Se puede usar `liberar masivo` para reactivar a todos los que estaban en espera.
- **Atención de Pendientes (NUEVO)**: `@bot contesta los que estan sin contestar` o `@bot atiende pendientes`. El bot escanea a los usuarios en espera de un humano y les responde automáticamente con ayuda de la IA para retomar el servicio.
- **Confirmar Cobros**: `confirmar_cobros 3001234567` para registrar pagos manualmente.

### 5. 🤖 Inteligencia Colaborativa Avanzada (Actualizado - Mayo 2026)
- **Interceptor Global de Pagos & Vision**: Uso de **Gemini Vision** para detectar comprobantes bancarios, notificando al admin y confirmando al cliente automáticamente.
- **Validación Automática Gmail (Bre-B/QR)**: El bot monitorea en tiempo real la cuenta `jordimemes...` buscando correos de "Venta exitosa por Bre-B". Si el monto coincide con el comprobante enviado por el cliente en un margen de 60 min, el bot **valida y entrega el servicio automáticamente** sin intervención humana.
- **Auditoría de Pagos**: Las notificaciones administrativas incluyen el **Asunto** del correo y el ID de Gmail para una verificación rápida.
- **Deduplicación de Mensajes**: Sistema de caché global para evitar el procesamiento doble de mensajes en ráfagas (Race Conditions).

### 6. 📊 Dashboard Administrativo & Masivos (NUEVO)
- **Difusión Contextual Inteligente**: El bot recuerda de qué cuenta se está hablando. Puedes decir: *"Pasa esta cuenta a todos"* y luego refinar con *"Descarta los extra"* o *"Solo a los activos"*.
- **Reglas de Envío Inteligente**:
    - **Netflix Extra**: Se excluyen de recibir la clave principal por defecto (seguridad).
    - **Filtro de Vencimiento**: No se envían credenciales a clientes con más de 3 días de vencimiento (evita spam a churns).
    - **Enmascaramiento de Credenciales**: Los usuarios vencidos o "Extras" reciben la notificación pero con las claves ocultas (`[Oculto por falta de pago]`), incentivando la renovación.
- **Detector de Fallos Prematuros**: Identifica frases como *"mira lo que sale"* o *"no funciona"* en reportes de fallas técnicas, alertando al grupo de soporte de inmediato si la cuenta aún tiene días vigentes.

## 📂 Estructura del Proyecto

- `index.js`: **Cerebro Principal**. Maneja la conexión, orquesta estados y el sistema de deduplicación.
- `aiService.js`: **Módulo de IA**. Lógica de Gemini (Vision, Clasificación de intención, Refinamiento de Masivos).
- `adminQueries.js`: **Motor Analítico**. Procesa las consultas a la base de datos y aplica filtros de masivos.
- `gmailService.js`: Integración con la API de Gmail para validación de pagos y códigos.
- `apiService.js`: Integración con Azure Functions para el registro en Excel.

## 🚀 Comandos Administrativos (Desde el Grupo)

- `@bot confirmar [Número] [Plataforma]`: Valida un pago manualmente (rellena el carrito si estaba vacío).
- `@bot notifica a los de [Cuenta] que [Mensaje]`: Inicia el flujo de envío masivo con pre-visualización.
- `@bot descarta los [Palabra Clave]`: Filtra la lista de envío masivo actual.
- `@bot solo los activos`: Filtra la lista para incluir solo cuentas no vencidas.

## 🚀 Cómo Iniciar

1. **Instalar dependencias**: `npm install`
2. **Configurar entorno**: Asegúrate de tener el archivo `.env` y las credenciales en `/tokens`.
3. **Iniciar**: `npm start` o `pm2 start index.js --name whatbot`.

---

# 🚀 Roadmap de Modernización

## 📌 Estado del Proyecto
- [x] **Fase 1:** Estabilización y Deduplicación (Completado)
- [x] **Fase 2:** Automatización de Pagos Gmail/Bre-B (Completado)
- [x] **Fase 3:** Dashboard Administrativo Contextual (Completado)
- [ ] **Fase 4:** Autenticación Web & Redis (OTP)
- [ ] **Fase 5:** Panel Web de Gestión Directa

---
*(Documentación actualizada al 11 de Mayo de 2026)*