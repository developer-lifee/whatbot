# 🤖 Sheerit WhatBot - Documentación Integral de Arquitectura

Este repositorio contiene el código fuente del ecosistema de automatización de WhatsApp para **Sheerit Store / PueblApp**, encargado de orquestar ventas en línea, atención al cliente con IA generativa, búsqueda semántica vectorial (RAG), validación automática de pagos bancarios (Bre-V / Nequi / PSE / Bold), asignación y renovación de suscripciones de streaming y panel multi-agente para asesores humanos.

---

## 🌟 Características Principales del Sistema

```mermaid
flowchart TD
    A["📱 Mensaje de WhatsApp (Cliente)"] --> B["⚡ Deduplicador & Batch Processor (index.js)"]
    B --> C{"¿Es Comprobante / Imagen?"}
    C -->|Sí| D["👁️ Gemini Vision OCR & Gmail Bre-B Matcher"]
    C -->|No| E["🔍 Gemini Embeddings RAG (ragKnowledgeService.js)"]
    E --> F["🧠 DeepSeek V3 / Gemini 2.0 Flash (aiService.js)"]
    F --> G{"¿Tipo de Acción?"}
    G -->|Consulta Credenciales| H["🔐 Consulta MariaDB / Excel (billingService.js)"]
    G -->|Solicitud 2FA / Hogar| I["📬 Búsqueda Automática en Gmail (gmailService.js)"]
    G -->|Compra / Renovación| J["💳 Auto-Registro & Asignación (salesRegistryService.js)"]
    G -->|Atención Compleja| K["🎟️ Ticket Asignado a Asesor (Multi-Agent Inbox)"]
```

---

### 1. 🧠 Motor RAG Semántico y Búsqueda Vectorial (`ragKnowledgeService.js`)
* **Modelo Vectorial:** Google Gemini `gemini-embedding-001` (vectores densos de 3072 dimensiones).
* **Indexación Exhaustiva:** Al arrancar el bot, se fragmenta y vectoriza el contenido de `support.json`, `knowledge_base.json`, `policies.json` y `platforms.json`.
* **Caché Vectorial Local:** Los vectores se guardan en `knowledge_embeddings_cache.json` con hash criptográfico MD5 para arrancar en **<5 ms** sin llamadas redundantes a la API.
* **Similitud de Coseno en Memoria:** Ante cada mensaje del cliente (*"no me agarra el pin"*, *"me salió lo de viaje en el tele"*, *"no veo mi nombre en los perfiles"*), el bot recupera en <2 ms los artículos exactos de soporte e inyecta únicamente ese contexto en el prompt.
* **Ahorro de Costos:** Reduce el consumo de tokens de entrada en DeepSeek en un **70%**, haciendo que el saldo rinda meses completos.

---

### 2. 🔄 Sistema Inteligente de Renovaciones y Asignación de Cupos (`salesRegistryService.js`)
* **Detección Automática de Renovación:** Cuando un cliente paga (por Bre-V, QR o web), el sistema busca si el cliente ya tiene una fila activa o vencida para esa plataforma por su número de teléfono o nombre.
* **Preservación de Invitaciones Familiares:** En plataformas como **Apple One, Spotify Familiar, YouTube Premium o Crunchyroll**, si es una renovación, el bot extiende la fecha de vencimiento (`deben`) y confirma el acceso inmediatamente **sin volver a pedirle el correo de Apple ID ni invitaciones innecesarias**.
* **Prioridad de Precios Oficiales:** Los precios de renovación se calculan consultando siempre el catálogo oficial vigente en `platforms.json` / `streaming_prices`, evitando desactualizaciones por valores históricos en hojas de cálculo.

---

