-- 1. Asegurar la existencia de la tabla agents
CREATE TABLE IF NOT EXISTS agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    fullname VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NULL,
    role ENUM('admin', 'agent', 'supervisor') DEFAULT 'agent',
    status ENUM('active', 'inactive', 'busy') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Insertar o actualizar roles de agentes iniciales
INSERT INTO agents (username, fullname, email, role) VALUES 
('estebanavila182', 'Esteban', 'estebanavila182@outlook.com', 'admin'),
('esclepiades', 'Esclepiades', 'esclepiades@hotmail.com', 'agent'),
('camilo', 'Camilo', 'camco08@hotmail.com', 'agent')
ON DUPLICATE KEY UPDATE 
    role = VALUES(role), 
    fullname = VALUES(fullname),
    email = VALUES(email);

-- Verificación
SELECT * FROM agents;
