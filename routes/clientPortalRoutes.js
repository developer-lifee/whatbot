const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { getAccountsByPhone } = require('../apiService');
const { hashPassword, signSessionToken, verifySessionToken } = require('../authService');
const { createRateLimiter } = require('../securityMiddleware');
const { checkAccountAutomationStatus } = require('./adminCatalogAndAccountingRoutes');

const ROOT_DIR = path.resolve(__dirname, '..');

const clientPasswordLoginLimiter = createRateLimiter({
    name: 'client-password-login',
    windowMs: 15 * 60 * 1000,
    maxAttempts: 6,
    message: 'Demasiados intentos fallidos. Intenta nuevamente en 15 minutos.'
});

function normalizeClientPhoneKey(rawPhone) {
    const clean = String(rawPhone || '').replace(/\D/g, '');
    if (!clean) return '';
    return (clean.length === 10 && clean.startsWith('3')) ? `57${clean}` : clean;
}

let clientAuthTableReady = false;
async function ensureClientAuthTable() {
    if (clientAuthTableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS client_portal_auth (
            phone VARCHAR(25) PRIMARY KEY,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
    clientAuthTableReady = true;
}

async function hasClientPassword(canonicalPhone) {
    if (!canonicalPhone) return false;
    try {
        await ensureClientAuthTable();
        const last10 = canonicalPhone.slice(-10);
        const [rows] = await pool.query(
            'SELECT phone FROM client_portal_auth WHERE phone = ? OR phone = ? OR phone = ? LIMIT 1',
            [canonicalPhone, last10, `57${last10}`]
        );
        return Boolean(rows && rows.length > 0);
    } catch (e) {
        console.warn('[ClientAuth] Error verificando client_portal_auth:', e.message);
        return false;
    }
}

async function loadFormattedClientAccounts(cleanPhone, isDemo) {
    const { isAiLimitedPlatform, getDeviceUsage } = require('../deviceLimitService');
    if (isDemo) {
        return DEMO_ACCOUNTS_LIST.map(a => {
            const isAi = isAiLimitedPlatform(a.Streaming || a.platform);
            const deviceStatus = isAi ? getDeviceUsage('57000', a.email, 3, a.Nombre || a.profile) : null;
            return {
                ...a,
                isLimitedPlatform: isAi,
                devicesUsed: isAi && deviceStatus ? deviceStatus.devicesUsed : null,
                devicesRemaining: isAi && deviceStatus ? deviceStatus.devicesRemaining : null,
                maxDevices: isAi && deviceStatus ? deviceStatus.maxDevices : null
            };
        });
    }

    const { getAccountsByPhone: fetchAccs, getJsDateFromExcel } = require('../apiService');
    const userAccounts = await fetchAccs(cleanPhone, null, true);

    const formattedAccounts = await Promise.all(userAccounts.map(async (acc) => {
        const pin = acc["pin perfil"] || acc["pin"] || acc["PIN"] || acc["Pin"] || "";
        const rawPerfil = acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || "";
        const perfil = rawPerfil || "N/A";

        const rawVenc = acc.deben || acc.Columna4 || acc.vencimiento;
        const jsDate = getJsDateFromExcel ? getJsDateFromExcel(rawVenc) : null;
        const vencFormatted = jsDate ? jsDate.toISOString().split('T')[0] : (rawVenc || "");

        const isAi = isAiLimitedPlatform(acc.Streaming || acc.platform);
        const accEmailNorm = (acc.correo || '').trim().toLowerCase();
        const accPlatNorm = (acc.Streaming || acc.platform || '').trim().toLowerCase();
        const cuposCount = isAi ? Math.max(1, userAccounts.filter(u => {
            const uEmail = (u.correo || '').trim().toLowerCase();
            if (accEmailNorm && uEmail) return uEmail === accEmailNorm;
            return (u.Streaming || u.platform || '').trim().toLowerCase() === accPlatNorm;
        }).length) : 1;
        const maxAllowed = 3 * cuposCount;
        const deviceStatus = isAi ? getDeviceUsage(cleanPhone, acc.correo || acc.Streaming, maxAllowed, rawPerfil || pin) : null;
        const autoStatus = await checkAccountAutomationStatus(acc.correo, acc.Streaming);

        return {
            id: acc.id || acc._rowNumber,
            platform: (acc.Streaming || "").toUpperCase(),
            email: acc.correo || "",
            password: acc["contraseña"] || acc.contraseña || acc.clave || acc.Password || acc.password || "",
            profile: pin ? `${perfil} (PIN: ${pin})` : perfil,
            vencimiento: vencFormatted,
            isAutomated: autoStatus.isAutomated,
            automationType: autoStatus.type,
            automationLabel: autoStatus.label,
            isLimitedPlatform: isAi,
            devicesUsed: isAi && deviceStatus ? deviceStatus.devicesUsed : null,
            devicesRemaining: isAi && deviceStatus ? deviceStatus.devicesRemaining : null,
            maxDevices: isAi && deviceStatus ? deviceStatus.maxDevices : null
        };
    }));

    if (formattedAccounts.length === 0) {
        try {
            const last10 = cleanPhone.slice(-10);
            const [recentSales] = await pool.query(
                `SELECT * FROM web_sales_approved 
                 WHERE (whatsapp LIKE ? OR whatsapp = ?) 
                 AND approvedAt >= NOW() - INTERVAL 48 HOUR 
                 ORDER BY approvedAt DESC`,
                [`%${last10}%`, cleanPhone]
            );
            if (recentSales && recentSales.length > 0) {
                recentSales.forEach(s => {
                    formattedAccounts.push({
                        id: `pending-${s.order_id}`,
                        platform: (s.platformName || "SERVICIO").toUpperCase(),
                        email: s.email || "Asignando cuenta...",
                        password: "En proceso de entrega",
                        profile: `${s.firstName || 'Cliente'} (En preparación)`,
                        vencimiento: "Activación en curso",
                        isPendingDelivery: true,
                        isAutomated: false
                    });
                });
            }
        } catch (dbSalesErr) {
            console.warn('[ClientAccounts] Error buscando compras recientes en BD:', dbSalesErr.message);
        }
    }

    return formattedAccounts;
}

// ==========================================
// CLIENT OTP PORTAL SIGN-IN & 2FA REQUESTS
// ==========================================

const clientOtps = new Map(); // phone -> { code, expiresAt }
const DEMO_PHONE_NUMBERS = ['000', '57000', '0000', '570000000000', '5700000000'];
const ADMIN_DEMO_RECIPIENT_PHONE = '573133890800';

const DEMO_ACCOUNTS_LIST = [
    {
        id: 9001,
        platform: "NETFLIX",
        Streaming: "NETFLIX",
        email: "yulisadiagama@gmail.com",
        correo: "yulisadiagama@gmail.com",
        password: "Sheercoli01",
        contraseña: "Sheercoli01",
        profile: "Demo Esteban (PIN: 1234)",
        Nombre: "Demo Esteban",
        "pin perfil": "1234",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9002,
        platform: "DISNEY+ PREMIUM",
        Streaming: "DISNEY",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "mentilh23",
        contraseña: "mentilh23",
        profile: "Demo Esteban (PIN: 5678)",
        Nombre: "Demo Esteban",
        "pin perfil": "5678",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9003,
        platform: "MAX / HBO PLATINO",
        Streaming: "HBO",
        email: "sheeritcustomers@gmail.com",
        correo: "sheeritcustomers@gmail.com",
        password: "HBosheri39",
        contraseña: "HBosheri39",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9004,
        platform: "PRIME VIDEO",
        Streaming: "AMAZON",
        email: "itsheer266@gmail.com",
        correo: "itsheer266@gmail.com",
        password: "honesthe1",
        contraseña: "honesthe1",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9005,
        platform: "SPOTIFY PREMIUM",
        Streaming: "SPOTIFY",
        email: "discoveryrelesbiana@gmail.com",
        correo: "discoveryrelesbiana@gmail.com",
        password: "Spotisheer1",
        contraseña: "Spotisheer1",
        profile: "Cuenta Personal Premium",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9006,
        platform: "YOUTUBE PREMIUM",
        Streaming: "YOUTUBE",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "Sheerit123*",
        contraseña: "Sheerit123*",
        profile: "Familiar Invitación",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9007,
        platform: "CHATGPT PLUS",
        Streaming: "GPT",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "contraseñalarga69",
        contraseña: "contraseñalarga69",
        profile: "2FA TOTP Automático",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9008,
        platform: "CLAUDE PRO",
        Streaming: "CLAUDE",
        email: "angirosagptplus@gmail.com",
        correo: "angirosagptplus@gmail.com",
        password: "Magic Link Acceso",
        contraseña: "Magic Link Acceso",
        profile: "Enlace Mágico",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9009,
        platform: "APPLE TV+ / APPLE ONE",
        Streaming: "APPLE TV",
        email: "alzap1479@gmail.com",
        correo: "alzap1479@gmail.com",
        password: "Este1645*",
        contraseña: "Este1645*",
        profile: "Invitación Familiar",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9010,
        platform: "CRUNCHYROLL MEGA FAN",
        Streaming: "CRUNCHY ROLL",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "SHEPA0308",
        contraseña: "SHEPA0308",
        profile: "Demo Esteban",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9011,
        platform: "PARAMOUNT+",
        Streaming: "PARAMOUNT",
        email: "estebanavila6324@gmail.com",
        correo: "estebanavila6324@gmail.com",
        password: "prime2027",
        contraseña: "prime2027",
        profile: "Demo Esteban (PIN: 9999)",
        Nombre: "Demo Esteban",
        "pin perfil": "9999",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9012,
        platform: "CANVA PRO",
        Streaming: "CANVA",
        email: "sheerstreaming@gmail.com",
        correo: "sheerstreaming@gmail.com",
        password: "solintican3",
        contraseña: "solintican3",
        profile: "Equipo Pro Sheerit",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9013,
        platform: "GEMINI PRO",
        Streaming: "GEMINI",
        email: "discoveryrelesbiana@gmail.com",
        correo: "discoveryrelesbiana@gmail.com",
        password: "Sheerit3256",
        contraseña: "Sheerit3256",
        profile: "Cuenta Correo Propio",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    },
    {
        id: 9014,
        platform: "MICROSOFT 365",
        Streaming: "MICROSOFT",
        email: "Estebanavila182@outlook.com",
        correo: "Estebanavila182@outlook.com",
        password: "eSTE1645*",
        contraseña: "eSTE1645*",
        profile: "Licencia Personal 1TB",
        Nombre: "Demo Esteban",
        vencimiento: "2026-12-31",
        deben: "2026-12-31"
    }
];

function isDemoClientPhone(phoneStr) {
    const clean = String(phoneStr || '').replace(/\D/g, '');
    return DEMO_PHONE_NUMBERS.includes(clean) || clean === '000' || clean === '57000' || clean.endsWith('000');
}

function registerClientPortalRoutes(app, ctx) {
    const { userStates } = ctx;

// POST Request Client OTP
app.post('/api/client/request-otp', express.json(), async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });

        const cleanPhone = phone.replace(/\D/g, '');
        const isDemo = isDemoClientPhone(cleanPhone);
        const last10 = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        const recipientJid = isDemo ? (ADMIN_DEMO_RECIPIENT_PHONE + '@c.us') : (cleanPhone.startsWith('57') ? cleanPhone + '@c.us' : '57' + last10 + '@c.us');

        let clientName = "Cliente";
        if (!isDemo) {
            const { pool } = require('../database');
            const [rows] = await pool.query(
                'SELECT fullname FROM customers WHERE phone = ? OR phone LIKE ? OR phone = ? LIMIT 1',
                [cleanPhone, `%${last10}`, `57${last10}`]
            );
            if (rows && rows.length > 0) {
                clientName = rows[0].fullname;
            } else {
                // Fallback a Excel y órdenes de clientes
                const { getAccountsByPhone } = require('../apiService');
                const userAccounts = await getAccountsByPhone(cleanPhone);
                if (!userAccounts || userAccounts.length === 0) {
                    return res.status(404).json({ success: false, message: 'No encontramos ningún cliente registrado con ese número de teléfono' });
                }
                const firstAcc = userAccounts[0];
                clientName = `${firstAcc.Nombre || firstAcc.nombre || ''} ${firstAcc.Apellido || firstAcc.apellido || ''}`.trim() || "Cliente";
            }
        } else {
            clientName = "Esteban (Usuario Demo)";
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutos

        clientOtps.set(cleanPhone, { code: otpCode, expiresAt });
        if (isDemo) {
            clientOtps.set('000', { code: otpCode, expiresAt });
            clientOtps.set('57000', { code: otpCode, expiresAt });
        }

        if (ctx.getClient() && ctx.getCurrentWhatsappStatus() === 'CONNECTED') {
            const demoTag = isDemo ? " (DEMO TESTING)" : "";
            const msg = `🔑 *CÓDIGO DE ACCESO (SHEERIT${demoTag})* 🔑\n\nHola *${clientName}*,\n\nTu código OTP para iniciar sesión en nuestro portal de clientes es:\n\n🔢 *${otpCode}*\n\n_Este código es confidencial y vencerá en 5 minutos._ 🤖`;
            await ctx.getClient().sendMessage(recipientJid, msg);
            console.log(`[OTP] Enviado código ${otpCode} a @${recipientJid} (Usuario: ${cleanPhone})`);
            return res.json({ success: true, message: isDemo ? 'Código OTP enviado con éxito a tu WhatsApp (+57 313 3890800)' : 'Código OTP enviado con éxito a tu WhatsApp' });
        } else {
            const canonicalPhone = normalizeClientPhoneKey(cleanPhone);
            const clientHasPass = await hasClientPassword(canonicalPhone);
            return res.status(503).json({
                success: false,
                whatsappOffline: true,
                hasPassword: clientHasPass,
                message: clientHasPass
                    ? 'WhatsApp no está disponible en este momento, pero puedes ingresar con tu contraseña.'
                    : 'El servicio de envío de códigos por WhatsApp no está disponible en este momento.'
            });
        }
    } catch (e) {
        console.error('Error al generar OTP para cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Verify Client OTP
app.post('/api/client/verify-otp', express.json(), async (req, res) => {
    try {
        const { phone, code } = req.body;
        if (!phone || !code) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const canonicalPhone = normalizeClientPhoneKey(cleanPhone);
        const isDemo = isDemoClientPhone(cleanPhone);
        const otpData = clientOtps.get(cleanPhone) || (isDemo ? (clientOtps.get('000') || clientOtps.get('57000')) : null);

        if (!otpData) {
            return res.status(400).json({ success: false, message: 'No hay un código OTP activo para este número. Por favor solicita uno nuevo.' });
        }

        if (Date.now() > otpData.expiresAt) {
            clientOtps.delete(cleanPhone);
            return res.status(400).json({ success: false, message: 'El código OTP ha expirado. Por favor solicita uno nuevo.' });
        }

        if (otpData.code !== code.trim()) {
            return res.status(400).json({ success: false, message: 'El código OTP ingresado es incorrecto' });
        }

        // OTP Válido - Limpiar
        clientOtps.delete(cleanPhone);

        const formattedAccounts = await loadFormattedClientAccounts(cleanPhone, isDemo);
        const sessionToken = signSessionToken({ role: 'client', phone: canonicalPhone });
        const clientHasPass = isDemo ? false : await hasClientPassword(canonicalPhone);

        if (!isDemo) {
            recordClient2FaLog({
                phone: cleanPhone,
                platform: 'PORTAL',
                accountEmail: '',
                requestSource: 'web',
                status: 'otp_verified',
                message: `Cliente inició sesión en el portal de cuentas (${formattedAccounts.length} servicio(s) consultado(s))`
            });
        }

        res.json({
            success: true,
            message: isDemo ? 'Verificación exitosa (Modo Demo)' : 'Verificación exitosa',
            sessionToken,
            hasPassword: clientHasPass,
            accounts: formattedAccounts
        });
    } catch (e) {
        console.error('Error al verificar OTP de cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Auto-Session for freshly approved web orders (No OTP required on first checkout)
app.post('/api/client/auto-session', express.json(), async (req, res) => {
    try {
        const { phone, orderId } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Falta el número de teléfono' });
        }

        const cleanPhone = phone.replace(/\D/g, '');
        const canonicalPhone = normalizeClientPhoneKey(cleanPhone);
        const isDemo = isDemoClientPhone(cleanPhone);

        const formattedAccounts = await loadFormattedClientAccounts(cleanPhone, isDemo);
        const sessionToken = signSessionToken({ role: 'client', phone: canonicalPhone });
        const clientHasPass = isDemo ? false : await hasClientPassword(canonicalPhone);

        if (!isDemo) {
            recordClient2FaLog({
                phone: cleanPhone,
                platform: 'PORTAL',
                accountEmail: '',
                requestSource: 'web',
                status: 'portal_access',
                message: `Cliente ingresó al portal tras completar compra (${formattedAccounts.length} servicio(s) entregado(s))`
            });
        }

        res.json({
            success: true,
            message: isDemo ? 'Sesión automática (Modo Demo)' : 'Sesión iniciada con éxito',
            sessionToken,
            hasPassword: clientHasPass,
            accounts: formattedAccounts
        });
    } catch (e) {
        console.error('Error en auto-session de cliente:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Client Password Login (independiente de WhatsApp Web)
app.post('/api/client/login-password', clientPasswordLoginLimiter, express.json(), async (req, res) => {
    try {
        const { phone, password } = req.body || {};
        if (!phone || !password) {
            return res.status(400).json({ success: false, message: 'Ingresa tu número de WhatsApp y contraseña.' });
        }

        const cleanPhone = String(phone).replace(/\D/g, '');
        const canonicalPhone = normalizeClientPhoneKey(cleanPhone);
        const isDemo = isDemoClientPhone(cleanPhone);
        if (!canonicalPhone) {
            return res.status(400).json({ success: false, message: 'Número de teléfono inválido.' });
        }

        await ensureClientAuthTable();
        const last10 = canonicalPhone.slice(-10);
        const [rows] = await pool.query(
            'SELECT phone, password_hash FROM client_portal_auth WHERE phone = ? OR phone = ? OR phone = ? LIMIT 1',
            [canonicalPhone, last10, `57${last10}`]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                noPasswordSet: true,
                message: 'Aún no has creado una contraseña para este número. Ingresa primero con Código OTP por WhatsApp y créala desde tu portal.'
            });
        }

        const match = await bcrypt.compare(String(password), rows[0].password_hash);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta.' });
        }

        const formattedAccounts = await loadFormattedClientAccounts(cleanPhone, isDemo);
        const sessionToken = signSessionToken({ role: 'client', phone: normalizeClientPhoneKey(rows[0].phone) || canonicalPhone });

        if (!isDemo) {
            recordClient2FaLog({
                phone: cleanPhone,
                platform: 'PORTAL',
                accountEmail: '',
                requestSource: 'web',
                status: 'password_login',
                message: `Cliente inició sesión con contraseña de respaldo (${formattedAccounts.length} servicio(s))`
            });
        }

        return res.json({
            success: true,
            message: 'Inicio de sesión exitoso',
            sessionToken,
            hasPassword: true,
            accounts: formattedAccounts
        });
    } catch (e) {
        console.error('Error en login-password de cliente:', e.message);
        res.status(500).json({ success: false, message: 'Error interno al validar contraseña.' });
    }
});

// POST Create or Update Client Backup Password (requires signed client sessionToken)
app.post('/api/client/set-password', express.json(), async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        const token = headerToken || (req.body && req.body.sessionToken) || '';
        const payload = verifySessionToken(token);

        if (!payload || payload.role !== 'client' || !payload.phone) {
            return res.status(401).json({ success: false, message: 'Tu sesión expiró. Vuelve a iniciar sesión para guardar tu contraseña.' });
        }

        const reqPhone = normalizeClientPhoneKey((req.body && req.body.phone) || payload.phone);
        const tokenPhone = normalizeClientPhoneKey(payload.phone);
        if (reqPhone && tokenPhone && reqPhone.slice(-10) !== tokenPhone.slice(-10)) {
            return res.status(403).json({ success: false, message: 'No autorizado para modificar otro número.' });
        }

        const newPassword = String((req.body && req.body.newPassword) || '');
        if (newPassword.length < 6 || newPassword.length > 64) {
            return res.status(400).json({ success: false, message: 'La contraseña debe tener entre 6 y 64 caracteres.' });
        }

        await ensureClientAuthTable();
        const passwordHash = await hashPassword(newPassword);
        await pool.query(
            'INSERT INTO client_portal_auth (phone, password_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)',
            [tokenPhone, passwordHash]
        );

        return res.json({
            success: true,
            hasPassword: true,
            message: 'Contraseña guardada con éxito. Ya puedes ingresar con tu número y contraseña aunque WhatsApp no esté disponible.'
        });
    } catch (e) {
        console.error('Error guardando contraseña de cliente:', e.message);
        res.status(500).json({ success: false, message: 'Error guardando tu contraseña.' });
    }
});

/**
 * Guarda registro de auditoría de cada solicitud 2FA (Web o WhatsApp) en la base de datos
 */
async function recordClient2FaLog({ phone, clientName = '', platform = '', accountEmail = '', requestSource = 'web', status = 'unknown', codeOrLink = null, message = '' }) {
    try {
        const { pool } = require('../database');
        await pool.query(
            `INSERT INTO client_2fa_logs (phone, client_name, platform, account_email, request_source, status, code_or_link, message) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                phone || '',
                clientName || '',
                (platform || '').toUpperCase(),
                accountEmail || '',
                requestSource || 'web',
                status || 'unknown',
                codeOrLink || null,
                (message || '').substring(0, 500)
            ]
        );
    } catch (e) {
        console.error('[2FA Log Error]:', e.message);
    }
}

// GET /api/admin/client-2fa-logs - Historial de solicitudes de códigos en vivo para monitoreo
app.get('/api/admin/client-2fa-logs', async (req, res) => {
    try {
        const { pool } = require('../database');
        const limit = Math.min(parseInt(req.query.limit) || 100, 300);
        const [rows] = await pool.query(
            `SELECT * FROM client_2fa_logs ORDER BY id DESC LIMIT ?`,
            [limit]
        );
        res.json({ success: true, logs: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Request 2FA Code from Website
app.post('/api/client/request-2fa', express.json(), async (req, res) => {
    try {
        const { phone, accountId, email, platform } = req.body;
        if (!phone || (!accountId && !email)) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        let cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length === 10 && cleanPhone.startsWith('3')) {
            cleanPhone = '57' + cleanPhone;
        }
        const isDemo = isDemoClientPhone(cleanPhone);
        const userJid = isDemo ? (ADMIN_DEMO_RECIPIENT_PHONE + '@c.us') : (cleanPhone + '@c.us');

        let targetAccount = null;
        if (isDemo) {
            targetAccount = DEMO_ACCOUNTS_LIST.find(a => (accountId && a.id == accountId) || (email && (a.email || '').toLowerCase() === email.toLowerCase()));
        } else {
            const { getAccountsByPhone, fetchCustomersData } = require('../apiService');

            // 1. Obtener cuentas asociadas al teléfono
            let userAccounts = await getAccountsByPhone(cleanPhone);

            // Si no encontró y el teléfono tiene 10 dígitos (ej. Colombia sin prefijo 57), intentar con 57
            if ((!userAccounts || userAccounts.length === 0) && cleanPhone.length === 10) {
                userAccounts = await getAccountsByPhone('57' + cleanPhone);
            }
            // Si no encontró y el teléfono tiene 12 dígitos y empieza por 57, intentar sin 57
            if ((!userAccounts || userAccounts.length === 0) && cleanPhone.length === 12 && cleanPhone.startsWith('57')) {
                userAccounts = await getAccountsByPhone(cleanPhone.slice(2));
            }

            userAccounts = userAccounts || [];

            // A. Buscar por accountId (id, _rowNumber, rowNumber)
            if (accountId) {
                targetAccount = userAccounts.find(a => (a.id || a._rowNumber || a.rowNumber) == accountId);
            }

            // B. Si no se encontró por ID pero tenemos email, buscar por email en sus cuentas
            if (!targetAccount && email) {
                const normEmail = email.trim().toLowerCase();
                targetAccount = userAccounts.find(a => (a.correo || '').trim().toLowerCase() === normEmail);
            }

            // C. Si no se encontró y tenemos plataforma, buscar por coincidencia de plataforma en sus cuentas
            if (!targetAccount && platform) {
                const normPlatform = platform.trim().toUpperCase();
                targetAccount = userAccounts.find(a => {
                    const st = (a.Streaming || '').toUpperCase();
                    return st.includes(normPlatform) || normPlatform.includes(st);
                });
            }

            // D. Si el usuario sólo tiene 1 cuenta asociada y no encontramos otra, usar esa cuenta
            if (!targetAccount && userAccounts.length === 1) {
                targetAccount = userAccounts[0];
            }

            // E. Fallback exhaustivo: Si aún no se encuentra pero se envió email:
            // Validar en el Excel global si la cuenta existe y pertenece a este cliente (por coincidencia de teléfono)
            if (!targetAccount && email) {
                try {
                    const allCustomers = await fetchCustomersData();
                    const normEmail = email.trim().toLowerCase();
                    const matchedRows = allCustomers.filter(c => (c.correo || '').trim().toLowerCase() === normEmail);
                    for (const row of matchedRows) {
                        const rowPhone = (row.numero || row.Numero || row.whatsapp || row.celular || '').toString().replace(/\D/g, '');
                        if (rowPhone && (
                            rowPhone === cleanPhone ||
                            rowPhone.endsWith(cleanPhone) ||
                            cleanPhone.endsWith(rowPhone) ||
                            (cleanPhone.length >= 10 && rowPhone.endsWith(cleanPhone.slice(-10))) ||
                            (rowPhone.length >= 10 && cleanPhone.endsWith(rowPhone.slice(-10)))
                        )) {
                            targetAccount = row;
                            break;
                        }
                    }
                } catch (errFallback) {
                    console.error('[2FA Account Lookup Fallback Error]:', errFallback.message);
                }
            }
        }

        if (!targetAccount) {
            console.warn(`[2FA Request 404] No account found. Phone: ${phone} (${cleanPhone}), accountId: ${accountId}, email: ${email}, platform: ${platform}`);
            return res.status(404).json({ success: false, message: 'Cuenta no encontrada o no vinculada a tu número' });
        }

        // Si la cuenta no está automatizada, no permitir solicitar código desde la web para no saturar al grupo admin
        const autoStatus = await checkAccountAutomationStatus(targetAccount.correo, targetAccount.Streaming);
        if (!autoStatus.isAutomated) {
            console.log(`[2FA Request REJECTED - Unautomated Account]: ${targetAccount.correo} (${targetAccount.Streaming})`);
            await recordClient2FaLog({
                phone: cleanPhone,
                clientName: targetAccount.Nombre || '',
                platform: targetAccount.Streaming || '',
                accountEmail: targetAccount.correo || '',
                requestSource: 'web',
                status: 'unautomated',
                message: 'Cuenta no automatizada (atención manual por WhatsApp)'
            });
            return res.status(200).json({
                success: false,
                unautomated: true,
                message: 'Este servicio no cuenta con entrega automatizada de códigos. Comunícate con tu asesor por WhatsApp para recibir asistencia.'
            });
        }

        const mockMessage = {
            id: { _serialized: `web_request_${Date.now()}` },
            from: userJid,
            fromMe: false,
            isWebRequest: true,
            body: `código de ${(targetAccount.Streaming || '').toUpperCase()}`,
            reply: async (text) => {
                console.log(`[Web OTP Request Reply]: ${text}`);
                // Solo enviar a WhatsApp si el mensaje contiene un código o enlace exitoso, nunca errores o "no encontré"
                const isNotFoundOrError = text.includes('No encontré') || text.includes('inconveniente') || text.includes('Error') || text.includes('hubo un');
                if (ctx.getClient() && !isNotFoundOrError) {
                    try {
                        const { safeSend } = require('../billingService');
                        await safeSend(null, text, userJid, ctx.getClient());
                    } catch(e) {
                        try { await ctx.getClient().sendMessage(userJid, text); } catch(err) {}
                    }
                }
                return text;
            }
        };

        // Ejecutar extractor automático y obtener el resultado estructurado
        const extractionResult = await ctx.processAccountVerificationCode(mockMessage, userJid, targetAccount, isDemo ? ADMIN_DEMO_RECIPIENT_PHONE : cleanPhone, ctx.getClient(), userStates);

        if (extractionResult && extractionResult.limitReached) {
            await recordClient2FaLog({
                phone: cleanPhone,
                clientName: targetAccount.Nombre || '',
                platform: targetAccount.Streaming || '',
                accountEmail: targetAccount.correo || '',
                requestSource: 'web',
                status: 'limit_reached',
                message: `Límite de 3 dispositivos alcanzado (${extractionResult.devicesUsed ?? 3}/3)`
            });
            return res.status(429).json({
                success: false,
                limitReached: true,
                devicesUsed: extractionResult.devicesUsed ?? 3,
                devicesRemaining: 0,
                maxDevices: extractionResult.maxDevices ?? 3,
                message: extractionResult.message || "Has alcanzado el límite de 3 dispositivos permitidos para este servicio. Por favor comunícate con un asesor para transferir tu acceso."
            });
        }

        if (extractionResult && extractionResult.manualRequired) {
            await recordClient2FaLog({
                phone: cleanPhone,
                clientName: targetAccount.Nombre || '',
                platform: targetAccount.Streaming || '',
                accountEmail: targetAccount.correo || '',
                requestSource: 'web',
                status: 'manual_required',
                message: extractionResult.message || "Requiere verificación manual de asesor"
            });
            return res.json({
                success: true,
                manualRequired: true,
                message: extractionResult.message || "Esta cuenta requiere verificación manual. Notificamos a tu asesor para que te entregue el código por WhatsApp en breve.",
                account: targetAccount.correo
            });
        }

        if (extractionResult && (extractionResult.code || extractionResult.link)) {
            await recordClient2FaLog({
                phone: cleanPhone,
                clientName: targetAccount.Nombre || '',
                platform: targetAccount.Streaming || '',
                accountEmail: targetAccount.correo || '',
                requestSource: 'web',
                status: 'success',
                codeOrLink: extractionResult.code || extractionResult.link || '',
                message: extractionResult.code ? `Código encontrado: ${extractionResult.code}` : 'Enlace de acceso listo'
            });
            return res.json({
                success: true,
                message: extractionResult.code ? `Código encontrado: ${extractionResult.code}` : (extractionResult.link ? 'Enlace de acceso listo' : 'Código o enlace extraído con éxito'),
                code: extractionResult.code || null,
                link: extractionResult.link || null,
                snippet: extractionResult.snippet || null,
                type: extractionResult.type || null,
                account: targetAccount.correo,
                devicesUsed: extractionResult.devicesUsed,
                devicesRemaining: extractionResult.devicesRemaining,
                maxDevices: extractionResult.maxDevices || 3
            });
        }

        await recordClient2FaLog({
            phone: cleanPhone,
            clientName: targetAccount.Nombre || '',
            platform: targetAccount.Streaming || '',
            accountEmail: targetAccount.correo || '',
            requestSource: 'web',
            status: 'not_found',
            message: extractionResult?.message || 'No se encontraron códigos recientes en el buzón (cliente aún no presionó enviar código en su app)'
        });

        res.json({
            success: extractionResult?.success || false,
            message: extractionResult?.message || 'Buscando código en buzón... Si acabas de presionar enviar código en tu TV/App, presiona nuevamente en unos segundos.',
            code: extractionResult?.code || null,
            link: extractionResult?.link || null,
            account: targetAccount.correo,
            devicesUsed: extractionResult?.devicesUsed,
            devicesRemaining: extractionResult?.devicesRemaining,
            maxDevices: extractionResult?.maxDevices || 3
        });
    } catch (e) {
        console.error('Error al solicitar 2FA desde web:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Reset Devices for a Customer / Account
app.post('/api/admin/reset-devices', express.json(), async (req, res) => {
    try {
        const { phone, email } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, message: 'Falta número de teléfono' });
        }
        const { resetDeviceUsage } = require('../deviceLimitService');
        const reset = resetDeviceUsage(phone, email);
        res.json({ success: true, message: 'Dispositivos reseteados exitosamente', reset });
    } catch (e) {
        console.error('Error al resetear dispositivos:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/whatsapp/status-diag', async (req, res) => {
    try {
        let state = null;
        try {
            state = await Promise.race([
                ctx.getClient() ? ctx.getClient().getState() : Promise.resolve('NO_CLIENT'),
                new Promise((_, reject) => setTimeout(() => reject(new Error("getState timeout (5s)")), 5000))
            ]);
        } catch (e) {
            state = `ERROR: ${e.message}`;
        }
        res.json({
            hasClient: !!ctx.getClient(),
            hasPupBrowser: !!(ctx.getClient() && ctx.getClient().pupBrowser),
            browserConnected: (ctx.getClient() && ctx.getClient().pupBrowser) ? ctx.getClient().pupBrowser.isConnected() : false,
            hasPupPage: !!(ctx.getClient() && ctx.getClient().pupPage),
            pageClosed: (ctx.getClient() && ctx.getClient().pupPage) ? ctx.getClient().pupPage.isClosed() : false,
            pageUrl: (ctx.getClient() && ctx.getClient().pupPage) ? ctx.getClient().pupPage.url() : null,
            state: state,
            internalStatus: ctx.getCurrentWhatsappStatus() || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
}

module.exports = {
    registerClientPortalRoutes,
    DEMO_ACCOUNTS_LIST,
    isDemoClientPhone,
    ADMIN_DEMO_RECIPIENT_PHONE
};
