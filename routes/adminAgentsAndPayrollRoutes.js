const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../database');
const accountingService = require('../accountingService');

const ROOT_DIR = path.resolve(__dirname, '..');
const rpaJobs = new Map();

async function runRpaRecipe(recipe, variables = {}, jobId = null) {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const results = {};
    const screenshots = [];

    try {
        for (const step of recipe.steps) {
            console.log(`[RPA Runner] Ejecutando paso: ${step.action} - ${step.description || ''}`);

            const replaceVars = (val) => {
                if (typeof val === 'string') {
                    return val.replace(/\{\{(\w+)\}\}/g, (_, name) => {
                        if (results[name] !== undefined) return results[name];
                        return variables[name] !== undefined ? variables[name] : '';
                    });
                }
                return val;
            };

            if (step.url) step.url = replaceVars(step.url);
            if (step.selector) step.selector = replaceVars(step.selector);
            let value = replaceVars(step.value || "");

            const getTimeout = (defaultMs) => {
                if (step.timeout) {
                    const parsed = parseInt(step.timeout);
                    if (!isNaN(parsed) && parsed > 0) {
                        return parsed < 1000 ? parsed * 1000 : parsed;
                    }
                }
                return defaultMs;
            };

            // Update active job status with current action description
            if (jobId) {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.progress = `Paso ${recipe.steps.indexOf(step) + 1} de ${recipe.steps.length}: ${step.description || step.action}`;
                }
            }

            switch (step.action) {
                case 'navigate':
                    await page.goto(step.url, { waitUntil: 'networkidle2', timeout: getTimeout(30000) });
                    await new Promise(r => setTimeout(r, 2000)); // Pacing delay
                    break;
                case 'type':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(15000) });
                    await page.type(step.selector, value);
                    await new Promise(r => setTimeout(r, 1000)); // Pacing delay
                    break;
                case 'click':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(15000) });
                    await page.click(step.selector);
                    await new Promise(r => setTimeout(r, 2000)); // Pacing delay
                    break;
                case 'wait_navigation':
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: getTimeout(20000) });
                    break;
                case 'wait_selector':
                    await page.waitForSelector(step.selector, { timeout: getTimeout(60000) });
                    break;
                case 'extract_text':
                    let extracted = null;
                    try {
                        // 1. Try target selector first with a shorter, fast timeout (12s)
                        await page.waitForSelector(step.selector, { timeout: 12000 });
                        extracted = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.innerText.trim() : null;
                        }, step.selector);
                    } catch (selectorErr) {
                        console.log(`[RPA Runner] Selector ${step.selector} no hallado. Aplicando fallback de escaneo inteligente en pantalla...`);

                        // 2. Fallback: Loop up to 7 times (35 seconds max) if page shows a loading message
                        for (let attempt = 0; attempt < 7; attempt++) {
                            const loadingState = await page.evaluate(() => {
                                const bodyText = document.body ? document.body.innerText : '';
                                return bodyText.includes('trayendo el código') ||
                                    bodyText.includes('espera unos segundos') ||
                                    bodyText.toLowerCase().includes('cargando');
                            });

                            if (loadingState) {
                                console.log(`[RPA Runner] Cargando código de Spotinet... Reintento ${attempt + 1}/7 (espera 5s)`);
                                await new Promise(r => setTimeout(r, 5000)); // Wait 5s for Spotinet to fetch code

                                // Take progress screenshot for user peace of mind
                                try {
                                    const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
                                    const item = {
                                        step: recipe.steps.indexOf(step) + 1,
                                        action: 'extract_wait',
                                        description: `Cargando código (intento ${attempt + 1})...`,
                                        img: `data:image/jpeg;base64,${screenshotBase64}`
                                    };
                                    screenshots.push(item);
                                    if (jobId) {
                                        const job = rpaJobs.get(jobId);
                                        if (job) job.screenshots = [...screenshots];
                                    }
                                } catch (e) { }
                                continue;
                            }
                            break;
                        }

                        // Extract text using keywords and regex
                        extracted = await page.evaluate(() => {
                            const bodyText = document.body ? document.body.innerText : '';

                            // Check if the 20 minutes warning alert is present in page text
                            if (bodyText.includes('últimos 20 min') || bodyText.toLowerCase().includes('no pediste el código')) {
                                return '⚠️ El cliente no ha solicitado el código en su dispositivo en los últimos 20 minutos.';
                            }

                            const elements = Array.from(document.querySelectorAll('p, div, span, h1, h2, h3, h4, h5, h6'));
                            // Look for elements containing keywords like "Código" or "sesión" and having digit patterns
                            const matches = elements.filter(el => {
                                const text = el.innerText || '';
                                return (text.toLowerCase().includes('código') || text.toLowerCase().includes('sesión') || text.toLowerCase().includes('codigo')) && /\b\d{6}\b/.test(text);
                            });

                            if (matches.length > 0) {
                                return matches[0].innerText.trim();
                            }

                            // Last resort: scan the entire body text
                            const bodyMatch = bodyText.match(/\b\d{6}\b/);
                            return bodyMatch ? `Código: ${bodyMatch[0]}` : null;
                        });
                    }

                    results[step.save_as || 'extracted'] = extracted;
                    await new Promise(r => setTimeout(r, 1000)); // Pacing delay
                    break;
                default:
                    console.warn(`[RPA Runner] Acción desconocida: ${step.action}`);
            }

            // Capture step screenshot in real-time
            try {
                const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
                const item = {
                    step: recipe.steps.indexOf(step) + 1,
                    action: step.action,
                    description: step.description || '',
                    img: `data:image/jpeg;base64,${screenshotBase64}`
                };
                screenshots.push(item);

                // Stream updates live to the job status if jobId exists
                if (jobId) {
                    const job = rpaJobs.get(jobId);
                    if (job) {
                        job.screenshots = [...screenshots];
                    }
                }
            } catch (screenshotErr) {
                console.warn('[RPA Runner] Error al tomar captura de pantalla del paso:', screenshotErr.message);
            }
        }

        return { success: true, data: results, screenshots };
    } catch (err) {
        console.error(`[RPA Runner Error] Falla en la receta '${recipe.name}':`, err.message);

        let failureScreenshot = null;
        try {
            const screenshotBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
            failureScreenshot = `data:image/jpeg;base64,${screenshotBase64}`;

            const item = {
                step: recipe.steps.length + 1,
                action: 'failure_capture',
                description: 'Captura del momento de falla',
                img: failureScreenshot
            };
            screenshots.push(item);

            if (jobId) {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.screenshots = [...screenshots];
                }
            }
        } catch (screenshotErr) {
            console.warn('[RPA Runner] Error al tomar captura de pantalla del fallo:', screenshotErr.message);
        }

        return {
            success: false,
            error: err.message,
            screenshots,
            failureScreenshot
        };
    } finally {
        await browser.close();
    }
}