### 3. 👁️ Visión por Computadora (OCR) e Interceptor de Fallas
* **Detección de Pantallas de Televisor:** Reconoce fotos de errores comunes:
  * **Netflix Hogar / Viaje:** Identifica pantallas de *"¿Entendimos mal? Si estás de viaje o fuera de casa..."* y guía al cliente paso a paso a presionar *"Ver temporalmente"* y solicitar el código de 4 dígitos o ingresar a [https://sheerit.co/actualizar](https://sheerit.co/actualizar).
  * **Disney 2FA / Códigos de Acceso:** Extrae los correos y solicita el código de 6 dígitos automáticamente.
  * **Asignación de Perfiles:** Guía al usuario a presionar el botón `+` o *"Añadir perfil"* con su nombre registrado.
* **Validación de Comprobantes:** Extrae fecha, hora, monto y código de transacción de comprobantes de Nequi, Daviplata, Bancolombia, dale!, Lulo y Bre-V.

---

### 4. ⚡ Validación Automática de Pagos en Tiempo Real (Gmail Bre-V / Bold)
* **Monitoreo Continuo:** Monitorea la bandeja de entrada de Gmail buscando notificaciones de *"Venta exitosa por Bre-B"*.
* **Match Inmediato:** Si el monto y la hora coinciden con la solicitud del cliente en un margen de 60 minutos:
  1. Marca el pago como aprobado.
  2. Registra la venta en la hoja de control en Azure / MariaDB.
  3. Entrega las credenciales o renueva la suscripción en el chat de WhatsApp en menos de 5 segundos.
* **Pasarela Bold Web:** Integración con `/api/bold/check-status/:orderId` para redireccionar al portal de autoservicio `/verificar?tel=57300...` tras el pago exitoso.

---

### 5. 🎟️ Bandeja de Entrada Multi-Agente y Gestión de Tickets
* **Filtrado Inteligente de Tickets Libres:** Los mensajes salientes enviados por los propios asesores (ej: difusiones masivas o avisos manuales de corte *"Buen día, estamos en proceso de corte..."*) **no ensucian la bandeja de Tickets Libres**. Un chat solo se convierte en ticket pendiente cuando el cliente responde y requiere atención.
* **Bypass de Códigos en Modo Silencio:** Si un asesor intervino manualmente en un chat, el bot se silencia para respetar la conversación humana; sin embargo, si el cliente pide un código OTP o 2FA, el bot responde de inmediato porque los códigos caducan en 15 minutos.
* **Horarios Dinámicos de Asesores:** Mensajes de expectativa ajustados según el turno laboral activo (Lunes a Viernes 10 AM a 10 PM, Fines de semana 4 PM a 10 PM).

---

### 6. 📅 Programación de Mensajes y Difusiones Contextuales
* **Lenguaje Natural en Español:** Permite al administrador agendar envíos:
  * `@bot dile a Juan Perez hola cómo estás en 10 minutos`
  * `@bot dile tu servicio ya está activo mañana a las 8 am`
  * `@bot notifica a los de Netflix que la clave cambió`
* **Persistencia Anticaídas:** Los mensajes agendados se guardan en `scheduled_messages.json` y se re-programan automáticamente en `node-schedule` ante reinicios del servidor.

---

## 📂 Arquitectura de Módulos

| Archivo | Responsabilidad Principal |
| :--- | :--- |
| [`index.js`](file:///Users/estebanavila/desarrollo/whatbot/index.js) | **Cerebro y Servidor Express:** Orquestación de WhatsApp Web (`wppconnect`), rutas de API REST, filtros de tickets y webhook de mensajes. |
| [`ragKnowledgeService.js`](file:///Users/estebanavila/desarrollo/whatbot/ragKnowledgeService.js) | **Motor RAG:** Generación de embeddings con `gemini-embedding-001`, indexación de documentos, caché local MD5 y búsqueda semántica de coseno. |
| [`aiService.js`](file:///Users/estebanavila/desarrollo/whatbot/aiService.js) | **Módulo de Inteligencia Artificial:** Integración de DeepSeek V3, Gemini Flash, análisis de visión OCR, enmascaramiento de datos y guardrails de seguridad. |
| [`salesRegistryService.js`](file:///Users/estebanavila/desarrollo/whatbot/salesRegistryService.js) | **Registro de Ventas:** Auto-detección de renovaciones, asignación de cupos libres en Excel/MariaDB y cálculo de fechas de corte. |
| [`billingService.js`](file:///Users/estebanavila/desarrollo/whatbot/billingService.js) | **Facturación y Credenciales:** Consulta de precios por catálogo, entrega de contraseñas de MariaDB y generador de estados de cuenta. |
| [`gmailService.js`](file:///Users/estebanavila/desarrollo/whatbot/gmailService.js) | **Integración Gmail:** Lectura de códigos de acceso (Netflix, Disney, Max, Amazon, Claude) y auto-validación de pagos Bre-B. |
| [`availabilityService.js`](file:///Users/estebanavila/desarrollo/whatbot/availabilityService.js) | **Normalización y Stock:** Validación de disponibilidad de cuentas y normalización de nombres de plataformas. |
| [`scheduledMessageService.js`](file:///Users/estebanavila/desarrollo/whatbot/scheduledMessageService.js) | **Mensajería Programada:** Planificador de recordatorios y avisos diferidos para clientes. |
| [`googleContactsService.js`](file:///Users/estebanavila/desarrollo/whatbot/googleContactsService.js) | **Sincronización de Contactos:** Creación y búsqueda automática de clientes en Google Contacts. |

---

## 🚀 Comandos Administrativos (Desde WhatsApp)

* `@bot confirmar [Número] [Plataforma]`: Valida un pago manualmente y activa el servicio.
* `@bot notifica a los de [Cuenta] que [Mensaje]`: Inicia un flujo de difusión con confirmación previa.
* `@bot descarta los [Filtro]`: Refina la lista del mensaje masivo antes de enviar.
* `@bot solo los activos`: Filtra el envío para incluir únicamente usuarios con suscripciones vigentes.
* `@bot dile a [Nombre/Número] [Mensaje] [Tiempo]`: Agenda un mensaje para el cliente especificado.
* `@bot libera [Número]`: Desbloquea el silencio del bot en un chat individual.
* `@bot duérmete`: Desactiva temporalmente las respuestas automáticas globales.
* `@bot despiértate`: Reactiva las respuestas automáticas globales.

---

## 🛠️ Puesta en Marcha y Despliegue

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar en desarrollo
npm start

# 3. Iniciar en producción con PM2
pm2 start index.js --name whatbot

# 4. Ver logs en tiempo real
pm2 logs whatbot
```