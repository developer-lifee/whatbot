CREATE DATABASE IF NOT EXISTS whatbot;
USE whatbot;

-- 1. Agentes / Asesores (Usuarios del panel administrador)
CREATE TABLE IF NOT EXISTS agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    fullname VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NULL,
    role ENUM('admin', 'agent', 'supervisor') DEFAULT 'agent',
    status ENUM('active', 'inactive', 'busy') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Clientes (Sincronizado con Excel / WhatsApp)
CREATE TABLE IF NOT EXISTS customers (
    phone VARCHAR(50) PRIMARY KEY, -- Formato: 573107946794
    fullname VARCHAR(255) NOT NULL,
    email VARCHAR(255) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 3. Cuentas y Suscripciones activas (Caché local de planes de streaming de clientes)
CREATE TABLE IF NOT EXISTS subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_phone VARCHAR(50) NOT NULL,
    streaming_platform VARCHAR(100) NOT NULL, -- Netflix, Disney+, etc.
    account_email VARCHAR(255) NOT NULL,
    account_password VARCHAR(255) NULL,
    profile_pin VARCHAR(50) NULL,
    expiration_date DATE NULL,
    status ENUM('active', 'expired', 'cancelled') DEFAULT 'active',
    FOREIGN KEY (customer_phone) REFERENCES customers(phone) ON DELETE CASCADE,
    INDEX idx_expiration (expiration_date)
);

-- 4. Chats / Hilos de Conversación
CREATE TABLE IF NOT EXISTS chats (
    chat_id VARCHAR(255) PRIMARY KEY, -- Formato WhatsApp: 573107946794@c.us o ID de grupo
    customer_phone VARCHAR(50) NULL,
    status ENUM('bot', 'waiting_human', 'advisor', 'closed') DEFAULT 'bot',
    assigned_agent_id INT NULL,
    unread_count INT DEFAULT 0,
    last_message_text TEXT NULL,
    last_message_time TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_phone) REFERENCES customers(phone) ON DELETE SET NULL,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- 5. Mensajes (Con relaciones a mensajes citados y tipos multimedia avanzados)
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255) UNIQUE NOT NULL, -- ID original de WhatsApp (_serialized)
    chat_id VARCHAR(255) NOT NULL,
    sender_id VARCHAR(255) NOT NULL, -- Quién envía
    sender_name VARCHAR(255) NULL,
    direction ENUM('inbound', 'outbound') NOT NULL,
    message_type ENUM('text', 'image', 'video', 'audio', 'document', 'location', 'sticker', 'other') DEFAULT 'text',
    body TEXT NULL,
    media_path TEXT NULL, -- Ruta local del archivo comprimido
    media_mime VARCHAR(100) NULL,
    drive_url TEXT NULL, -- URL de Google Drive si ya fue migrado a la nube
    quoted_msg_id VARCHAR(255) NULL, -- ID del mensaje al que responde (para mantener el hilo)
    bot_intent VARCHAR(100) NULL, -- Intención detectada por Gemini
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
    INDEX idx_created (created_at)
);

-- 6. Tickets de Soporte (Módulo de atención de fallas o reclamos)
CREATE TABLE IF NOT EXISTS tickets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chat_id VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    status ENUM('open', 'assigned', 'resolved', 'pending_customer') DEFAULT 'open',
    priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
    assigned_agent_id INT NULL,
    resolved_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- 7. Tareas de Tickets / Checklist (Asignación de tareas concretas "TK")
CREATE TABLE IF NOT EXISTS tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ticket_id INT NULL,
    chat_id VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    status ENUM('pending', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending',
    assigned_agent_id INT NULL,
    due_date TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

-- 8. Auditoría e Historial de Backups a Google Drive
CREATE TABLE IF NOT EXISTS drive_backups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL,
    original_path TEXT NOT NULL,
    drive_file_id VARCHAR(255) NOT NULL,
    drive_url TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. SaaS Configuración de Sistema (Prompts, Intents, etc.)
CREATE TABLE IF NOT EXISTS system_configs (
    cfg_key VARCHAR(50) PRIMARY KEY,
    cfg_value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 10. SaaS Recetas de Automatización RPA (Puppeteer)
CREATE TABLE IF NOT EXISTS rpa_recipes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    recipe_json JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. SaaS Credenciales de Proveedores (RPA)
CREATE TABLE IF NOT EXISTS provider_credentials (
    id INT AUTO_INCREMENT PRIMARY KEY,
    platform VARCHAR(50) NOT NULL,
    provider_name VARCHAR(100) NOT NULL,
    username VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. Horarios y Turnos de Asesores
CREATE TABLE IF NOT EXISTS agent_schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agent_id INT NOT NULL,
    day_of_week TINYINT NOT NULL, -- 0 (Domingo) a 6 (Sábado)
    start_time VARCHAR(10) NOT NULL, -- Formato "HH:MM"
    end_time VARCHAR(10) NOT NULL,   -- Formato "HH:MM"
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    UNIQUE KEY unique_agent_day_slot (agent_id, week_start, day_of_week, start_time, end_time)
);

-- 13. Ventas Web Pendientes (Intenciones de Pago)
CREATE TABLE IF NOT EXISTS web_sales_pending (
    order_id VARCHAR(50) PRIMARY KEY,
    firstName VARCHAR(100) NOT NULL,
    lastName VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    whatsapp VARCHAR(50) NOT NULL,
    platformName VARCHAR(100) NOT NULL,
    amount INT NOT NULL,
    numbersStr TEXT NOT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 14. Ventas Web Aprobadas (Historial Definitivo)
CREATE TABLE IF NOT EXISTS web_sales_approved (
    order_id VARCHAR(50) PRIMARY KEY,
    firstName VARCHAR(100) NOT NULL,
    lastName VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    whatsapp VARCHAR(50) NOT NULL,
    platformName VARCHAR(100) NOT NULL,
    amount INT NOT NULL,
    numbersStr TEXT NOT NULL,
    createdAt TIMESTAMP NULL,
    approvedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