function registerAdminAgentsAndPayrollRoutes(app, ctx) {
    const {
        upload,
        GROUP_ID,
        loginRateLimiter,
        forgotPasswordRateLimiter,
        resetPasswordRateLimiter,
        changePasswordRateLimiter
    } = ctx;

// GET Agent Role
app.get('/api/admin/agent-role', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });

        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT role FROM agents WHERE email = ?', [email.trim().toLowerCase()]);

        if (rows && rows.length > 0) {
            return res.json({ success: true, role: rows[0].role });
        }

        // Si no está registrado en base de datos, verificar si está en la lista estática (como fallback seguro)
        const cleanEmail = email.trim().toLowerCase();
        if (cleanEmail === 'estebanavila182@outlook.com') {
            return res.json({ success: true, role: 'admin' });
        }

        res.json({ success: true, role: 'agent' }); // Rol mínimo por defecto
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET All Agents
app.get('/api/admin/agents', async (req, res) => {
    try {
        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT id, username, fullname, email, phone, role, status, exclude_from_payroll, (password_hash IS NOT NULL AND password_hash != "") AS has_password FROM agents ORDER BY fullname ASC'
        );
        res.json({ success: true, agents: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Admin / Agent Login
app.post('/api/admin/login', loginRateLimiter, express.json(), async (req, res) => {
    try {
        const { email, password } = req.body || {};
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanPass = String(password || '').trim();

        if (!cleanEmail || !cleanPass) {
            return res.status(400).json({ success: false, message: 'Correo y contraseña obligatorios.' });
        }

        const { pool } = require('../database');
        const { verifyAgentPassword, signSessionToken } = require('../authService');

        const [rows] = await pool.query(
            'SELECT id, username, fullname, email, phone, role, status, password_hash FROM agents WHERE LOWER(email) = ? LIMIT 1',
            [cleanEmail]
        );

        const agent = rows && rows.length > 0 ? rows[0] : null;
        if (!agent) {
            return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos.' });
        }

        if (agent.status === 'inactive') {
            return res.status(403).json({ success: false, message: 'Este contrato se encuentra terminado/inactivo. Contacta al administrador.' });
        }

        const check = await verifyAgentPassword(cleanPass, agent.password_hash);
        if (!check.valid) {
            return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos.' });
        }

        if (typeof req.resetRateLimit === 'function') req.resetRateLimit();

        const token = signSessionToken({
            id: agent.id,
            email: agent.email,
            fullname: agent.fullname,
            role: agent.role
        });

        res.json({
            success: true,
            token,
            needsPasswordSetup: check.needsPasswordSetup,
            agent: {
                id: agent.id,
                email: agent.email,
                fullname: agent.fullname,
                role: agent.role,
                phone: agent.phone || null
            }
        });
    } catch (e) {
        console.error('❌ Error en /api/admin/login:', e.message);
        res.status(500).json({ success: false, message: 'Error interno al verificar credenciales.' });
    }
});

// GET Verify Admin / Agent Session Token
app.get('/api/admin/verify-session', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : String(req.query.token || '').trim();
        const { verifySessionToken } = require('../authService');
        const payload = verifySessionToken(token);
        if (!payload) {
            return res.status(401).json({ success: false, message: 'Sesión inválida o expirada.' });
        }

        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT id, fullname, email, role, status FROM agents WHERE id = ? LIMIT 1',
            [payload.id]
        );
        const agent = rows && rows.length > 0 ? rows[0] : null;
        if (!agent || agent.status === 'inactive') {
            return res.status(403).json({ success: false, message: 'Usuario inactivo o no encontrado.' });
        }

        res.json({ success: true, agent });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST Request Password Reset Code (WhatsApp OTP)
app.post('/api/admin/forgot-password', forgotPasswordRateLimiter, express.json(), async (req, res) => {
    try {
        const cleanEmail = String((req.body && req.body.email) || '').trim().toLowerCase();
        if (!cleanEmail) {
            return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico autorizado.' });
        }

        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT id, fullname, email, phone, role, status FROM agents WHERE LOWER(email) = ? LIMIT 1',
            [cleanEmail]
        );
        const agent = rows && rows.length > 0 ? rows[0] : null;

        if (!agent) {
            return res.status(404).json({ success: false, message: 'No encontramos un asesor registrado con ese correo.' });
        }
        if (agent.status === 'inactive') {
            return res.status(403).json({ success: false, message: 'Esta cuenta está inactiva. Contacta al administrador.' });
        }

        const {
            RESET_CODE_TTL_MINUTES,
            generateResetCode,
            sendRecoveryCodeViaWhatsApp
        } = require('../authService');

        const { code, codeHash } = generateResetCode();
        await pool.query(
            'UPDATE agents SET reset_code = ?, reset_code_expires = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
            [codeHash, RESET_CODE_TTL_MINUTES, agent.id]
        );

        const delivery = await sendRecoveryCodeViaWhatsApp(ctx.getClient(), agent, code, GROUP_ID);
        res.json({
            success: true,
            deliveryChannel: delivery.deliveryChannel,
            maskedTarget: delivery.maskedTarget,
            message: `Enviamos un código de 6 dígitos a tu ${delivery.maskedTarget}.`
        });
    } catch (e) {
        console.error('❌ Error en /api/admin/forgot-password:', e.message);
        res.status(500).json({ success: false, message: e.message || 'No se pudo enviar el código de recuperación.' });
    }
});

// POST Reset Password with OTP Code
app.post('/api/admin/reset-password', resetPasswordRateLimiter, express.json(), async (req, res) => {
    try {
        const { email, code, newPassword } = req.body || {};
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanCode = String(code || '').trim();
        const cleanNewPass = String(newPassword || '').trim();

        if (!cleanEmail || !cleanCode || !cleanNewPass) {
            return res.status(400).json({ success: false, message: 'Completa correo, código y nueva contraseña.' });
        }
        if (cleanNewPass.length < 6) {
            return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
        }

        const { pool } = require('../database');
        const { hashResetCode, hashPassword } = require('../authService');

        const [rows] = await pool.query(
            'SELECT id, reset_code, reset_code_expires, status FROM agents WHERE LOWER(email) = ? LIMIT 1',
            [cleanEmail]
        );
        const agent = rows && rows.length > 0 ? rows[0] : null;
        if (!agent || agent.status === 'inactive') {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado o inactivo.' });
        }

        const expectedHash = hashResetCode(cleanCode);
        if (!agent.reset_code || agent.reset_code !== expectedHash) {
            return res.status(400).json({ success: false, message: 'El código ingresado es incorrecto.' });
        }

        if (!agent.reset_code_expires || new Date(agent.reset_code_expires).getTime() < Date.now()) {
            return res.status(400).json({ success: false, message: 'El código ha expirado. Solicita uno nuevo.' });
        }

        const newHash = await hashPassword(cleanNewPass);
        await pool.query(
            'UPDATE agents SET password_hash = ?, reset_code = NULL, reset_code_expires = NULL WHERE id = ?',
            [newHash, agent.id]
        );
        if (typeof req.resetRateLimit === 'function') req.resetRateLimit();

        res.json({ success: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
    } catch (e) {
        console.error('❌ Error en /api/admin/reset-password:', e.message);
        res.status(500).json({ success: false, message: 'Error al restablecer la contraseña.' });
    }
});

// POST Change Password (Authenticated Agent / Admin)
app.post('/api/admin/change-password', changePasswordRateLimiter, express.json(), async (req, res) => {
    try {
        const { email, currentPassword, newPassword } = req.body || {};
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanCurrent = String(currentPassword || '').trim();
        const cleanNew = String(newPassword || '').trim();

        if (!cleanEmail || !cleanCurrent || !cleanNew) {
            return res.status(400).json({ success: false, message: 'Todos los campos son obligatorios.' });
        }
        if (cleanNew.length < 6) {
            return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
        }

        const { pool } = require('../database');
        const { verifyAgentPassword, hashPassword } = require('../authService');
        const [rows] = await pool.query('SELECT id, password_hash, status FROM agents WHERE LOWER(email) = ? LIMIT 1', [cleanEmail]);
        const agent = rows && rows.length > 0 ? rows[0] : null;
        if (!agent || agent.status === 'inactive') {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado o inactivo.' });
        }

        const check = await verifyAgentPassword(cleanCurrent, agent.password_hash);
        if (!check.valid) {
            return res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta.' });
        }

        const newHash = await hashPassword(cleanNew);
        await pool.query('UPDATE agents SET password_hash = ? WHERE id = ?', [newHash, agent.id]);
        if (typeof req.resetRateLimit === 'function') req.resetRateLimit();
        res.json({ success: true, message: 'Contraseña actualizada exitosamente.' });
    } catch (e) {
        console.error('❌ Error en /api/admin/change-password:', e.message);
        res.status(500).json({ success: false, message: 'Error al cambiar contraseña.' });
    }
});

// GET Agent Schedule
app.get('/api/admin/agents/schedule', async (req, res) => {
    try {
        const { email, week_start } = req.query;
        const weekStartStr = week_start || 'default';
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });

        const { pool } = require('../database');
        const [agentRows] = await pool.query('SELECT id FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.json({ success: true, schedule: [] });
        }

        const agentId = agentRows[0].id;
        let [scheduleRows] = await pool.query(
            'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = ? ORDER BY day_of_week ASC, start_time ASC',
            [agentId, weekStartStr]
        );
        let isTemplate = false;
        if (scheduleRows.length === 0 && weekStartStr !== 'default') {
            [scheduleRows] = await pool.query(
                'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = \'default\' ORDER BY day_of_week ASC, start_time ASC',
                [agentId]
            );
            isTemplate = true;
        }

        res.json({ success: true, schedule: scheduleRows, is_template: isTemplate });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET All Agent Schedules
app.get('/api/admin/agents/schedules/all', async (req, res) => {
    try {
        const week_start = req.query.week_start || 'default';
        const { pool } = require('../database');

        const [agents] = await pool.query('SELECT id, username, fullname, email, role, status FROM agents');
        const allSchedules = [];

        for (const agent of agents) {
            let [scheduleRows] = await pool.query(
                'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = ? ORDER BY day_of_week ASC, start_time ASC',
                [agent.id, week_start]
            );
            if (scheduleRows.length === 0 && week_start !== 'default') {
                [scheduleRows] = await pool.query(
                    'SELECT id, day_of_week, start_time, end_time, break_type, break_start FROM agent_schedules WHERE agent_id = ? AND week_start = \'default\' ORDER BY day_of_week ASC, start_time ASC',
                    [agent.id]
                );
            }
            for (const row of scheduleRows) {
                allSchedules.push({
                    id: row.id,
                    day_of_week: row.day_of_week,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    break_type: row.break_type,
                    break_start: row.break_start,
                    fullname: agent.fullname,
                    email: agent.email,
                    role: agent.role
                });
            }
        }
        res.json({ success: true, schedules: allSchedules });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Agent Schedule
app.post('/api/admin/agents/schedule/save', express.json(), async (req, res) => {
    try {
        const { email, schedule, week_start, requester_email, day_of_week } = req.body;
        const weekStartStr = week_start || 'default';
        if (!email) return res.status(400).json({ success: false, message: 'Falta el correo del asesor' });
        if (!Array.isArray(schedule)) return res.status(400).json({ success: false, message: 'El horario debe ser una lista de franjas' });

        const { pool } = require('../database');

        // Authorization check to ensure advisors cannot edit each other
        let isReqAdmin = false;
        if (requester_email) {
            const [reqRows] = await pool.query('SELECT role FROM agents WHERE email = ?', [requester_email.trim().toLowerCase()]);
            isReqAdmin = reqRows.length > 0 && reqRows[0].role === 'admin';
            const isSelf = requester_email.trim().toLowerCase() === email.trim().toLowerCase();
            if (!isReqAdmin && !isSelf) {
                return res.status(403).json({ success: false, message: 'No tienes permiso para modificar el horario de otro colaborador.' });
            }
        }
        let [agentRows] = await pool.query('SELECT id FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        let agentId;
        if (!agentRows || agentRows.length === 0) {
            const username = email.split('@')[0];
            const [insertRes] = await pool.query(
                'INSERT INTO agents (username, fullname, email, role) VALUES (?, ?, ?, ?)',
                [username, username, email.trim().toLowerCase(), 'agent']
            );
            agentId = insertRes.insertId;
        } else {
            agentId = agentRows[0].id;
        }

        // Support Config and Roles lookup
        const { getSupportScheduleConfig, getNowInBogota } = require('../supportScheduleService');
        const supportConfig = getSupportScheduleConfig();

        // Determinar si el día editado ya ocurrió en el pasado (Bogotá)
        const nowBogota = getNowInBogota();
        const todayBogotaYMD = `${nowBogota.getFullYear()}-${String(nowBogota.getMonth() + 1).padStart(2, '0')}-${String(nowBogota.getDate()).padStart(2, '0')}`;
        
        let isPastDate = false;
        if (weekStartStr && weekStartStr !== 'default' && /^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
            const [wY, wM, wD] = weekStartStr.split('-').map(Number);
            const targetDayVal = day_of_week !== undefined ? parseInt(day_of_week) : 1;
            // day_of_week: 1=Lunes (offset 0), ..., 6=Sábado (offset 5), 0=Domingo (offset 6)
            const dayOffset = targetDayVal === 0 ? 6 : targetDayVal - 1;
            const targetDate = new Date(wY, wM - 1, wD + dayOffset);
            const targetYMD = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
            isPastDate = targetYMD < todayBogotaYMD;
        }

        // Obtener turnos existentes de este asesor para verificar si solo está recortando horas heredadas
        const [existingAgentSlots] = await pool.query(
            'SELECT day_of_week, start_time, end_time FROM agent_schedules WHERE agent_id = ? AND week_start = ?',
            [agentId, weekStartStr]
        );
        const existingSlotsMap = new Map();
        for (const es of existingAgentSlots) {
            existingSlotsMap.set(es.day_of_week, es);
        }

        const [allAgents] = await pool.query('SELECT id, role, fullname FROM agents');
        const agentMap = {};
        allAgents.forEach(a => {
            agentMap[a.id] = { role: a.role, fullname: a.fullname };
        });

        const currentAgentRole = agentMap[agentId]?.role || 'agent';

        // 1. Validaciones previas de franja horaria y descanso antes de tocar la base de datos
        for (const slot of schedule) {
            const dayOfWeek = parseInt(slot.day_of_week);
            if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

            // Restringir validación de la franja horaria 10-22 al día editado en el modal
            if (day_of_week !== undefined && dayOfWeek !== parseInt(day_of_week)) continue;

            const startTime = slot.start_time;
            const endTime = slot.end_time;
            if (!startTime || !endTime) continue;

            const breakType = slot.break_type || 'none';
            const breakStart = slot.break_start || null;

            const [shVal, smVal] = startTime.split(':').map(Number);
            const [ehVal, emVal] = endTime.split(':').map(Number);

            // Franja dinámica configurable (mínimo 10:00 AM a 22:00)
            const configStartLimit = supportConfig.shift_start_limit || "10:00";
            const configEndLimit = supportConfig.shift_end_limit || "22:00";
            const [startLimitH, startLimitM] = configStartLimit.split(':').map(Number);
            const [endLimitH, endLimitM] = configEndLimit.split(':').map(Number);

            const startMinTotal = shVal * 60 + smVal;
            const endMinTotal = ehVal * 60 + emVal;
            const limitStartMinTotal = startLimitH * 60 + startLimitM;
            const limitEndMinTotal = endLimitH * 60 + endLimitM;

            // EXCEPCIÓN DE RESPETO HISTÓRICO Y CASOS DE FUERZA MAYOR / APAGÓN:
            // 1. Si quien guarda es Admin (Esteban), tiene flexibilidad total.
            // 2. Si es una fecha pasada, no bloquear por la regla nueva de apertura.
            // 3. Si el turno ya estaba registrado previamente con inicio < 10:00 (ej. 09:00) y solo están recortando o ajustando,
            //    se permite mantener o recortar sobre la base ya pactada.
            const prevSlot = existingSlotsMap.get(dayOfWeek);
            const prevStart = prevSlot ? prevSlot.start_time.substring(0, 5) : null;
            const isRetainingOrTrimmingHistoricalStart = prevStart && (startTime >= prevStart && startMinTotal < limitStartMinTotal);

            const isStartLimitExempt = isReqAdmin || isPastDate || isRetainingOrTrimmingHistoricalStart;

            if ((!isStartLimitExempt && startMinTotal < limitStartMinTotal) || endMinTotal > limitEndMinTotal) {
                return res.status(400).json({
                    success: false,
                    message: `Los turnos de soporte deben estar estrictamente dentro de la franja permitida de ${configStartLimit} a ${configEndLimit}.`
                });
            }

            const durationHoursVal = (ehVal * 60 + emVal - (shVal * 60 + smVal)) / 60;
            if (durationHoursVal >= 5 && breakType === 'none') {
                return res.status(400).json({
                    success: false,
                    message: `Los turnos de 5 horas o más deben incluir obligatoriamente un descanso por salud mental.`
                });
            }

            if (breakType !== 'none' && breakStart) {
                const [bh, bm] = breakStart.split(':').map(Number);
                const startMin = shVal * 60 + smVal;
                const endMin = ehVal * 60 + emVal;
                const breakStartMin = bh * 60 + bm;
                const duration = breakType === 'break_30' ? 30 : 60;
                const buffer = 90; // 90 mins = 1.5 hours buffer
                if (breakStartMin < startMin + buffer || breakStartMin > endMin - duration - buffer) {
                    return res.status(400).json({
                        success: false,
                        message: `La hora de descanso no puede estar al inicio ni al final de la franja laboral.`
                    });
                }
            }
        }

        // Group incoming slots by day to validate overlaps and sum of hours with existing schedules
        const incomingSlotsByDay = new Map();
        for (const slot of schedule) {
            const day = parseInt(slot.day_of_week);
            if (isNaN(day)) continue;
            if (!incomingSlotsByDay.has(day)) incomingSlotsByDay.set(day, []);
            incomingSlotsByDay.get(day).push(slot);
        }

        for (const [dayOfWeek, daySlots] of incomingSlotsByDay.entries()) {
            // Restringir validaciones al día editado en el modal para evitar deadlocks con datos heredados de otros días
            if (day_of_week !== undefined && dayOfWeek !== parseInt(day_of_week)) {
                continue;
            }
            // Get other agents' schedules for this specific day and week
            const [otherSchedulesRaw] = await pool.query(
                `SELECT s.*, a.role, a.fullname FROM agent_schedules s 
                 JOIN agents a ON s.agent_id = a.id 
                 WHERE (s.week_start = ? OR s.week_start = "default") 
                   AND s.agent_id != ? 
                   AND s.day_of_week = ?`,
                [weekStartStr, agentId, dayOfWeek]
            );

            // Filter otherSchedules per agent: if weekStartStr !== 'default' and custom slots exist for that week, override 'default'
            const customByAgent = new Map();
            const defaultByAgent = new Map();

            for (const s of otherSchedulesRaw) {
                if (s.week_start === weekStartStr) {
                    if (!customByAgent.has(s.agent_id)) customByAgent.set(s.agent_id, []);
                    customByAgent.get(s.agent_id).push(s);
                } else {
                    if (!defaultByAgent.has(s.agent_id)) defaultByAgent.set(s.agent_id, []);
                    defaultByAgent.get(s.agent_id).push(s);
                }
            }

            const otherSchedules = [];
            const otherAgentIds = new Set([...customByAgent.keys(), ...defaultByAgent.keys()]);
            for (const otherId of otherAgentIds) {
                const slots = (weekStartStr !== 'default' && customByAgent.has(otherId))
                    ? customByAgent.get(otherId)
                    : (defaultByAgent.has(otherId) ? defaultByAgent.get(otherId) : customByAgent.get(otherId));
                if (slots) otherSchedules.push(...slots);
            }

            // Merge current agent's new slots and other agents' slots to check validation
            const mergedSlots = [
                ...daySlots.map(s => ({
                    agent_id: agentId,
                    role: currentAgentRole,
                    fullname: agentMap[agentId]?.fullname || 'Este Asesor',
                    start_time: s.start_time,
                    end_time: s.end_time,
                    break_type: s.break_type
                })),
                ...otherSchedules.map(s => ({
                    agent_id: s.agent_id,
                    role: s.role,
                    fullname: s.fullname,
                    start_time: s.start_time.substring(0, 5),
                    end_time: s.end_time.substring(0, 5),
                    break_type: s.break_type
                }))
            ];

            // 1. Validate overlaps
            for (let i = 0; i < mergedSlots.length; i++) {
                for (let j = i + 1; j < mergedSlots.length; j++) {
                    const slotA = mergedSlots[i];
                    const slotB = mergedSlots[j];

                    // Only validate overlaps involving at least one slot of the target agent being updated
                    if (slotA.agent_id !== agentId && slotB.agent_id !== agentId) {
                        continue;
                    }

                    const [shA, smA] = slotA.start_time.split(':').map(Number);
                    const [ehA, emA] = slotA.end_time.split(':').map(Number);
                    const [shB, smB] = slotB.start_time.split(':').map(Number);
                    const [ehB, emB] = slotB.end_time.split(':').map(Number);

                    const startA = shA * 60 + smA;
                    const endA = ehA * 60 + emA;
                    const startB = shB * 60 + smB;
                    const endB = ehB * 60 + emB;

                    // Check overlap
                    if (startA < endB && endA > startB) {
                        // If both slots belong to the exact same agent, overlap is never allowed
                        if (slotA.agent_id === slotB.agent_id) {
                            return res.status(400).json({
                                success: false,
                                message: `Conflicto de horario: Tus turnos (${slotA.start_time}-${slotA.end_time} y ${slotB.start_time}-${slotB.end_time}) se solapan entre sí.`
                            });
                        }

                        // Exception: Overlap between DIFFERENT agents is allowed only if at least one agent is 'trial' (cangureando)
                        if (slotA.role !== 'trial' && slotB.role !== 'trial') {
                            return res.status(400).json({
                                success: false,
                                message: `Conflicto de horario: Los turnos de ${slotA.fullname} y ${slotB.fullname} se solapan de ${slotA.start_time}-${slotA.end_time} y ${slotB.start_time}-${slotB.end_time}. Los turnos no se pueden solapar a menos que uno de ellos sea un asesor en prueba (rol trial).`
                            });
                        }
                    }
                }
            }

            // 2. Validate total daily net hours PER AGENT (configurable max_hours_limit if allow_overtime is false, absolute 12 hours max if allow_overtime is true)
            let targetAgentDailyNetMinutes = 0;
            if (currentAgentRole !== 'trial') {
                for (const slot of daySlots) {
                    const [sh, sm] = slot.start_time.split(':').map(Number);
                    const [eh, em] = slot.end_time.split(':').map(Number);
                    const diff = (eh * 60 + em) - (sh * 60 + sm);
                    if (diff <= 0) continue;

                    let breakMin = 0;
                    if (slot.break_type === 'break_30') breakMin = 30;
                    else if (slot.break_type === 'lunch_60') breakMin = 60;
                    else if (slot.break_type === 'lunch_120') breakMin = 120;

                    targetAgentDailyNetMinutes += Math.max(0, diff - breakMin);
                }
            }

            const isOvertimeAllowed = supportConfig.allow_overtime !== false;
            const currentDailyLimit = isOvertimeAllowed ? 12 : parseFloat(supportConfig.max_hours_limit || 8);

            if (targetAgentDailyNetMinutes > currentDailyLimit * 60) {
                return res.status(400).json({
                    success: false,
                    message: isOvertimeAllowed
                        ? `La jornada diaria para ${agentMap[agentId]?.fullname || 'este asesor'} supera el límite absoluto de 12 horas diarias (actual: ${(targetAgentDailyNetMinutes / 60).toFixed(1)} horas).`
                        : `No se permiten horas extras. La jornada diaria para ${agentMap[agentId]?.fullname || 'este asesor'} supera el límite diario configurado de ${currentDailyLimit} horas netas.`
                });
            }

            // 3. Validate total daily GROUP hours (bolsa grupal combinada, máx 10 horas diarias entre todos los asesores)
            const maxGroupDailyHours = parseFloat(supportConfig.max_group_hours_limit || 10);
            let totalGroupDailyNetMinutes = 0;

            for (const slot of mergedSlots) {
                // Los asesores en rol 'trial' (acompañamiento/cangureo) no consumen bolsa regular
                if (slot.role === 'trial') continue;

                const [sh, sm] = slot.start_time.split(':').map(Number);
                const [eh, em] = slot.end_time.split(':').map(Number);
                const diff = (eh * 60 + em) - (sh * 60 + sm);
                if (diff <= 0) continue;

                let breakMin = 0;
                if (slot.break_type === 'break_30') breakMin = 30;
                else if (slot.break_type === 'lunch_60') breakMin = 60;
                else if (slot.break_type === 'lunch_120') breakMin = 120;

                totalGroupDailyNetMinutes += Math.max(0, diff - breakMin);
            }

            // Excepción: Esteban (Admin) tiene flexibilidad total para autorizar horas adicionales o reducir intercalación según demanda
            if (!isReqAdmin && totalGroupDailyNetMinutes > maxGroupDailyHours * 60) {
                const totalHoursCalc = (totalGroupDailyNetMinutes / 60).toFixed(1);
                return res.status(400).json({
                    success: false,
                    message: `Límite grupal excedido: Los turnos de este día suman ${totalHoursCalc} horas netas entre todos los asesores, superando el límite grupal de ${maxGroupDailyHours} horas diarias permitidas (intercalación activa). Si se requiere turno anticipado (desde las 4 PM o 3 PM) por alta demanda, solicita a Esteban que ajuste la bolsa grupal.`
                });
            }
        }

        // Obtener franjas horarias existentes para auditoría
        const [existingSlots] = await pool.query(
            'SELECT day_of_week, start_time, end_time FROM agent_schedules WHERE agent_id = ? AND week_start = ?',
            [agentId, weekStartStr]
        );

        // Obtener nombres reales
        let requesterName = requester_email || 'Un asesor';
        if (requester_email) {
            const [reqRows] = await pool.query('SELECT fullname FROM agents WHERE email = ?', [requester_email.trim().toLowerCase()]);
            if (reqRows.length > 0 && reqRows[0].fullname) requesterName = reqRows[0].fullname;
        }
        let targetAgentName = email;
        const [targetAgentRows] = await pool.query('SELECT fullname FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (targetAgentRows.length > 0 && targetAgentRows[0].fullname) targetAgentName = targetAgentRows[0].fullname;

        // Corrección de nombre Esclepiades -> Katherine
        if (requesterName.toLowerCase().includes('esclepiades')) requesterName = 'Katherine';
        if (targetAgentName.toLowerCase().includes('esclepiades')) targetAgentName = 'Katherine';

        const daysMap = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const parseWeekStartDate = (weekStartStr) => {
            if (!weekStartStr || weekStartStr === 'default') return null;
            const [y, m, d] = weekStartStr.split('-').map(Number);
            return new Date(y, m - 1, d);
        };
        const weekStartDate = parseWeekStartDate(weekStartStr);

        const getDayDateLabel = (d, weekStartDate) => {
            const dayName = daysMap[d];
            if (!weekStartDate) return dayName;
            const targetDate = new Date(weekStartDate);
            const offset = d === 0 ? 6 : d - 1;
            targetDate.setDate(targetDate.getDate() + offset);
            const dayNum = String(targetDate.getDate()).padStart(2, '0');
            const monthNum = String(targetDate.getMonth() + 1).padStart(2, '0');
            return `${dayName} ${dayNum}/${monthNum}`;
        };

        let changeMessages = [];

        const existByDay = {};
        existingSlots.forEach(s => {
            if (!existByDay[s.day_of_week]) existByDay[s.day_of_week] = [];
            existByDay[s.day_of_week].push(s);
        });

        const incomingByDay = {};
        schedule.forEach(s => {
            const day = parseInt(s.day_of_week);
            if (!incomingByDay[day]) incomingByDay[day] = [];
            incomingByDay[day].push(s);
        });

        for (let d = 0; d <= 6; d++) {
            const dayLabel = getDayDateLabel(d, weekStartDate);
            const existing = existByDay[d] || [];
            const incoming = incomingByDay[d] || [];

            if (existing.length === 0 && incoming.length > 0) {
                incoming.forEach(s => {
                    changeMessages.push(`ha agregado un turno el ${dayLabel} (${s.start_time} - ${s.end_time})`);
                });
            } else if (existing.length > 0 && incoming.length === 0) {
                existing.forEach(s => {
                    changeMessages.push(`ha eliminado el turno del ${dayLabel} (${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)})`);
                });
            } else if (existing.length > 0 && incoming.length > 0) {
                const extStr = existing.map(s => `${s.start_time.substring(0, 5)}-${s.end_time.substring(0, 5)}`).sort().join(',');
                const incStr = incoming.map(s => `${s.start_time.substring(0, 5)}-${s.end_time.substring(0, 5)}`).sort().join(',');
                if (extStr !== incStr) {
                    changeMessages.push(`ha modificado el turno del ${dayLabel} (antes: ${extStr.replace(/,/g, ', ')}, ahora: ${incStr.replace(/,/g, ', ')})`);
                }
            }
        }

        // 2. Ejecutar la transacción de base de datos
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            await connection.query('DELETE FROM agent_schedules WHERE agent_id = ? AND week_start = ?', [agentId, weekStartStr]);

            for (const slot of schedule) {
                const dayOfWeek = parseInt(slot.day_of_week);
                const startTime = slot.start_time;
                const endTime = slot.end_time;

                if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;
                if (!startTime || !endTime) continue;

                const breakType = slot.break_type || 'none';
                const breakStart = slot.break_start || null;

                await connection.query(
                    'INSERT INTO agent_schedules (agent_id, week_start, day_of_week, start_time, end_time, break_type, break_start) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [agentId, weekStartStr, dayOfWeek, startTime, endTime, breakType, breakStart]
                );
            }

            await connection.commit();

            // Enviar notificación al grupo de WhatsApp tras éxito en DB
            if (changeMessages.length > 0 && ctx.getClient() && ctx.getClient().info) {
                try {
                    const groupChat = await ctx.getClient().getChatById(GROUP_ID);
                    if (groupChat) {
                        const targetNameSuffix = (requester_email && requester_email.trim().toLowerCase() !== email.trim().toLowerCase())
                            ? ` para *${targetAgentName}*`
                            : '';
                        const msgLines = changeMessages.map(msg => `• *${requesterName}* ${msg}${targetNameSuffix}`);
                        const notificationText = `📅 *Notificación de Horarios*:\n\n${msgLines.join('\n')}`;
                        await groupChat.sendMessage(notificationText);
                    }
                } catch (sendErr) {
                    console.error('[Schedule Notification] Error en envío de whatsapp:', sendErr.message);
                }
            }

            res.json({ success: true, message: 'Horario del asesor guardado correctamente' });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (e) {
        console.error('❌ Error en /api/admin/agents/schedule/save:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Monthly/Period Payroll and Bonuses
app.get('/api/admin/payroll', async (req, res) => {
    try {
        const { month, start_date, end_date } = req.query;
        
        let startDateStr = start_date;
        let endDateStr = end_date;
        let payrollMonth = month;

        if (!startDateStr || !endDateStr) {
            if (!payrollMonth || !/^\d{4}-\d{2}$/.test(payrollMonth)) {
                const now = new Date();
                payrollMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            }
            const [yr, mo] = payrollMonth.split('-').map(Number);
            const daysInMonth = new Date(yr, mo, 0).getDate();
            startDateStr = `${yr}-${String(mo).padStart(2, '0')}-01`;
            endDateStr = `${yr}-${String(mo).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
        } else {
            payrollMonth = startDateStr.substring(0, 7);
        }

        const { pool } = require('../database');
        const { getSupportScheduleConfig } = require('../supportScheduleService');
        const supportConfig = getSupportScheduleConfig();
        const hourlyRate = parseFloat(supportConfig.hourly_rate || 8333);
        const trialHourlyRate = parseFloat(supportConfig.trial_hourly_rate || 5000);
        const trialHoursTarget = parseFloat(supportConfig.trial_hours_target || 80);

        const [agents] = await pool.query('SELECT id, fullname, email, role, exclude_from_payroll, status FROM agents');

        const startObj = new Date(startDateStr + 'T00:00:00');
        const endObj = new Date(endDateStr + 'T00:00:00');
        
        const weekStarts = new Set();
        const daysMapping = [];

        const getBogotaMondayStr = (date) => {
            const d = new Date(date);
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1);
            const monday = new Date(d.setDate(diff));
            return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
        };

        let curr = new Date(startObj);
        while (curr <= endObj) {
            const y = curr.getFullYear();
            const m = String(curr.getMonth() + 1).padStart(2, '0');
            const d = String(curr.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`;
            const dayOfWeek = curr.getDay();
            const mondayStr = getBogotaMondayStr(curr);

            weekStarts.add(mondayStr);
            daysMapping.push({ dateStr, dayOfWeek, mondayStr });

            curr.setDate(curr.getDate() + 1);
        }

        const weekStartsList = Array.from(weekStarts);

        let schedules = [];
        if (weekStartsList.length > 0) {
            const [rows] = await pool.query(
                'SELECT * FROM agent_schedules WHERE week_start IN (?) OR week_start = "default"',
                [weekStartsList]
            );
            schedules = rows;
        }

        const [bonuses] = await pool.query('SELECT * FROM agent_bonuses WHERE bonus_month = ? OR (created_at >= ? AND created_at <= ?)', [payrollMonth, startDateStr + ' 00:00:00', endDateStr + ' 23:59:59']);
        const [closedRecords] = await pool.query(
            'SELECT * FROM monthly_payroll WHERE status = "paid" AND (payroll_month = ? OR (start_date <= ? AND end_date >= ?) OR (start_date >= ? AND end_date <= ?))',
            [payrollMonth, endDateStr, startDateStr, startDateStr, endDateStr]
        );

        const payrollData = [];

        for (const agent of agents) {
            const closed = closedRecords.find(r => r.agent_id === agent.id);
            const agentBonuses = bonuses.filter(b => b.agent_id === agent.id);
            const totalBonuses = agentBonuses.reduce((sum, b) => sum + parseFloat(b.amount), 0);
            const isExcludedFromPayroll = agent.exclude_from_payroll === 1 || agent.exclude_from_payroll === true;

            let totalNetMinutes = 0;

            for (const day of daysMapping) {
                const hasCustomWeek = schedules.some(s => s.agent_id === agent.id && s.week_start === day.mondayStr);
                const targetWeekStart = hasCustomWeek ? day.mondayStr : 'default';
                const daySlots = schedules.filter(s => s.agent_id === agent.id && s.week_start === targetWeekStart && s.day_of_week === day.dayOfWeek);

                for (const slot of daySlots) {
                    if (!slot.start_time || !slot.end_time) continue;
                    const [sh, sm] = slot.start_time.split(':').map(Number);
                    const [eh, em] = slot.end_time.split(':').map(Number);
                    const diff = (eh * 60 + em) - (sh * 60 + sm);
                    if (diff <= 0) continue;

                    let breakMin = 0;
                    if (slot.break_type === 'break_30') breakMin = 30;
                    else if (slot.break_type === 'lunch_60') breakMin = 60;
                    else if (slot.break_type === 'lunch_120') breakMin = 120;

                    totalNetMinutes += Math.max(0, diff - breakMin);
                }
            }

            const totalHours = totalNetMinutes / 60;

            // Compute historical trial hours from closed periods
            const [histRows] = await pool.query(
                'SELECT SUM(COALESCE(trial_hours, total_hours)) as total_hist FROM monthly_payroll WHERE agent_id = ? AND status = "paid"',
                [agent.id]
            );
            const totalHistTrial = parseFloat(histRows[0].total_hist || 0);
            const trialHoursLeft = Math.max(0, trialHoursTarget - totalHistTrial);

            let trialHoursInPeriod = 0;
            let normalHoursInPeriod = 0;
            let rateToUse = closed ? parseFloat(closed.hourly_rate) : hourlyRate;
            const hoursToUse = closed ? parseFloat(closed.total_hours) : totalHours;
            const bonusesToUse = closed ? parseFloat(closed.total_bonuses) : totalBonuses;
            let finalPayment;

            if (closed) {
                trialHoursInPeriod = parseFloat(closed.trial_hours || 0);
                normalHoursInPeriod = parseFloat(closed.normal_hours || closed.total_hours);
                if (isExcludedFromPayroll) {
                    finalPayment = 0;
                } else {
                    const closedPay = parseFloat(closed.total_payment || 0);
                    finalPayment = closedPay > 0 ? closedPay : ((hoursToUse * rateToUse) + bonusesToUse);
                }
            } else {
                if (isExcludedFromPayroll) {
                    trialHoursInPeriod = 0;
                    normalHoursInPeriod = totalHours;
                    finalPayment = 0;
                } else if (agent.role === 'trial') {
                    if (totalHours <= trialHoursLeft) {
                        trialHoursInPeriod = totalHours;
                        normalHoursInPeriod = 0;
                        finalPayment = (totalHours * trialHourlyRate) + totalBonuses;
                        rateToUse = trialHourlyRate;
                    } else {
                        trialHoursInPeriod = trialHoursLeft;
                        normalHoursInPeriod = totalHours - trialHoursInPeriod;
                        finalPayment = (trialHoursInPeriod * trialHourlyRate) + (normalHoursInPeriod * hourlyRate) + totalBonuses;
                        rateToUse = hourlyRate;
                    }
                } else {
                    trialHoursInPeriod = 0;
                    normalHoursInPeriod = totalHours;
                    finalPayment = (totalHours * hourlyRate) + totalBonuses;
                }
            }

            if (agent.status === 'active' || totalHours > 0 || totalBonuses > 0 || closed) {
                payrollData.push({
                    agent_id: agent.id,
                    fullname: agent.fullname,
                    email: agent.email,
                    role: agent.role,
                    contract_status: agent.status,
                    exclude_from_payroll: isExcludedFromPayroll,
                    start_date: startDateStr,
                    end_date: endDateStr,
                    total_hours: hoursToUse,
                    trial_hours: trialHoursInPeriod,
                    normal_hours: normalHoursInPeriod,
                    trial_hours_target: trialHoursTarget,
                    trial_hours_left: trialHoursLeft,
                    total_hist_trial: totalHistTrial + trialHoursInPeriod,
                    hourly_rate: hourlyRate,
                    normal_hourly_rate: hourlyRate,
                    trial_hourly_rate: trialHourlyRate,
                    bonuses: agentBonuses,
                    total_bonuses: bonusesToUse,
                    total_payment: finalPayment,
                    status: closed ? closed.status : 'draft'
                });
            }
        }

        res.json({
            success: true,
            payroll: payrollData,
            config: {
                hourly_rate: hourlyRate,
                trial_hourly_rate: trialHourlyRate,
                trial_hours_target: trialHoursTarget
            },
            period: {
                start_date: startDateStr,
                end_date: endDateStr,
                payroll_month: payrollMonth
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Toggle Exclude from Payroll
app.post('/api/admin/agents/toggle-payroll', express.json(), async (req, res) => {
    try {
        const { agent_id, exclude_from_payroll } = req.body;
        if (agent_id === undefined) return res.status(400).json({ success: false, message: 'Falta ID de asesor' });

        const { pool } = require('../database');
        const excludeVal = exclude_from_payroll ? 1 : 0;
        await pool.query('UPDATE agents SET exclude_from_payroll = ? WHERE id = ?', [excludeVal, agent_id]);

        res.json({
            success: true,
            exclude_from_payroll: excludeVal === 1,
            message: excludeVal === 1 ? 'Asesor excluido de la nómina ($0 a pagar).' : 'Asesor incluido en la nómina.'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Update Agent Role
app.post('/api/admin/agents/role', express.json(), async (req, res) => {
    try {
        const { agent_id, role, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!agent_id || !role) return res.status(400).json({ success: false, message: 'Falta ID de asesor o rol' });

        const { pool } = require('../database');
        await pool.query('UPDATE agents SET role = ? WHERE id = ?', [role, agent_id]);

        res.json({ success: true, message: 'Rol de asesor actualizado correctamente.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Create or Update Employee / Agent
app.post('/api/admin/agents/save', express.json(), async (req, res) => {
    try {
        const { id, fullname, email, phone, password, role, status, exclude_from_payroll } = req.body;
        if (!fullname || !email) {
            return res.status(400).json({ success: false, message: 'Nombre completo y correo son obligatorios.' });
        }

        const { pool } = require('../database');
        const cleanEmail = email.trim().toLowerCase();
        const cleanPhone = phone ? String(phone).replace(/\D/g, '') : null;
        const cleanRole = role || 'agent';
        const cleanStatus = status || 'active';
        const excludeVal = exclude_from_payroll ? 1 : 0;
        const username = cleanEmail.split('@')[0].replace(/[^a-z0-9_]/g, '');

        const safeHashPassword = async (pwd) => {
            try {
                const bcrypt = require('bcryptjs');
                return await bcrypt.hash(pwd, 10);
            } catch (e) {
                const crypto = require('crypto');
                return crypto.createHash('sha256').update(pwd).digest('hex');
            }
        };

        if (id) {
            let updateQuery = 'UPDATE agents SET fullname = ?, email = ?, role = ?, status = ?, exclude_from_payroll = ?';
            let params = [fullname.trim(), cleanEmail, cleanRole, cleanStatus, excludeVal];

            if (phone !== undefined) {
                updateQuery += ', phone = ?';
                params.push(cleanPhone);
            }

            if (password && password.trim().length > 0) {
                const hashed = await safeHashPassword(password.trim());
                updateQuery += ', password_hash = ?';
                params.push(hashed);
            }

            updateQuery += ' WHERE id = ?';
            params.push(id);

            await pool.query(updateQuery, params);

            return res.json({
                success: true,
                message: `Empleado ${fullname} actualizado correctamente.`
            });
        } else {
            const [existing] = await pool.query('SELECT id FROM agents WHERE email = ?', [cleanEmail]);
            if (existing && existing.length > 0) {
                return res.status(400).json({ success: false, message: `El correo ${cleanEmail} ya está registrado.` });
            }

            let hashedPassword = null;
            if (password && password.trim().length > 0) {
                hashedPassword = await safeHashPassword(password.trim());
            }

            const [result] = await pool.query(
                'INSERT INTO agents (username, fullname, email, phone, role, status, password_hash, exclude_from_payroll) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [username, fullname.trim(), cleanEmail, cleanPhone, cleanRole, cleanStatus, hashedPassword, excludeVal]
            );

            return res.json({
                success: true,
                agent_id: result.insertId,
                message: `Empleado ${fullname} creado exitosamente.`
            });
        }
    } catch (e) {
        console.error('Error al guardar empleado:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Terminate Contract / Change Agent Status
app.post('/api/admin/agents/terminate', express.json(), async (req, res) => {
    try {
        const { agent_id, status, reason, performed_by } = req.body;
        if (!agent_id) return res.status(400).json({ success: false, message: 'Falta ID de asesor.' });

        const { pool } = require('../database');
        const targetStatus = status || 'inactive';
        const excludePayroll = targetStatus === 'inactive' ? 1 : 0;
        const actionType = targetStatus === 'inactive' ? 'terminated' : 'reactivated';
        const defaultReason = targetStatus === 'inactive' ? 'Terminación de contrato de colaborador' : 'Reactivación de contrato de colaborador';
        const finalReason = reason && reason.trim().length > 0 ? reason.trim() : defaultReason;
        const operator = performed_by || 'admin';

        await pool.query(
            'UPDATE agents SET status = ?, exclude_from_payroll = ? WHERE id = ?',
            [targetStatus, excludePayroll, agent_id]
        );

        // Registrar auditoría en historial de contratos
        await pool.query(
            'INSERT INTO agent_contract_history (agent_id, action, status, reason, performed_by) VALUES (?, ?, ?, ?, ?)',
            [agent_id, actionType, targetStatus, finalReason, operator]
        );

        res.json({
            success: true,
            message: targetStatus === 'inactive'
                ? `Contrato finalizado (${finalReason}). Colaborador excluido de Nómina y Labores.`
                : `Contrato reactivado correctamente (${finalReason}).`
        });
    } catch (e) {
        console.error("Error en terminate endpoint:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Agent Contract Audit History
app.get('/api/admin/agents/:id/contract-history', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ success: false, message: 'Falta ID de asesor.' });

        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT * FROM agent_contract_history WHERE agent_id = ? ORDER BY created_at DESC',
            [id]
        );

        res.json({ success: true, history: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Registrar log de actividad del sistema
app.post('/api/admin/logs/log', express.json(), async (req, res) => {
    try {
        const { agent_email, agent_name, action_type, description, metadata } = req.body;
        if (!agent_email || !action_type || !description) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el log.' });
        }
        const { pool } = require('../database');
        const metaStr = metadata ? JSON.stringify(metadata) : null;
        await pool.query(
            'INSERT INTO system_activity_logs (agent_email, agent_name, action_type, description, metadata) VALUES (?, ?, ?, ?, ?)',
            [agent_email, agent_name || agent_email.split('@')[0], action_type, description, metaStr]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Consultar auditoría de logs del sistema
app.get('/api/admin/logs', async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT * FROM system_activity_logs ORDER BY created_at DESC LIMIT ?',
            [Number(limit)]
        );
        res.json({ success: true, logs: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Add or Update Bonus / Advance (Only Esteban / Admin can edit)
app.post('/api/admin/bonuses/save', express.json(), async (req, res) => {
    try {
        const { id, email, amount, reason, bonus_month, performed_by } = req.body;
        if (!email || amount === undefined || amount === null || amount === '' || !reason || !bonus_month) {
            return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
        }

        const performer = (performed_by || '').trim().toLowerCase();
        // Solo lo puede editar Esteban (o admin explícito)
        if (id && performer && performer !== 'estebanavila182@outlook.com') {
            return res.status(403).json({ success: false, message: 'Solo Esteban tiene autorización exclusiva para modificar ajustes de nómina.' });
        }

        const { pool } = require('../database');
        const [agentRows] = await pool.query('SELECT id, fullname FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado' });
        }
        const agentId = agentRows[0].id;
        const agentName = agentRows[0].fullname;
        const numAmount = parseFloat(amount);

        // Asegurar que la tabla de auditoría exista
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agent_bonus_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                bonus_id INT NOT NULL,
                agent_id INT NOT NULL,
                action ENUM('create', 'edit', 'delete') NOT NULL DEFAULT 'edit',
                old_amount DECIMAL(10,2) NULL,
                new_amount DECIMAL(10,2) NULL,
                old_reason VARCHAR(255) NULL,
                new_reason VARCHAR(255) NULL,
                performed_by VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        if (id) {
            const [oldRows] = await pool.query('SELECT * FROM agent_bonuses WHERE id = ?', [id]);
            if (oldRows.length === 0) {
                return res.status(404).json({ success: false, message: 'Registro de ajuste no encontrado' });
            }
            const old = oldRows[0];
            const oldAmount = parseFloat(old.amount);
            const oldReason = old.reason;

            await pool.query(
                'UPDATE agent_bonuses SET amount = ?, reason = ?, bonus_month = ? WHERE id = ?',
                [numAmount, reason, bonus_month, id]
            );

            // Registrar en historial de auditoría
            await pool.query(
                'INSERT INTO agent_bonus_history (bonus_id, agent_id, action, old_amount, new_amount, old_reason, new_reason, performed_by) VALUES (?, ?, "edit", ?, ?, ?, ?, ?)',
                [id, agentId, oldAmount, numAmount, oldReason, reason, performer || 'estebanavila182@outlook.com']
            );

            // Registrar en logs generales del sistema
            try {
                await pool.query(
                    'INSERT INTO system_activity_logs (agent_email, agent_name, action_type, description, metadata) VALUES (?, ?, "BONUS_EDIT", ?, ?)',
                    [
                        performer || 'estebanavila182@outlook.com',
                        'Esteban (Admin)',
                        `Edición de ajuste de ${agentName}: antes $${oldAmount} (${oldReason}) -> ahora $${numAmount} (${reason})`,
                        JSON.stringify({ bonus_id: id, old_amount: oldAmount, new_amount: numAmount, old_reason: oldReason, new_reason: reason })
                    ]
                );
            } catch (logErr) { /* ignore */ }

            // Sincronizar actualización con cash_flow_entries si es adelanto
            if (numAmount < 0) {
                try {
                    const rawBase = req.body.advance_base ? Math.abs(parseFloat(req.body.advance_base)) : Math.abs(numAmount);
                    await pool.query(
                        'UPDATE cash_flow_entries SET amount = ?, description = ? WHERE platform = "NOMINA" AND is_automated = 1 AND description LIKE ?',
                        [rawBase, `Adelanto de nómina: ${agentName} (${reason})`, `%(${oldReason})%`]
                    );
                } catch (updAccErr) {
                    console.error('[CashFlow Sync] Error al actualizar asiento contable:', updAccErr.message);
                }
            }

            return res.json({ success: true, message: 'Ajuste de nómina actualizado correctamente y registrado en historial' });
        } else {
            const [insertRes] = await pool.query(
                'INSERT INTO agent_bonuses (agent_id, bonus_month, amount, reason) VALUES (?, ?, ?, ?)',
                [agentId, bonus_month, numAmount, reason]
            );
            const newId = insertRes.insertId;

            await pool.query(
                'INSERT INTO agent_bonus_history (bonus_id, agent_id, action, old_amount, new_amount, old_reason, new_reason, performed_by) VALUES (?, ?, "create", NULL, ?, NULL, ?, ?)',
                [newId, agentId, numAmount, reason, performer || 'estebanavila182@outlook.com']
            );

            // Sincronización Automática con Contabilidad (Flujo de Caja Real)
            if (numAmount < 0) {
                try {
                    const accountingService = require('../accountingService');
                    const entryDate = new Date().toISOString().split('T')[0];
                    const rawBase = req.body.advance_base ? Math.abs(parseFloat(req.body.advance_base)) : Math.abs(numAmount);
                    const commVal = req.body.commission_amount ? Math.abs(parseFloat(req.body.commission_amount)) : 0;

                    // 1. Egreso por el monto del adelanto entregado al asesor
                    await accountingService.addTransaction(
                        'expense',
                        'NOMINA',
                        rawBase,
                        `Adelanto de nómina: ${agentName} (${reason})`,
                        entryDate,
                        1
                    );

                    // 2. Ingreso por la comisión cobrada ($10.000 COP)
                    if (commVal > 0) {
                        await accountingService.addTransaction(
                            'income',
                            'COMISIONES',
                            commVal,
                            `Comisión por trámite de adelanto: ${agentName}`,
                            entryDate,
                            1
                        );
                    }
                } catch (accErr) {
                    console.error('[Accounting Sync] Error registrando adelanto en contabilidad:', accErr.message);
                }
            }

            return res.json({ success: true, message: 'Ajuste registrado correctamente y sincronizado con contabilidad' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET History of a specific bonus / advance
app.get('/api/admin/bonuses/:id/history', async (req, res) => {
    try {
        const { id } = req.params;
        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT * FROM agent_bonus_history WHERE bonus_id = ? ORDER BY id DESC',
            [id]
        );
        res.json({ success: true, history: rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Delete Bonus (With Audit & Restrict to Esteban)
app.post('/api/admin/bonuses/delete', express.json(), async (req, res) => {
    try {
        const { id, performed_by } = req.body;
        if (!id) return res.status(400).json({ success: false, message: 'Falta el id del bono' });

        const performer = (performed_by || '').trim().toLowerCase();
        if (performer && performer !== 'estebanavila182@outlook.com') {
            return res.status(403).json({ success: false, message: 'Solo Esteban tiene autorización para eliminar ajustes de nómina.' });
        }

        const { pool } = require('../database');
        const [oldRows] = await pool.query('SELECT * FROM agent_bonuses WHERE id = ?', [id]);
        if (oldRows.length > 0) {
            const old = oldRows[0];
            await pool.query(
                'INSERT INTO agent_bonus_history (bonus_id, agent_id, action, old_amount, new_amount, old_reason, new_reason, performed_by) VALUES (?, ?, "delete", ?, NULL, ?, NULL, ?)',
                [id, old.agent_id, parseFloat(old.amount), old.reason, performer || 'estebanavila182@outlook.com']
            );

            // Revertir asiento en cash_flow_entries si correspondía a un adelanto o abono
            if (parseFloat(old.amount) < 0) {
                try {
                    await pool.query(
                        'DELETE FROM cash_flow_entries WHERE platform = "NOMINA" AND is_automated = 1 AND description LIKE ?',
                        [`%(${old.reason})%`]
                    );
                } catch (delAccErr) {
                    console.error('[CashFlow Sync] Error al eliminar asiento contable:', delAccErr.message);
                }
            }
        }

        await pool.query('DELETE FROM agent_bonuses WHERE id = ?', [id]);
        res.json({ success: true, message: 'Ajuste eliminado correctamente y archivado en auditoría' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Close Monthly / Cutoff Period Payroll
app.post('/api/admin/payroll/close', express.json(), async (req, res) => {
    try {
        const { email, payroll_month, start_date, end_date, total_hours, trial_hours, normal_hours, hourly_rate, total_bonuses, total_payment, status, period_label } = req.body;
        if (!email || (!payroll_month && !start_date)) {
            return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
        }

        const { pool } = require('../database');
        const { getSupportScheduleConfig } = require('../supportScheduleService');
        const supportConfig = getSupportScheduleConfig();
        const trialHoursTarget = parseFloat(supportConfig.trial_hours_target || 80);
        const trialHourlyRate = parseFloat(supportConfig.trial_hourly_rate || 5000);
        const hourlyRateConfig = parseFloat(supportConfig.hourly_rate || 8333);

        const [agentRows] = await pool.query('SELECT id, role, fullname FROM agents WHERE email = ?', [email.trim().toLowerCase()]);
        if (!agentRows || agentRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Asesor no encontrado' });
        }
        const agent = agentRows[0];
        const agentId = agent.id;
        const stat = status || 'paid';
        const pMonth = payroll_month || (start_date ? start_date.substring(0, 7) : '2026-07');
        const sDate = start_date || `${pMonth}-01`;
        const eDate = end_date || `${pMonth}-31`;
        const totHours = parseFloat(total_hours || 0);
        const totBonuses = parseFloat(total_bonuses || 0);

        // Delete previous closed/draft entry for this agent in this month / date range before inserting
        await pool.query(
            'DELETE FROM monthly_payroll WHERE agent_id = ? AND (payroll_month = ? OR (start_date = ? AND end_date = ?))',
            [agentId, pMonth, sDate, eDate]
        );

        // Compute historical trial hours completed BEFORE this closing (excluding current month)
        const [histRows] = await pool.query(
            'SELECT SUM(COALESCE(trial_hours, total_hours)) as total_hist FROM monthly_payroll WHERE agent_id = ? AND status = "paid" AND (payroll_month != ? OR payroll_month IS NULL)',
            [agentId, pMonth]
        );
        const totalHistTrial = parseFloat(histRows[0].total_hist || 0);
        const trialHoursLeft = Math.max(0, trialHoursTarget - totalHistTrial);

        let trHours = parseFloat(trial_hours || 0);
        let normHours = parseFloat(normal_hours || (totHours - trHours));
        let rateToUse = parseFloat(hourly_rate || hourlyRateConfig);
        let finalPayment = parseFloat(total_payment || 0);

        let promoted = false;

        // If agent is currently trial (or trial_hours were computed for this period):
        if (agent.role === 'trial') {
            if (totHours <= trialHoursLeft) {
                trHours = totHours;
                normHours = 0;
                rateToUse = trialHourlyRate;
                finalPayment = (trHours * trialHourlyRate) + totBonuses;
            } else {
                trHours = trialHoursLeft;
                normHours = totHours - trHours;
                finalPayment = (trHours * trialHourlyRate) + (normHours * hourlyRateConfig) + totBonuses;
                rateToUse = hourlyRateConfig;
            }

            // Auto-promote trial agent if target trial hours completed
            if (totalHistTrial + trHours >= trialHoursTarget) {
                await pool.query('UPDATE agents SET role = "agent" WHERE id = ?', [agentId]);
                promoted = true;
            }
        }

        const pLabel = period_label || `Período ${sDate} al ${eDate}`;

        await pool.query(`
            INSERT INTO monthly_payroll (agent_id, payroll_month, start_date, end_date, total_hours, trial_hours, normal_hours, hourly_rate, total_bonuses, total_payment, period_label, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [agentId, pMonth, sDate, eDate, totHours, trHours, normHours, rateToUse, totBonuses, finalPayment, pLabel, stat]);

        // Auto-registrar egreso en cash_flow_entries por la liquidación de nómina
        if (stat === 'paid' && finalPayment > 0) {
            try {
                const accountingService = require('../accountingService');
                const entryDate = eDate || new Date().toISOString().split('T')[0];
                const desc = `Liquidación de nómina: ${agent.fullname} (${pLabel})`;
                // Limpiar previo egreso automatizado para este mismo período y asesor si existía
                await pool.query(
                    'DELETE FROM cash_flow_entries WHERE platform = "NOMINA" AND is_automated = 1 AND description LIKE ?',
                    [`Liquidación de nómina: ${agent.fullname} (${pLabel})%`]
                );
                await accountingService.addTransaction('expense', 'NOMINA', finalPayment, desc, entryDate, 1);
            } catch (accErr) {
                console.error('[Accounting Sync] Error registrando nómina en contabilidad:', accErr.message);
            }
        }

        res.json({
            success: true,
            promoted,
            total_hours: totHours,
            trial_hours: trHours,
            normal_hours: normHours,
            total_payment: finalPayment,
            message: promoted
                ? `Nómina cerrada correctamente (${trHours.toFixed(1)}h a tarifa prueba de $${trialHourlyRate.toLocaleString('es-CO')} + ${normHours.toFixed(1)}h a tarifa agente). ¡${agent.fullname} completó las ${trialHoursTarget}h de prueba y fue promovido automáticamente a AGENT!`
                : `Nómina archivada y cerrada correctamente (${trHours.toFixed(1)}h prueba + ${normHours.toFixed(1)}h agente). Total a pagar: $${Math.round(finalPayment).toLocaleString('es-CO')}.`
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Payroll History / Archived Pay Stubs
app.get('/api/admin/payroll/history', async (req, res) => {
    try {
        const { pool } = require('../database');
        const [records] = await pool.query(`
            SELECT mp.*, a.fullname, a.email, a.role as current_role 
            FROM monthly_payroll mp 
            JOIN agents a ON mp.agent_id = a.id 
            ORDER BY mp.id DESC
        `);
        res.json({ success: true, history: records });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Re-open / Cancel Closed Payroll Period (Admin Only)
app.post('/api/admin/payroll/reopen', express.json(), async (req, res) => {
    try {
        const { agent_id, id, payroll_month, start_date, end_date } = req.body;
        const { pool } = require('../database');

        if (id) {
            const [rows] = await pool.query('SELECT mp.*, a.fullname FROM monthly_payroll mp JOIN agents a ON mp.agent_id = a.id WHERE mp.id = ?', [id]);
            if (rows.length > 0) {
                const rec = rows[0];
                await pool.query(
                    'DELETE FROM cash_flow_entries WHERE platform = "NOMINA" AND is_automated = 1 AND description LIKE ?',
                    [`Liquidación de nómina: ${rec.fullname} (${rec.period_label})%`]
                );
            }
            await pool.query('DELETE FROM monthly_payroll WHERE id = ?', [id]);
        } else if (agent_id) {
            const [rows] = await pool.query(
                'SELECT mp.*, a.fullname FROM monthly_payroll mp JOIN agents a ON mp.agent_id = a.id WHERE mp.agent_id = ? AND (mp.payroll_month = ? OR (mp.start_date = ? AND mp.end_date = ?))',
                [agent_id, payroll_month, start_date, end_date]
            );
            for (const rec of rows) {
                await pool.query(
                    'DELETE FROM cash_flow_entries WHERE platform = "NOMINA" AND is_automated = 1 AND description LIKE ?',
                    [`Liquidación de nómina: ${rec.fullname} (${rec.period_label})%`]
                );
            }
            await pool.query(
                'DELETE FROM monthly_payroll WHERE agent_id = ? AND (payroll_month = ? OR (start_date = ? AND end_date = ?))',
                [agent_id, payroll_month, start_date, end_date]
            );
        } else {
            return res.status(400).json({ success: false, message: 'Se requiere ID de nómina o ID de asesor' });
        }

        res.json({ success: true, message: 'Nómina reabierta correctamente. Ahora puedes corregir horas, bonos o estatus y volver a cerrar.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Default Prompts Templates
const DEFAULT_PAYMENT_PROMPT = `Analiza la siguiente descripción textual de una imagen/comprobante y determina si corresponde a un COMPROBANTE DE PAGO, RECIBO DE TRANSFERENCIA o CAPTURA DE PANTALLA DE UNA TRANSACCIÓN EXITOSA.
Contexto de la charla: {{CHAT_HISTORY}}

DESCRIPCIÓN DE LA IMAGEN DE PAGO:
"""
{{IMAGE_DESCRIPTION}}
"""

Debes responder en formato JSON:
{
  "isReceipt": boolean, // true si la descripción detalla claramente un recibo de banco con una transferencia exitosa.
  "amount": number | null, // El valor EXACTO de la transferencia (solo números enteros) si es legible.
  "bank": string | null, // Nombre del banco o medio detectado (Nequi, Daviplata, Bancolombia, Bre-B, etc.)
  "confidence": number, // Confianza de que es un recibo real y válido (0 a 1)
  "destinationKey": string | null, // Número exacto de la llave, cuenta, CVU, o destino al que se envió el dinero. Ej: "0087387259", "300 123 4567", "esteban@nequi.com". Extráelo aunque aparezca parcial. MUY IMPORTANTE.
  "destinationName": string | null // Nombre del destinatario/negocio si aparece en lugar de la llave. Ej: "SHEERIT ESTEBAN AVILA", "TIENDA EJEMPLO". Aparece frecuentemente en pagos por QR de Negocios.
}`;

const DEFAULT_PLAN_PROMPT = `El usuario está en el proceso de elegir un plan de la siguiente lista de opciones disponibles para la plataforma "{{PLATFORM_NAME}}":
{{PLANS_LIST}}

{{CART_LIST}}

El mensaje actual del usuario es: "{{MESSAGE_CONTENT}}"

Analiza la intención del usuario y clasifícala en uno de los siguientes sub-intents:
1. "plan_selection": El usuario está eligiendo o confirmando uno de los planes (ej. dice "la 1", "netflix 4k", "el de 17000" o escribe un número directamente).
2. "service_doubt_or_ignorance": El usuario tiene dudas sobre los servicios, precios, características, expresa desconocimiento, no entiende qué está eligiendo, o tiene confusión/inquietudes sobre cómo funciona su combo o si incluye otras plataformas del carrito (por ejemplo, si pregunta "¿Y paramount?", "¿Este plan incluye ambos?", "¿Qué diferencia hay?", "pero es que no entiendo", etc.).
3. "other": Cualquier otro tipo de mensaje.

Si el sub-intent es "service_doubt_or_ignorance", debes activar el ESPÍRITU DEL VENDEDOR:
- Escribe una respuesta comercial (salesReply) sumamente amable, persuasiva, vendedora y clara.
- Explica detalladamente y con paciencia qué plataformas están en su pedido y que primero estamos definiendo el plan de "{{PLATFORM_NAME}}".
- Resuelve la duda con base en las características y dile que al final sumaremos los servicios con un descuento por combo.

Salida esperada en formato JSON estricto:
{
    "subIntent": "plan_selection" | "service_doubt_or_ignorance" | "other",
    "salesReply": string | null, // Si subIntent es "service_doubt_or_ignorance", escribe la respuesta vendedora y aclaratoria detallada. En otro caso, null.
    "selectedIndex": number | null // Si subIntent es "plan_selection", indica el número de la opción elegida (1, 2, 3...) o null si no se entiende. En otro caso, null.
}`;

const DEFAULT_INITIAL_INTENT_PROMPT = `Analiza el primer mensaje del usuario para identificar qué desea hacer.

{{MEDIA_DESCRIPTION}}

GUÍA DE FUNCIONAMIENTO DE PLATAFORMAS:
{{PLATFORM_CONTEXT}}

INFORMACIÓN DEL CLIENTE (Servicios actuales):
{{ACCOUNT_SUMMARY}}

Contexto previo: {{CHAT_HISTORY}}
Mensaje actual: "{{MESSAGE_CONTENT}}"

Categorías para "intent":
- "comprar": El usuario quiere adquirir un servicio nuevo o pregunta por disponibilidad/precios de algo que NO tiene. 
  *IMPORTANTE*: Si el usuario pregunta "¿tienes disponible?", "¿entregas ya?", "¿qué tienes para entrega inmediata?", clasifícalo como "comprar" con frustración 0 y genera un mensaje que invite a la venta con total confianza.
- "credenciales": El usuario solicita las credenciales (correo/contraseña) de su cuenta actual, solicita un código de verificación/acceso/token 2FA (ej: "me puede regalar el código", "necesito el código de acceso"), reporta explícitamente "la contraseña no corresponde", "clave incorrecta", pide recordar su pin de acceso, o pregunta cuándo se vence / fecha de vencimiento / fecha de pago de su cuenta actual. (Si pide código de verificación/2FA, establece también metadata.is2faScreen = true).
- "renovar": El usuario quiere pagar, renovar o pregunta el costo de un servicio que YA TIENE contratado.
- "pagar": El usuario pregunta cómo pagar o envía un comprobante.
- "soporte": Problemas técnicos, fallas de conexión, errores en el cobro, perfiles caídos, o si pide explícitamente hablar con un humano/asesor. (NO usar si es explícitamente un error de clave).
- "cierre": El usuario se despide, da las gracias, confirma fin de charla o da un cierre natural (ej: "ok", "listo", "gracias", "vale", "chao", "adiós").
- "cancelar": El usuario manifiesta EXPRESAMENTE que no quiere renovar, que quiere cancelar el servicio o pide la baja.
- "duda_contexto": El usuario tiene dudas o realiza preguntas sobre información recién discutida en el chat actual (por ejemplo: qué significa "manual", de quién es la cuenta de Nequi/Daviplata, cómo proceder, etc.) o realiza preguntas de consulta sobre características de las plataformas, precios de planes o detalles técnicos específicos que funcionan como un paréntesis en la charla actual.
- "desconocido": Cualquier otro mensaje, incluyendo saludos iniciales sin petición específica.

Regla de Intents (MÁXIMA PRIORIDAD):
1. **MENÚ NUMÉRICO:** Si el mensaje es exactamente "1", "2", "3", "4" o "5", clasifícalo según el menú: "1"->comprar, "2"->credenciales, "3"->renovar, "4"->soporte, "5"->soporte.
2. **CONTINUIDAD:** Si es una respuesta corta ("sí", "nequi") a una pregunta previa, usa el intent de esa charla.
3. **STOCK:** Si pregunta por "disponibilidad", "stock", "entrega ya", el intent es "comprar".
4. **SOPORTE:** PRIORIDAD si hay errores o fallas.
5. **PAGAR:** Si pregunta cómo pagar o envía comprobante.

Lógica de recuperación ("recoveredState"):
- "awaiting_payment_method": 
    * Caso A: Si el mensaje menciona un medio de pago (Nequi, Daviplata, etc.) y en el historial el asistente ya dio un total a pagar.
    * Caso B (COLABORATIVO): Si el "Asistente" (humano, sin 🤖) negoció un precio (ej: "te queda en 21") y el usuario actual acepta (ej: "Listo", "Dale", "Vale"). EN ESTE CASO, el bot debe saltar aquí para dar los medios de pago. Si detectas el monto negociado, ponlo en metadata.total.
- "waiting_human": 
    * Caso A (CONVERSACIÓN ACTIVA): Si en el historial reciente aparece un mensaje del "Asistente" (humano, sin el emoji 🤖) hablando con el usuario, pidiendo datos o dando soporte. ES VITAL que si ves al Asistente humano hablando, devuelvas "waiting_human" para no interrumpirlo. EXCEPCIÓN: Si el usuario solicita explícitamente un código de verificación/acceso (ej: "solicitar el código", "necesito el código", "reenviar el correo"), NO devuelvas "waiting_human" aunque un asesor haya enviado un código previamente.
    * Caso B (SILENCIO FORZADO): Si el usuario ha enviado múltiples mensajes de queja, insultos o insistencia extrema (ej: "hola???", "alguien??", "que pasa?") sin respuesta, y el bot no tiene una solución técnica inmediata. 
- "awaiting_purchase_platforms": Si el usuario está preguntando por precios de plataformas específicas, comparando planes o preguntando "cuánto cuesta".
- "awaiting_payment_confirmation": Si el mensaje ACTUAL es explícitamente una imagen de comprobante o texto indicando "ya pagué", "aquí el recibo", etc. NUNCA devuelvas "awaiting_payment_confirmation" si el mensaje actual pide credenciales, solicita un código de verificación/acceso, reporta problemas de acceso o si un asesor humano ya confirmó la actualización/entrega en el historial.
- Si no hay un flujo claro a medias, pon null. 

Regla de Frustración:
- Analiza si el usuario suena desesperado, enojado o ha insistido mucho en corto tiempo sin ser atendido. Púntualo del 0 al 10 en "frustrationLevel". 
- IMPORTANTE: Si el mensaje actual es un saludo (Hola, buenos días) o un ping (?, sigo esperando) y en el historial reciente (mensajes no leídos) hay una solicitud clara de **"credenciales", "comprar" o "pagar"** que NO fue respondida adecuadamente, PRIORIZA esa petición sobre el saludo. El intent debe ser el de la petición pendiente (ej: "comprar" si pidió Netflix).

REGLA DE DEDUCCIÓN DE CONTEXTO Y CONTINUIDAD (MÁXIMA PRIORIDAD):
Nunca analices el "Mensaje actual" de forma aislada. Debes deducir estrictamente a qué está respondiendo el cliente basándote en el historial:
1. Si el "Mensaje actual" contiene varios mensajes (separados por \n), analízalos como una ráfaga lógica. Si hay contradicciones, dale prioridad al último mensaje de la ráfaga o al que sea más específico (ej: si dice "Hola" y luego "Quiero Netflix", el intent es "comprar").
2. Si el Asistente (especialmente si es humano sin 🤖) acaba de hacer una pregunta o pedir un dato (ej: "¿Qué operador tienes?", "Confírmame tu correo", "Pásame el comprobante") y el cliente responde con ese dato (ej: "Claro", "Engativa", "Mi correo es..."), ES UNA CONTINUACIÓN DIRECTA.
3. En este caso de continuación directa de una charla humana (donde el humano acaba de preguntar algo hace poco), puedes devolver "recoveredState": "waiting_human" para no estorbar. Sin embargo, si el usuario reporta una falla técnica clara, prioriza ayudarlo si el humano no ha respondido en más de 20-30 minutos.
4. Si el bot 🤖 estaba a la mitad de un flujo (ej: esperando método de pago) y el cliente responde a eso, recupera el estado correspondiente. ¡El contexto manda!
5. **RELEVANCIA TEMPORAL Y REANUDACIÓN:** 
   - Si han pasado más de 2 horas (compara la hora actual del sistema vs la del historial) desde el último mensaje del "Asistente" humano, NO devuelvas "waiting_human" a menos que el usuario esté respondiendo a una pregunta muy específica que aún tenga sentido. 
   - Si el "Mensaje actual" es una queja técnica clara (intent: "soporte" o "credenciales") y han pasado más de 30 minutos desde la última intervención humana, el bot DEBE retomar la ayuda si tiene la respuesta técnica. No dejes al cliente esperando si el humano ya no está activamente en el chat.
   - Si el mensaje del humano fue solo un "gracias", "listo" o un cierre, no bloquees el bot para futuras dudas del usuario.
6. **COHERENCIA CONTEXTUAL Y SENTIDO COMÚN (MÁXIMA COHERENCIA):**
   - El bot debe responder con sentido estricto al contexto de la conversación. No inventes intenciones ni mezcles temas de compras, pagos o soporte si el cliente solo hace una consulta puntual o da continuidad lógica a un mensaje previo.
   - Si el mensaje del cliente es ambiguo o no encaja en flujos comerciales/técnicos, clasifícalo como "duda_contexto" o "soporte" con explanation clara y sin forzar transiciones de estado erróneas.

Salida esperada JSON:
{
    "intent": "comprar" | "credenciales" | "pagar" | "soporte" | "cierre" | "catalogo" | "duda_contexto" | "desconocido",
    "recoveredState": string | null,
    "frustrationLevel": number,
    "userName": string | null,
    "isNameComplete": boolean,
    "detectedPlatform": string | null, 
    "explanation": string | null,
    "metadata": {
        "duration_months": number | null,
        "is2faScreen": boolean | null
    } | null 
}

En "explanation", escribe una breve explicación en español del contenido de la imagen (OCR, textos principales, errores detectados, códigos) o del mensaje del usuario.
Si el mensaje actual es una imagen o el texto menciona un pago, revisa si es un comprobante. Si lo es, pon intent: "pagar".
Si la imagen muestra una PANTALLA DE INICIO DE SESIÓN pidiendo un CÓDIGO DE VERIFICACIÓN (2FA, código de 6 dígitos enviado al correo o app autenticadora) o confirmación de inicio de sesión por enlace (ej. Crunchyroll), o si el usuario reporta que el código/enlace recibido no funcionó / fue incorrecto, pon intent: "soporte" con metadata.is2faScreen = true (para que el bot intente fallback de lectura por correo o transfiera de inmediato al asesor con contexto claro).`;

const DEFAULT_CREDENTIALS_PROMPT = `Eres un agente humano y empático de servicio al cliente de "Sheerit".
Un cliente nos ha pedido revisar sus credenciales de streaming.

Aquí están los datos de sus plataformas:
{{CREDENTIALS_LIST}}

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

MENSAJE DEL CLIENTE:
"{{MESSAGE_CONTENT}}"

INSTRUCCIONES:
1. Si el cliente tiene una duda específica (ej: "¿cambió la clave?", "¿cuál es mi pin?", "no puedo entrar"), RESPÓNDELA directamente usando los datos arriba.
2. Luego de responder la duda, entrega la información de sus cuentas de forma amable, clara y amigable.

⚠️ REGLAS CRÍTICAS:
1. Muestra SIEMPRE el Correo, la Clave y el Perfil/PIN para CADA cuenta de la lista. NUNCA resumas u omitas esta información.
2. **PROHIBIDO INVENTAR / ALUCINAR**: Transcribe EXACTAMENTE el Correo y la Clave proporcionados en la lista de arriba. Queda estrictamente prohibido inventar correos ficticios (como sheeritstorecol@gmail.com u otros) o contraseñas (como Sheerit2025* u otras) que no estén tal cual en la lista. Si el dato dice "N/A" o está vacío, indícalo tal cual y pídele al usuario esperar a que el asesor lo asigne.
3. **PROHIBIDO SIMULAR ENTREGAS SIN ASIGNACIÓN**: NUNCA generes respuestas afirmando que el pago ya fue validado y que en un momento se le enviará la cuenta, a menos que las credenciales ya aparezcan efectivamente en la lista de arriba.
4. **IMPORTANTE (Cuentas Familiares/Extras/Enlaces de Acceso)**: Si en los datos dice que la clave es "(Acceso por invitación/perfil propio)" o para la plataforma se entrega un enlace de confirmación/inicio de sesión (ej. Crunchyroll), explica amablemente al usuario que debe hacer clic en el enlace entregado para confirmar que ha sido él quien intentó iniciar sesión, o que para ese servicio no se usa una clave compartida sino acceso por invitación/correo propio.
5. Si la cuenta está vencida, mantén el aviso de que la clave está oculta por seguridad.
6. Si la lista está vacía, no des por sentado que no tiene servicios si acaba de reportar su pago u operador; infórmale con tacto que su activación está siendo procesada en el sistema o transfiérelo a soporte técnico.
6. Al final de tu mensaje, incluye el emoji 🤖 para indicar que eres un asistente automatizado.

No incluyas saludos genéricos como "[Tu Nombre]". Puedes despedirte en nombre del equipo de Sheerit.`;

const DEFAULT_REACTIVATION_PROMPT = `Eres el Asistente Virtual de Sheerit Store. Acabas de ser RE-ACTIVADO por un administrador en este chat.
Tu objetivo es saludar al cliente amablemente y addressar (abordar) de inmediato lo último que estaba preguntando o reportando mientras tú estabas silenciado.

HISTORIAL RECIENTE:
{{CHAT_HISTORY}}

INSTRUCCIONES:
1. Saluda cordialmente (Ej: "¡Hola! He vuelto para ayudarte...").
2. Menciona que un asesor te pidió retomar la atención.
3. Analiza los mensajes del CLIENTE en el historial:
   - Si preguntó por precios, dale una pincelada de lo que buscaba.
   - Si reportó una falla, dile que ya estás revisando su caso.
   - Si pidió credenciales de una cuenta ya existente, dile que con gusto le ayudas a consultarlas. Si se trata de una compra nueva recién pagada, dile que nuestro equipo ya está procesando sus accesos para entregárselos a la mayor brevedad.
4. Sé conciso y empático. No repitas todo el historial, solo demuestra que lo "leíste" y estás listo para ayudar.
5. Usa emojis amigables 🤖.

Responde solo con el texto del mensaje para el cliente.`;

// GET Prompts Config
app.get('/api/config/prompts', async (req, res) => {
    try {
        const { key } = req.query;
        const configKey = key || 'fallback_template';
        const validKeys = [
            'fallback_template',
            'payment_receipt_prompt',
            'plan_selection_prompt',
            'initial_intent_prompt',
            'credentials_delivery_prompt',
            'reactivation_prompt'
        ];

        if (!validKeys.includes(configKey)) {
            return res.status(400).json({ success: false, message: 'Llave de configuración inválida' });
        }

        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT cfg_value FROM system_configs WHERE cfg_key = ?', [configKey]);
        if (rows && rows.length > 0) {
            return res.json({ success: true, prompt: rows[0].cfg_value });
        }

        // Si no está en BD, usar el default correspondiente
        if (configKey === 'fallback_template') {
            const defaultPath = path.join(ROOT_DIR, 'prompts', 'fallback_template.txt');
            if (fs.existsSync(defaultPath)) {
                const promptContent = fs.readFileSync(defaultPath, 'utf8');
                return res.json({ success: true, prompt: promptContent, isDefault: true });
            }
        } else if (configKey === 'payment_receipt_prompt') {
            return res.json({ success: true, prompt: DEFAULT_PAYMENT_PROMPT, isDefault: true });
        } else if (configKey === 'plan_selection_prompt') {
            return res.json({ success: true, prompt: DEFAULT_PLAN_PROMPT, isDefault: true });
        } else if (configKey === 'initial_intent_prompt') {
            return res.json({ success: true, prompt: DEFAULT_INITIAL_INTENT_PROMPT, isDefault: true });
        } else if (configKey === 'credentials_delivery_prompt') {
            return res.json({ success: true, prompt: DEFAULT_CREDENTIALS_PROMPT, isDefault: true });
        } else if (configKey === 'reactivation_prompt') {
            return res.json({ success: true, prompt: DEFAULT_REACTIVATION_PROMPT, isDefault: true });
        }

        res.status(404).json({ success: false, message: 'Plantilla de prompt no encontrada' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Prompts Config
app.post('/api/config/prompts/save', express.json(), async (req, res) => {
    try {
        const { prompt, password, key } = req.body;
        const configKey = key || 'fallback_template';
        const validKeys = [
            'fallback_template',
            'payment_receipt_prompt',
            'plan_selection_prompt',
            'initial_intent_prompt',
            'credentials_delivery_prompt',
            'reactivation_prompt'
        ];

        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!prompt) return res.status(400).json({ success: false, message: 'Falta el contenido del prompt' });
        if (!validKeys.includes(configKey)) {
            return res.status(400).json({ success: false, message: 'Llave de configuración inválida' });
        }

        const { pool } = require('../database');
        await pool.query(
            'INSERT INTO system_configs (cfg_key, cfg_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE cfg_value = VALUES(cfg_value)',
            [configKey, prompt]
        );

        // Limpiar caché local si existe en aiService
        try {
            const { clearCachedSystemPrompt } = require('../aiService');
            clearCachedSystemPrompt();
        } catch (err) { }

        res.json({ success: true, message: 'Plantilla de prompt guardada con éxito en la base de datos' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// ==========================================
// SAAS RPA RPA RECIPE EXECUTION & MANAGEMENT
// ==========================================



// POST Import Scribe PDF via Gemini
app.post('/api/admin/rpa/import-scribe', upload.single('pdf'), async (req, res) => {
    let tempPath = null;
    try {
        const password = req.body.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!req.file) return res.status(400).json({ success: false, message: 'No se envió ningún archivo PDF' });

        tempPath = req.file.path;
        let pdfBuffer;
        if (req.file.buffer) {
            pdfBuffer = req.file.buffer;
        } else if (req.file.path) {
            pdfBuffer = fs.readFileSync(req.file.path);
        }

        if (!pdfBuffer) {
            return res.status(400).json({ success: false, message: 'No se pudo leer el archivo PDF' });
        }

        const { parseScribePdfToRecipe } = require('../aiService');
        const recipe = await parseScribePdfToRecipe(pdfBuffer);

        res.json({ success: true, recipe });
    } catch (e) {
        console.error('Error al importar PDF de Scribe:', e.message);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (err) {
                console.error('Error al limpiar archivo temporal:', err.message);
            }
        }
    }
});

// POST Save RPA Recipe
app.post('/api/admin/rpa/save', express.json(), async (req, res) => {
    try {
        const { id, name, platform, recipeJson, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!name || !platform || !recipeJson) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const { pool } = require('../database');
        if (id) {
            await pool.query(
                'UPDATE rpa_recipes SET name = ?, platform = ?, recipe_json = ? WHERE id = ?',
                [name, platform, JSON.stringify(recipeJson), id]
            );
            res.json({ success: true, message: 'Receta de automatización actualizada correctamente' });
        } else {
            await pool.query(
                'INSERT INTO rpa_recipes (name, platform, recipe_json) VALUES (?, ?, ?)',
                [name, platform, JSON.stringify(recipeJson)]
            );
            res.json({ success: true, message: 'Receta de automatización guardada correctamente' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET List RPA Recipes
app.get('/api/admin/rpa/list', async (req, res) => {
    try {
        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT * FROM rpa_recipes ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            name: r.name,
            platform: r.platform,
            recipeJson: typeof r.recipe_json === 'string' ? JSON.parse(r.recipe_json) : r.recipe_json,
            createdAt: r.created_at
        })));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE RPA Recipe
app.delete('/api/admin/rpa/delete/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password || req.body.password || 'admin123';
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        const { pool } = require('../database');
        await pool.query('DELETE FROM rpa_recipes WHERE id = ?', [id]);
        res.json({ success: true, message: 'Receta de automatización eliminada con éxito' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// In-memory queue for tracking asynchronous RPA executions

// POST: Run RPA Recipe Asynchronously (non-blocking)
app.post('/api/admin/rpa/run', express.json(), async (req, res) => {
    try {
        const { recipeId, variables, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!recipeId) return res.status(400).json({ success: false, message: 'Falta el ID de la receta' });

        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT * FROM rpa_recipes WHERE id = ?', [recipeId]);
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Receta no encontrada' });
        }

        const recipeObj = rows[0];
        const recipeJson = typeof recipeObj.recipe_json === 'string' ? JSON.parse(recipeObj.recipe_json) : recipeObj.recipe_json;

        // Query active provider credentials for this platform
        const rpaVariables = { ...(variables || {}) };
        try {
            const [providers] = await pool.query(
                'SELECT username, password FROM provider_credentials WHERE platform = ? ORDER BY created_at DESC LIMIT 1',
                [recipeObj.platform]
            );
            if (providers && providers.length > 0) {
                rpaVariables.PROVIDER_USER = providers[0].username;
                rpaVariables.PROVIDER_PASSWORD = providers[0].password;
            }
        } catch (dbErr) {
            console.error('[RPA] Error al consultar credenciales de proveedor:', dbErr.message);
        }

        const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        // Initial job state
        rpaJobs.set(jobId, {
            id: jobId,
            status: 'running',
            recipeName: recipeObj.name,
            email: variables?.CUSTOMER_EMAIL || 'N/A',
            screenshots: [],
            error: null,
            result: null,
            startedAt: new Date()
        });

        // Trigger execution asynchronously without await
        runRpaRecipe(recipeJson, rpaVariables, jobId)
            .then(result => {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.status = result.success ? 'success' : 'failed';
                    job.result = result.data;
                    job.screenshots = result.screenshots || [];
                    job.error = result.error || null;
                }
            })
            .catch(err => {
                const job = rpaJobs.get(jobId);
                if (job) {
                    job.status = 'failed';
                    job.error = err.message;
                    job.screenshots = err.screenshots || [];
                }
            });

        res.json({ success: true, jobId });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET: Check status of an RPA execution job
app.get('/api/admin/rpa/job-status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = rpaJobs.get(jobId);
        if (!job) {
            return res.status(404).json({ success: false, message: 'Tarea no encontrada' });
        }
        res.json({ success: true, job });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET: Check if a specific email has an active RPA recipe associated with it
app.get('/api/admin/rpa/check-recipe', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Falta el parámetro email' });
        }
        const { pool } = require('../database');
        const [rows] = await pool.query(
            'SELECT sa.rpa_recipe_id, r.name as recipe_name FROM stream_accounts sa JOIN rpa_recipes r ON r.id = sa.rpa_recipe_id WHERE sa.account_email = ? LIMIT 1',
            [email]
        );
        if (rows && rows.length > 0) {
            res.json({ success: true, hasRecipe: true, recipeId: rows[0].rpa_recipe_id, recipeName: rows[0].recipe_name });
        } else {
            res.json({ success: true, hasRecipe: false });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET List Provider Credentials
app.get('/api/admin/rpa/providers', async (req, res) => {
    try {
        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT * FROM provider_credentials ORDER BY created_at DESC');
        res.json(rows.map(r => ({
            id: r.id,
            platform: r.platform,
            providerName: r.provider_name,
            username: r.username,
            password: r.password,
            phone: r.phone || '',
            createdAt: r.created_at
        })));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Provider Credentials
app.post('/api/admin/rpa/providers/save', express.json(), async (req, res) => {
    try {
        const { id, platform, providerName, username, password, phone, adminPassword } = req.body;
        if (adminPassword !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!platform || !providerName || !username || !password) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios' });
        }

        const { pool } = require('../database');
        if (id) {
            await pool.query(
                'UPDATE provider_credentials SET platform = ?, provider_name = ?, username = ?, password = ?, phone = ? WHERE id = ?',
                [platform, providerName, username, password, phone, id]
            );
        } else {
            await pool.query(
                'INSERT INTO provider_credentials (platform, provider_name, username, password, phone) VALUES (?, ?, ?, ?, ?)',
                [platform, providerName, username, password, phone]
            );
        }
        res.json({ success: true, message: 'Credenciales de proveedor guardadas correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE Provider Credentials
app.delete('/api/admin/rpa/providers/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        const { pool } = require('../database');
        await pool.query('DELETE FROM provider_credentials WHERE id = ?', [id]);
        res.json({ success: true, message: 'Credenciales de proveedor eliminadas' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// GET Bot Status
app.get('/api/admin/bot/status', (req, res) => {
    res.json({
        success: true,
        isSleeping: ctx.getGlobalBotSleep(),
        isConnected: ctx.getCurrentWhatsappStatus() === 'CONNECTED',
        status: ctx.getCurrentWhatsappStatus()
    });
});

// POST Toggle Bot Sleep Mode
app.post('/api/admin/bot/toggle-sleep', express.json(), (req, res) => {
    if (typeof req.body?.sleep === 'boolean') {
        ctx.setGlobalBotSleep(req.body.sleep);
    } else {
        ctx.setGlobalBotSleep(!ctx.getGlobalBotSleep());
    }
    console.log(`[Admin Control] Bot sleep mode cambiado a: ${ctx.getGlobalBotSleep() ? '😴 DORMIDO' : '🟢 ACTIVO'}`);
    res.json({
        success: true,
        isSleeping: ctx.getGlobalBotSleep(),
        message: ctx.getGlobalBotSleep() ? 'Bot dormido (solo web admin activa)' : 'Bot despierto (atendiendo clientes)'
    });
});
}

module.exports = {
    registerAdminAgentsAndPayrollRoutes,
    runRpaRecipe
};
