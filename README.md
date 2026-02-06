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
- **Liberar Sesión**: `liberar 3001234567` para desconectar al bot de un usuario y permitir atención humana.
- **Confirmar Cobros**: `confirmar_cobros 3001234567` para registrar pagos manualmente.

## 📂 Estructura del Proyecto

- `index.js`: **Cerebro Principal**. Maneja la conexión de WhatsApp, escucha eventos y orquesta los estados del usuario.
- `aiService.js`: **Módulo de IA**. Contiene la lógica para llamar a la API de Gemini, manejar reintentos y parsear respuestas JSON.
- `database.js`: Configuración de la conexión a MySQL.
- `scheduledTasks.js` / `getInfo.js`: Tareas programadas y utilidades de información.
- `.wwebjs_auth/`: Almacena la sesión de WhatsApp (¡No borrar a menos que sea necesario re-escanear!).

## 🚀 Cómo Iniciar

1. **Instalar dependencias**:
   ```bash
   npm install
   ```
2. **Configurar entorno**:
   - Asegúrate de tener el archivo `.env` con `GEMINI_API_KEY` y credenciales de BD.
3. **Iniciar el bot**:
   ```bash
   npm start
   ```
   _Escanea el código QR si es la primera vez._

## 🐛 Solución de Problemas Comunes

- **El bot no responde**: Revisa si el proceso "zombie" de Node está corriendo (`ps aux | grep node`) o si hay logs de `auth_failure`.
- **Error de Puppeteer/Chrome**: Verifica que no haya procesos de Chrome "colgados". El bot usa su propia versión de Chromium.

---

# 🚀 Roadmap de Refactorización & Modernización - WhatBot

Este documento sirve como guía técnica para la migración del bot actual (monolítico) a una arquitectura escalable, segura y administrable dinámicamente.

## 📌 Estado del Proyecto
- [ ] **Fase 1:** Seguridad y Optimización Básica
- [ ] **Fase 2:** Migración de Framework (BuilderBot)
- [ ] **Fase 3:** Lógica Dinámica (Base de Datos)
- [ ] **Fase 4:** Panel Web & Autenticación (Redis)
- [ ] **Fase 5:** Integración Híbrida de IA

---

## 🛠️ Fase 1: Seguridad y Optimización (Inmediato)
*Objetivo: Solucionar vulnerabilidades y problemas de rendimiento en el código actual.*

- [ ] **Variables de Entorno (.env):**
  - Sacar credenciales de `database.js`.
  - Instalar `dotenv`.
  - Crear archivo `.env` (y agregarlo a `.gitignore`).
- [ ] **Connection Pool MySQL:**
  - Modificar `database.js`.
  - Reemplazar `mysql.createConnection` por `mysql.createPool`.
  - **Motivo:** Evitar el error "Too many connections" y mejorar la velocidad de respuesta.
- [ ] **Limpieza de Consultas:**
  - Optimizar la sanitización de números telefónicos en JS antes de enviarlos a la SQL Query.

## 🏗️ Fase 2: El Nuevo Cerebro (BuilderBot)
*Objetivo: Cambiar la estructura de `switch/case` por flujos modernos.*

- [ ] **Instalación:**
  - Inicializar proyecto con BuilderBot (`@builderbot/bot`, `@builderbot/provider-baileys`, `@builderbot/database-mysql`).
- [ ] **Migración de Lógica:**
  - Eliminar el bloque gigante `switch` de `index.js`.
  - Crear flujos independientes (ej: `flowVentas`, `flowSoporte`).
- [ ] **Adaptador MySQL:**
  - Configurar BuilderBot para que guarde el estado de la sesión (contexto) automáticamente en la base de datos SQL existente.

## 🗄️ Fase 3: Lógica Dinámica (Table-Driven)
*Objetivo: Que el bot lea qué decir desde la base de datos, permitiendo cambios sin tocar código.*

- [ ] **Nuevas Tablas SQL:**
  - Crear tabla `flujos` (id, nombre, mensaje_respuesta, tipo_accion).
  - Crear tabla `opciones` (id, flujo_padre_id, keyword, flujo_destino_id).
- [ ] **Router Inteligente:**
  - Crear un "Flujo Maestro" en el bot que consulte estas tablas:
    ```sql
    SELECT * FROM opciones WHERE flujo_padre_id = ? AND keyword = ?
    ```

## 🔐 Fase 4: Autenticación Web & Redis (OTP)
*Objetivo: Permitir que los clientes se logueen en el panel web usando un código enviado a su WhatsApp.*

- [ ] **Infraestructura Redis:**
  - Levantar instancia de Redis (con Upstash).
- [ ] **Flujo de Autenticación (Login):**
  1. Usuario ingresa teléfono en la Web.
  2. Web genera código (ej: `4591`) y lo guarda en Redis con TTL de 5 min:
     `SET auth:573001234567 "4591" EX 300`
  3. Web notifica al Bot (vía API interna o Pub/Sub).
  4. Bot envía mensaje: *"Tu código de acceso es: 4591"*.
  5. Usuario ingresa código en la Web -> Web valida contra Redis.

## 🤖 Fase 5: Inteligencia Artificial (Híbrido)
*Objetivo: Usar IA solo cuando sea necesario (FAQ compleja).*

- [ ] **Columna Flag IA:**
  - Agregar columna `usar_ia` (boolean) en la tabla `flujos`.
- [ ] **Integración OpenAI/Gemini:**
  - Si el flujo actual tiene `usar_ia = 1`, capturar el input del usuario.
  - Enviar prompt con contexto de negocio.
  - Responder con el texto generado.