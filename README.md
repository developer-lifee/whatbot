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

Este documento sirve como guía técnica para la mejora continua del bot, priorizando la arquitectura basada en API sobre migraciones complejas de framework.

## 📌 Estado del Proyecto
- [x] **Fase 1:** Mejoras de Uso y Optimización Básica (Completado)
- [x] **Fase 2:** Optimización de Integración API (Completado)
- [ ] **Fase 3:** Panel Web & Autenticación (Redis)
- [ ] **Fase 4:** Integración Híbrida de IA
- [~] *(Opcional)* Migración de Framework (BuilderBot) - *Postergado/Secundario*

---

## 🛠️ Fase 1: Mejoras de Uso y Optimización (Completado)
*Objetivo: Mejorar la experiencia de uso actual, facilitar el control para operadores humanos y estabilizar la conexión.*

- [x] **Mejoras de Operación y Control (Implementadas):**
  - Se añadieron comandos directos en grupos (`@bot duermete`, `@bot despiertate`) para gestión humana ágil.
  - Documentación en línea para el equipo (`@bot funciones`).
- [x] **Seguridad de Variables de Entorno:**
  - Sacar credenciales en código (`database.js`) y moverlas a `.env`. (Completado)
- [x] **Optimización de Base de Datos:**
  - Reemplazar `mysql.createConnection` por `mysql.createPool` para prevenir errores de límite de conexiones simultáneas. (Completado)

## 🗄️ Fase 2: Optimización de Integración API (Completado)
*Objetivo: Centralizar la inteligencia del negocio en la nube (Azure Functions). Esto reduce la necesidad de un framework complejo local, ya que el bot actúa principalmente como interfaz comunicativa.*

- [x] **Desacoplar Lógica de Negocio:**
  - Mover cálculos, formateos complejos y decisiones a las Azure Functions, aligerando el archivo `index.js`.
- [x] **Gestión Ágil de Endpoints:**
  - Centralizar los llamados a `/api/readexcelfunction` y futuros endpoints en un módulo de servicios dedicado (`apiService.js`).
- [x] **Resiliencia (Manejo de Errores y Retries):**
  - Implementar reconexiones automáticas si la API de Azure no responde para evitar caídas del flujo conversacional.

## 🔐 Fase 3: Autenticación Web & Redis (OTP)
*Objetivo: Permitir que los clientes se logueen en el panel web usando un código cifrado enviado a su WhatsApp.*

- [ ] **Infraestructura Ágil de Caché (Redis):**
  - Levantar instancia de BD en memoria (Redis vía Upstash, etc.).
- [ ] **Flujo de Login por WhatsApp:**
  1. Usuario ingresa teléfono en el portal Web.
  2. Web genera un PIN temporal y lo guarda en Redis con TTL de 5 min (`SET auth:57300... "4591"`).
  3. Web notifica internamente al Bot y este lo envía: *"Tu código de acceso es: 4591"*.
  4. Usuario ingresa el código en la Web validando su identidad de forma segura.

## 🤖 Fase 4: Inteligencia Artificial (Híbrido Avanzado)
*Objetivo: Usar la IA solo donde brinda valor agregado o resolución de consultas complejas.*

- [ ] **IA con Contexto Directo:**
  - Si el bot detecta dudas de soporte (ej. "Pantalla incorrecta"), extraer contexto desde Azure e inyectarlo en el Prompt de Gemini para una respuesta resolutiva inmediata.
- [ ] **Optimización de Costos:**
  - Clasificar intenciones de mensajes con expresiones regulares rápidas para evitar llamados a Gemini cuando no es necesario.

---

## 🏗️ *(Opcional)* Migración de Framework a BuilderBot
*Nota: Este objetivo anterior queda pospuesto.*
- [ ] Al trasladar la lógica pesada a las funciones de Azure, la estructura actual con `whatsapp-web.js` se vuelve suficiente. Solo migraremos a BuilderBot si el enrutamiento de menús estáticos se vuelve insostenible.