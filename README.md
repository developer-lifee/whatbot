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
  - Levantar instancia de Redis (Docker o servicio cloud gratuito).
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

---
*Última actualización: Diciembre 2025*