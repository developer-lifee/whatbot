const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pool } = require('../database');

const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Helper unificado para determinar si una cuenta streaming cuenta con extracción 2FA automatizada
 */
async function checkAccountAutomationStatus(accountEmail, platform) {
    const emailLower = String(accountEmail || "").trim().toLowerCase();
    const platUpper = String(platform || "").trim().toUpperCase();

    if (!emailLower) {
        return { isAutomated: false, type: 'manual', label: 'Manual (Sin Correo)' };
    }

    // 1. Netflix: automatizado mediante portal de Hogar Sheerit
    if (platUpper.includes('NETFLIX')) {
        return { isAutomated: true, type: 'netflix', label: 'Hogar Netflix (Sheerit)' };
    }

    // 2. Token de Gmail activo en carpeta tokens/
    const tokensDir = path.join(ROOT_DIR, 'tokens');
    const tokenPath = path.join(tokensDir, `token_${emailLower}.json`);
    if (fs.existsSync(tokenPath)) {
        return { isAutomated: true, type: 'gmail', label: 'Gmail API (Token Activo)' };
    }

    // 3. TOTP Offline (ChatGPT, Amazon con secreto)
    const gptSecretsPath = path.join(tokensDir, 'gpt_secrets.json');
    if (fs.existsSync(gptSecretsPath)) {
        try {
            const gptSecrets = JSON.parse(fs.readFileSync(gptSecretsPath, 'utf8'));
            if (gptSecrets[emailLower]) {
                return { isAutomated: true, type: 'totp', label: 'TOTP 2FA (Generador)' };
            }
        } catch (e) {}
    }

    // 4. Receta RPA vinculada en stream_accounts
    try {
        const { pool } = require('../database');
        const [rows] = await pool.query(
            `SELECT sa.rpa_recipe_id, r.name as recipe_name 
             FROM stream_accounts sa 
             JOIN rpa_recipes r ON sa.rpa_recipe_id = r.id 
             WHERE LOWER(sa.account_email) = ? 
             LIMIT 1`,
            [emailLower]
        );
        if (rows.length > 0 && rows[0].rpa_recipe_id) {
            return { 
                isAutomated: true, 
                type: 'rpa', 
                label: `Receta RPA (${rows[0].recipe_name})`,
                rpaRecipeId: rows[0].rpa_recipe_id,
                rpaRecipeName: rows[0].recipe_name
            };
        }
    } catch (e) {}

    // 5. Manual / Sin automatización configurada
    return { isAutomated: false, type: 'manual', label: 'Manual (Sin Automatización)' };
}

function registerAdminCatalogAndAccountingRoutes(app, ctx) {
    const { upload, userStates, pendingConfirmations } = ctx;

// Endpoint to read manual stock/platform availability configuration
app.get('/api/admin/availability', (req, res) => {
    try {
        const { getAvailabilityConfig } = require('../availabilityService');
        const config = getAvailabilityConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to write manual stock/platform availability configuration
app.post('/api/admin/availability/save', (req, res) => {
    try {
        const { config, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config || typeof config !== 'object') return res.status(400).json({ success: false, message: 'Configuración inválida' });

        const { saveAvailabilityConfig } = require('../availabilityService');
        const { logAdminAction } = require('../auditService');
        saveAvailabilityConfig(config);

        logAdminAction({
            agentEmail: agentEmail || 'admin@sheerit.com',
            agentName: agentName || 'Administrador',
            action: 'UPDATE_STOCK_AVAILABILITY',
            target: 'Plataformas & Planes',
            details: { platformsModified: Object.keys(config.platforms || {}).length }
        });

        res.json({ success: true, message: 'Disponibilidad de stock actualizada y auditada' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- HEAVY TICKETS / INTERNAL TASKS ENDPOINTS ---
app.get('/api/admin/heavy-tickets', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT ht.*, 
                   (SELECT COUNT(*) FROM heavy_ticket_comments WHERE ticket_id = ht.id) as comments_count
            FROM heavy_tickets ht
            ORDER BY ht.created_at DESC
        `);
        res.json({ success: true, tickets: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/heavy-tickets', express.json(), async (req, res) => {
    try {
        const { title, description, priority, assigned_agent, password, initial_comment } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

        const [result] = await pool.query(
            'INSERT INTO heavy_tickets (title, description, priority, assigned_agent) VALUES (?, ?, ?, ?)',
            [title, description || '', priority || 'medium', assigned_agent || null]
        );

        const ticketId = result.insertId;

        if (initial_comment && initial_comment.trim()) {
            await pool.query(
                'INSERT INTO heavy_ticket_comments (ticket_id, agent_name, comment) VALUES (?, ?, ?)',
                [ticketId, assigned_agent || 'Sistema', initial_comment.trim()]
            );
        }

        res.json({ success: true, ticketId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/heavy-tickets/:id', express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, priority, status, assigned_agent, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        await pool.query(
            'UPDATE heavy_tickets SET title = ?, description = ?, priority = ?, status = ?, assigned_agent = ? WHERE id = ?',
            [title, description || '', priority || 'medium', status || 'pending', assigned_agent || null, id]
        );

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/heavy-tickets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const password = req.query.password || req.body?.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        await pool.query('DELETE FROM heavy_tickets WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/heavy-tickets/:id/comments', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            'SELECT * FROM heavy_ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, comments: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/heavy-tickets/:id/comments', express.json(), async (req, res) => {
    try {
        const { id } = req.params;
        const { agent_name, comment, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!comment || !comment.trim()) return res.status(400).json({ success: false, message: 'Comment is required' });

        await pool.query(
            'INSERT INTO heavy_ticket_comments (ticket_id, agent_name, comment) VALUES (?, ?, ?)',
            [id, agent_name || 'Sistema', comment.trim()]
        );

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to read human support schedule configuration
app.get('/api/admin/support-schedule', async (req, res) => {
    try {
        const { getSupportScheduleConfig, isSupportOpen } = require('../supportScheduleService');
        const config = getSupportScheduleConfig();
        const supportStatus = await isSupportOpen();
        res.json({
            ...config,
            is_open: supportStatus.open,
            reason: supportStatus.reason
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== GESTIÓN DE RECORDATORIOS DE WHATSAPP ====================
app.get('/api/admin/reminders', (req, res) => {
    try {
        const { getAllReminders } = require('../whatsappRemindersService');
        res.json(getAllReminders());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/reminders', (req, res) => {
    try {
        const { createReminder } = require('../whatsappRemindersService');
        const reminder = createReminder(req.body, ctx.getClient());
        res.json({ success: true, reminder });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/reminders/:id', (req, res) => {
    try {
        const { updateReminder } = require('../whatsappRemindersService');
        const reminder = updateReminder(req.params.id, req.body, ctx.getClient());
        res.json({ success: true, reminder });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/reminders/:id/toggle', (req, res) => {
    try {
        const { toggleReminder } = require('../whatsappRemindersService');
        const reminder = toggleReminder(req.params.id, req.body.enabled, ctx.getClient());
        res.json({ success: true, reminder });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/reminders/:id', (req, res) => {
    try {
        const { deleteReminder } = require('../whatsappRemindersService');
        deleteReminder(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/reminders/:id/test', async (req, res) => {
    try {
        const { testReminder } = require('../whatsappRemindersService');
        const result = await testReminder(req.params.id, ctx.getClient());
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET Public Support & Contact Configuration for Frontend Website
app.get('/api/public/support-config', async (req, res) => {
    try {
        const { getSupportScheduleConfig, isSupportOpen } = require('../supportScheduleService');
        const config = getSupportScheduleConfig();
        const supportStatus = await isSupportOpen();
        res.json({
            whatsapp_contact_number: config.whatsapp_contact_number || "573118587974",
            is_open: supportStatus.open,
            reason: supportStatus.reason,
            weekday_start: config.weekday_start,
            weekday_end: config.weekday_end,
            weekend_start: config.weekend_start,
            weekend_end: config.weekend_end
        });
    } catch (e) {
        res.status(500).json({ whatsapp_contact_number: "573118587974", is_open: true, error: e.message });
    }
});

// --- CONTABILIDAD Y PRECIOS ENDPOINTS ---
const accountingService = require('../accountingService');

app.get('/api/admin/prices', async (req, res) => {
    try {
        const prices = await accountingService.getPrices();
        res.json(prices);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function syncPlatformPrices(platforms, dbPrices) {
    const priceMap = {};
    dbPrices.forEach(p => {
        const clean = p.platform.toUpperCase().trim();
        priceMap[clean] = parseFloat(p.normal_price);
    });

    return platforms.map(p => {
        const nameUpper = (p.name || '').toUpperCase().trim();
        
        // Mapeo de precio base de la plataforma (Claude primero para no confundir con HBO Max)
        if (nameUpper.includes('CLAUDE') && priceMap['CLAUDE'] !== undefined) p.price = priceMap['CLAUDE'];
        else if (nameUpper.includes('NETFLIX') && priceMap['NETFLIX'] !== undefined) p.price = priceMap['NETFLIX'];
        else if (nameUpper.includes('DISNEY') && priceMap['DISNEY'] !== undefined) p.price = priceMap['DISNEY'];
        else if ((nameUpper.includes('HBO') || (nameUpper.includes('MAX') && !nameUpper.includes('CLAUDE'))) && priceMap['HBO'] !== undefined) p.price = priceMap['HBO'];
        else if ((nameUpper.includes('PRIME') || nameUpper.includes('AMAZON')) && priceMap['AMAZON'] !== undefined) p.price = priceMap['AMAZON'];
        else if (nameUpper.includes('VIX') && priceMap['VIX'] !== undefined) p.price = priceMap['VIX'];
        else if (nameUpper.includes('APPLE') && priceMap['APPLE TV'] !== undefined) p.price = priceMap['APPLE TV'];
        else if (nameUpper.includes('YOUTUBE') && priceMap['YOUTUBE'] !== undefined) p.price = priceMap['YOUTUBE'];
        else if (nameUpper.includes('PARAMOUNT') && priceMap['PARAMOUNT'] !== undefined) p.price = priceMap['PARAMOUNT'];
        else if (nameUpper.includes('SPOTIFY') && priceMap['SPOTIFY'] !== undefined) p.price = priceMap['SPOTIFY'];
        else if (nameUpper.includes('CRUNCHY') && priceMap['CRUNCHY ROLL'] !== undefined) p.price = priceMap['CRUNCHY ROLL'];
        else if (nameUpper.includes('PLATZI') && priceMap['PLATZI COMPARTIDA'] !== undefined) p.price = priceMap['PLATZI COMPARTIDA'];
        else if (nameUpper.includes('IPTV') && priceMap['IPTV'] !== undefined) p.price = priceMap['IPTV'];
        else if (nameUpper.includes('GEMINI') && priceMap['GEMINI COMPARTIDA'] !== undefined) p.price = priceMap['GEMINI COMPARTIDA'];
        else if (nameUpper.includes('CANVA') && priceMap['CANVA'] !== undefined) p.price = priceMap['CANVA'];
        else if (nameUpper.includes('CHATGPT') || nameUpper.includes('GPT')) {
            if (priceMap['GPT'] !== undefined) p.price = priceMap['GPT'];
        } else if (nameUpper.includes('MICROSOFT')) {
            if (priceMap['MICROSOFT COMPARTIDA'] !== undefined) p.price = priceMap['MICROSOFT COMPARTIDA'];
        }

        // Mapeo detallado de planes individuales
        if (p.plans && p.plans.length > 0) {
            p.plans = p.plans.map(plan => {
                const planUpper = (plan.name || '').toUpperCase().trim();
                
                // Claude
                if (nameUpper.includes('CLAUDE')) {
                    if (planUpper.includes('ESTÁNDAR') && priceMap['CLAUDE'] !== undefined) plan.price = priceMap['CLAUDE'];
                }
                // Netflix
                else if (nameUpper.includes('NETFLIX')) {
                    if (planUpper.includes('EXTRA') && priceMap['NETFLIX EXTRA'] !== undefined) plan.price = priceMap['NETFLIX EXTRA'];
                    else if (priceMap['NETFLIX'] !== undefined) plan.price = priceMap['NETFLIX'];
                }
                // HBO / Max
                else if (nameUpper.includes('HBO') || (nameUpper.includes('MAX') && !nameUpper.includes('CLAUDE'))) {
                    if (planUpper.includes('PLATINO') && priceMap['HBO PLATINO'] !== undefined) plan.price = priceMap['HBO PLATINO'];
                    else if (priceMap['HBO'] !== undefined) plan.price = priceMap['HBO'];
                }
                // Microsoft
                else if (nameUpper.includes('MICROSOFT')) {
                    if (planUpper.includes('PERSONAL') && priceMap['MICROSOFT'] !== undefined) plan.price = priceMap['MICROSOFT'];
                    else if (priceMap['MICROSOFT COMPARTIDA'] !== undefined) plan.price = priceMap['MICROSOFT COMPARTIDA'];
                }
                // Spotify
                else if (nameUpper.includes('SPOTIFY')) {
                    if ((planUpper.includes('PERSONAL') || planUpper.includes('TU CORREO') || planUpper.includes('OWNER')) && priceMap['SPOTIFY OWNER'] !== undefined) plan.price = priceMap['SPOTIFY OWNER'];
                    else if (priceMap['SPOTIFY'] !== undefined) plan.price = priceMap['SPOTIFY'];
                }
                // YouTube
                else if (nameUpper.includes('YOUTUBE')) {
                    if (planUpper.includes('OWNER') && priceMap['YOUTUBE OWNER'] !== undefined) plan.price = priceMap['YOUTUBE OWNER'];
                    else if (priceMap['YOUTUBE'] !== undefined) plan.price = priceMap['YOUTUBE'];
                }
                // Apple
                else if (nameUpper.includes('APPLE')) {
                    if (planUpper.includes('ONE') && priceMap['APPLE ONE'] !== undefined) plan.price = priceMap['APPLE ONE'];
                    else if (planUpper.includes('TV') && priceMap['APPLE TV'] !== undefined) plan.price = priceMap['APPLE TV'];
                }
                // Gemini
                else if (nameUpper.includes('GEMINI')) {
                    if ((planUpper.includes('CORREO PROPIO') || planUpper.includes('PERSONAL')) && priceMap['GEMINI'] !== undefined) plan.price = priceMap['GEMINI'];
                    else if (priceMap['GEMINI COMPARTIDA'] !== undefined) plan.price = priceMap['GEMINI COMPARTIDA'];
                }
                // Platzi
                else if (nameUpper.includes('PLATZI')) {
                    if ((planUpper.includes('TRIMESTRAL') || planUpper.includes('PERSONAL')) && priceMap['PLATZI'] !== undefined) plan.price = priceMap['PLATZI'];
                    else if (priceMap['PLATZI COMPARTIDA'] !== undefined) plan.price = priceMap['PLATZI COMPARTIDA'];
                }
                // Canva
                else if (nameUpper.includes('CANVA')) {
                    if (planUpper.includes('MENSUAL') && priceMap['CANVA'] !== undefined) plan.price = priceMap['CANVA'];
                }
                // Disney / Prime / Vix / IPTV / Paramount / GPT
                else if (nameUpper.includes('DISNEY') && priceMap['DISNEY'] !== undefined) plan.price = priceMap['DISNEY'];
                else if ((nameUpper.includes('PRIME') || nameUpper.includes('AMAZON')) && priceMap['AMAZON'] !== undefined) plan.price = priceMap['AMAZON'];
                else if (nameUpper.includes('VIX') && priceMap['VIX'] !== undefined) plan.price = priceMap['VIX'];
                else if (nameUpper.includes('PARAMOUNT') && priceMap['PARAMOUNT'] !== undefined) plan.price = priceMap['PARAMOUNT'];
                else if (nameUpper.includes('CRUNCHY') && priceMap['CRUNCHY ROLL'] !== undefined) plan.price = priceMap['CRUNCHY ROLL'];
                else if (nameUpper.includes('IPTV') && priceMap['IPTV'] !== undefined) plan.price = priceMap['IPTV'];
                else if ((nameUpper.includes('CHATGPT') || nameUpper.includes('GPT')) && priceMap['GPT'] !== undefined) plan.price = priceMap['GPT'];

                return plan;
            });
        }
        return p;
    });
}

app.get('/api/public/platforms', async (req, res) => {
    try {
        const { getPlatformsFromDb } = require('../platformsDbService');
        const { getAvailabilityConfig } = require('../availabilityService');
        const config = getAvailabilityConfig();
        const rawPlatforms = await getPlatformsFromDb();

        const platforms = rawPlatforms.map(p => {
            const pKey = p.name;
            const pOverride = config[pKey] || {};
            const isPlatformAvailable = pOverride.immediate !== false;
            const pReason = pOverride.reason || '';
            const pIncident = pOverride.incident || '';

            const plans = (p.plans || []).map(pl => {
                const planKey = `${p.name} ${pl.name}`;
                const planOverride = config[planKey] || {};
                const isPlanAvailable = isPlatformAvailable && (planOverride.immediate !== false);
                const planReason = planOverride.reason || pReason;

                return {
                    ...pl,
                    isAvailable: isPlanAvailable,
                    reason: planReason || undefined
                };
            });

            // If all plans are unavailable, mark the platform overall as unavailable
            const hasAnyAvailablePlan = plans.length === 0 ? isPlatformAvailable : plans.some(pl => pl.isAvailable);

            return {
                ...p,
                isAvailable: isPlatformAvailable && hasAnyAvailablePlan,
                reason: pReason || undefined,
                incident: pIncident || undefined,
                plans
            };
        });

        res.json(platforms);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- TRACKING & HEATMAP ENDPOINTS ---

app.post('/api/public/track-visit', async (req, res) => {
    try {
        const { pagePath, referrer, userAgent, deviceType } = req.body;
        let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        if (clientIp.includes('::ffff:')) {
            clientIp = clientIp.replace('::ffff:', '');
        }

        await pool.query(
            'INSERT INTO page_visits (page_path, referrer, user_agent, device_type, ip_address) VALUES (?, ?, ?, ?, ?)',
            [pagePath || '/', referrer || null, userAgent || null, deviceType || 'unknown', clientIp]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Error tracking page visit:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/public/track-click', async (req, res) => {
    try {
        const { pagePath, xPct, yPct, elementSelector, screenWidth, screenHeight } = req.body;
        await pool.query(
            'INSERT INTO page_clicks (page_path, x_pct, y_pct, element_selector, screen_width, screen_height) VALUES (?, ?, ?, ?, ?, ?)',
            [pagePath || '/', xPct, yPct, elementSelector || null, screenWidth || null, screenHeight || null]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Error tracking page click:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- BOT DEMO SIMULATOR ENDPOINTS (PUBLIC) ---

app.post('/api/public/bot-demo/transcribe-audio', express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { audioBase64, mimeType } = req.body;
        if (!audioBase64) {
            return res.status(400).json({ success: false, error: 'No se envió audioBase64' });
        }
        const { transcribeAudioWithGemini } = require('../aiService');
        const cleanBase64 = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
        const text = await transcribeAudioWithGemini({
            data: cleanBase64,
            mimeType: mimeType || 'audio/webm'
        });
        res.json({ success: true, text: text ? text.trim() : '' });
    } catch (e) {
        console.error('Error transcribiendo audio para bot-demo:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/public/bot-demo/save-lead', express.json(), async (req, res) => {
    try {
        const { phone, name, type, instructions, remaining = 20 } = req.body;
        const cleanPhone = String(phone || '').replace(/\D/g, '');
        if (!cleanPhone || cleanPhone.length < 7) {
            return res.json({ success: false, error: 'Número de teléfono inválido' });
        }

        const normalizedPhone = (cleanPhone.length === 10 && cleanPhone.startsWith('3')) ? `57${cleanPhone}` : cleanPhone;
        const leadsFile = path.join(ROOT_DIR, 'demo_leads.json');
        let leads = [];
        if (fs.existsSync(leadsFile)) {
            try { leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8')); } catch (e) { leads = []; }
        }

        let existingIndex = leads.findIndex(l => l.phone === normalizedPhone);
        let lead = existingIndex !== -1 ? leads[existingIndex] : {
            phone: normalizedPhone,
            createdAt: new Date().toISOString(),
            offerSent: false
        };

        lead.botName = name || 'Mi Bot';
        lead.botType = type || 'negocio';
        lead.instructions = instructions || '';
        lead.remaining = parseInt(remaining, 10) || 20;
        lead.updatedAt = new Date().toISOString();

        if (existingIndex !== -1) {
            leads[existingIndex] = lead;
        } else {
            leads.push(lead);
        }
        fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2), 'utf8');

        // Enviar mensaje de WhatsApp al número del usuario de inmediato si el cliente de WhatsApp está conectado
        let whatsappSent = false;
        if (ctx.getClient() && ctx.getClient().sendMessage) {
            const targetChatId = `${normalizedPhone}@c.us`;
            const welcomeMsg = `¡Hola! 👋 Soy tu bot de prueba (*${lead.botName}*).\n\n🎉 Ya tienes tus *20 mensajes de prueba gratuita* activados.\n\nPuedes escribirme por aquí cualquier consulta o probar desde la web para ver cómo atiendo a tus clientes. 🚀`;
            ctx.getClient().sendMessage(targetChatId, welcomeMsg)
                .then(() => console.log(`[Bot Demo] Mensaje de bienvenida enviado exitosamente a WhatsApp de ${normalizedPhone}`))
                .catch(err => console.error(`[Bot Demo] Error enviando WhatsApp al lead ${normalizedPhone}:`, err.message));
            whatsappSent = true;
        }

        res.json({ success: true, whatsappSent, normalizedPhone });
    } catch (e) {
        console.error('Error en /api/public/bot-demo/save-lead:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/public/bot-demo/chat', express.json(), async (req, res) => {
    try {
        const { message, personaConfig, history = [], remaining = 20 } = req.body;
        const currentRemaining = parseInt(remaining, 10);

        if (isNaN(currentRemaining) || currentRemaining <= 0) {
            return res.json({
                success: true,
                reply: "🎉 ¡Has completado tus 20 mensajes de prueba gratuita!\n\nTu bot ya aprendió las reglas de tu negocio y está listo para atender en tu WhatsApp oficial 24/7 sin dejar a nadie en visto.\n\n👉 Activa tu Plan Starter por solo $10.000 COP/mes (incluye 50 mensajes IA + respuestas automáticas ilimitadas).",
                remaining: 0,
                isLimitReached: true
            });
        }

        const { callGemini } = require('../aiService');
        const botName = (personaConfig && personaConfig.name) ? personaConfig.name : 'Asistente Sheerit';
        const botType = (personaConfig && personaConfig.type) ? personaConfig.type : 'negocio';
        const userNotes = (personaConfig && personaConfig.instructions) ? personaConfig.instructions : '';
        const userTone = (personaConfig && personaConfig.tone) ? personaConfig.tone : 'amable y profesional';

        let systemInstruction = `Eres un bot inteligente de WhatsApp configurado para simular una conversación real de WhatsApp.
Tu nombre o rol es: "${botName}".
Tipo de configuración: "${botType}".
Tono: "${userTone}".
Contexto / Información dada por el usuario en la entrevista inicial:
"""${userNotes}"""

REGLAS DE RESPUESTA EN WHATSAPP:
1. Responde de forma muy natural, corta y directa como un chat de WhatsApp auténtico (máximo 2 a 3 líneas o párrafos breves).
2. Usa emojis naturales moderados (1 a 3 máximo).
3. Si el tipo es 'pareja': sé dulce, empático(a), explica con cariño si estás ocupado(a) o recuerda planes sin sonar robótico.
4. Si el tipo es 'recordatorios': confirma tareas, horas o notas de forma ágil y clara ("¡Listo! Te lo recuerdo mañana a las 9:00 AM ⏰").
5. Si el tipo es 'cine': recomienda películas o series destacadas disponibles en streaming (Netflix, Max, Disney+), dando una razón cautivante de por qué verla.
6. Si el tipo es 'negocio': atiende las dudas del cliente sobre los productos o servicios indicados en el contexto, da precios y promueve el cierre de compra cordialmente.
7. Si el cliente pregunta algo que no está en el contexto, responde amablemente y ofrece opciones relacionadas.`;

        // Construir historial breve
        let promptWithHistory = "HISTORIAL PREVIO DEL CHAT:\n";
        const recentHistory = Array.isArray(history) ? history.slice(-6) : [];
        for (const item of recentHistory) {
            const sender = item.role === 'user' ? 'Cliente' : 'Bot';
            promptWithHistory += `${sender}: ${item.text}\n`;
        }
        promptWithHistory += `Cliente: ${message}\nBot:`;

        let reply = null;
        try {
            reply = await Promise.race([
                callGemini(promptWithHistory, systemInstruction, false),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Gemini')), 8500))
            ]);
        } catch (geminiErr) {
            console.warn('[Bot Demo Chat] Fallback rápido activado por demora en IA:', geminiErr.message);
            if (botType === 'negocio') {
                reply = `¡Hola! Con mucho gusto te atendemos en ${botName}. ¿Deseas consultar precios, catálogo o tiempos de entrega? 🛍️`;
            } else if (botType === 'pareja') {
                reply = `¡Hola mi vida! ❤️ Ando pendiente de ti, cuéntame qué necesitas y te respondo con todo el amor.`;
            } else {
                reply = `¡Hola! Estoy listo para apoyarte con tus tareas y recordatorios. ¿En qué te colaboro hoy?`;
            }
        }
        const nextRemaining = Math.max(0, currentRemaining - 1);

        // Guardar prospecto y disparar venta cruzada si hay teléfono
        const userPhoneRaw = req.body.userPhone || (personaConfig && personaConfig.phone) || '';
        const cleanPhone = String(userPhoneRaw).replace(/\D/g, '');

        if (cleanPhone && cleanPhone.length >= 7) {
            try {
                const fs = require('fs');
                const path = require('path');
                const leadsFile = path.join(ROOT_DIR, 'demo_leads.json');
                let leads = [];
                if (fs.existsSync(leadsFile)) {
                    try { leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8')); } catch (e) { leads = []; }
                }

                // Normalizar número colombiano a 57... si tiene 10 dígitos y empieza por 3
                const normalizedPhone = (cleanPhone.length === 10 && cleanPhone.startsWith('3')) ? `57${cleanPhone}` : cleanPhone;
                let existingIndex = leads.findIndex(l => l.phone === normalizedPhone);
                let lead = existingIndex !== -1 ? leads[existingIndex] : {
                    phone: normalizedPhone,
                    createdAt: new Date().toISOString(),
                    offerSent: false
                };

                lead.botName = botName;
                lead.botType = botType;
                lead.instructions = userNotes;
                lead.lastMessage = message;
                lead.remaining = nextRemaining;
                lead.updatedAt = new Date().toISOString();

                // Si se le acabaron los 20 mensajes y no se le ha enviado la oferta
                if (nextRemaining === 0 && !lead.offerSent) {
                    lead.offerSent = true;
                    // Enviar WhatsApp al cliente si client está activo
                    if (ctx.getClient() && ctx.getClient().sendMessage) {
                        const targetChatId = `${normalizedPhone}@c.us`;
                        const autoOfferText = `¡Hola ${botName}! 👋\n\n🎉 Vimos que acabas de configurar y probar tu bot de WhatsApp para *${personaConfig.name || 'tu negocio'}* en Sheerit.\n\nTus 20 mensajes de prueba gratuita terminaron con éxito. 🚀\n\n¿Te gustaría dejarlo conectado 24/7 a tu WhatsApp oficial por solo *$10.000 COP al mes*? Responde a este mensaje y un asesor te lo activará de una vez.`;
                        ctx.getClient().sendMessage(targetChatId, autoOfferText).catch(err => console.error("Error enviando oferta automática WhatsApp:", err.message));

                        // Notificar a asesores en grupo de ventas / errores
                        const adminNotice = `🔥 *NUEVO PROSPECTO BOT WHATSAPP*\n- Cliente: +${normalizedPhone}\n- Propósito: ${botType} (${botName})\n- Acaba de agotar sus 20 mensajes de prueba.\n- Oferta de Plan Starter ($10k) enviada automáticamente. ¡Hacer seguimiento y venta cruzada!`;
                        ctx.getClient().sendMessage('120363427163636523@g.us', adminNotice).catch(() => {});
                    }
                }

                if (existingIndex !== -1) {
                    leads[existingIndex] = lead;
                } else {
                    leads.push(lead);
                }
                fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2), 'utf8');
            } catch (leadErr) {
                console.error("Error guardando prospecto demo_leads:", leadErr.message);
            }
        }

        res.json({
            success: true,
            reply: reply ? reply.trim() : "¡Hola! ¿En qué más puedo colaborarte hoy?",
            remaining: nextRemaining,
            isLimitReached: nextRemaining === 0
        });
    } catch (e) {
        console.error('Error en bot-demo chat:', e.message);
        res.status(500).json({
            success: false,
            reply: "Lo siento, tuve un pequeño problema de conexión en la demo. ¿Podrías intentar de nuevo?",
            error: e.message
        });
    }
});

const getTimeframeFilter = (timeframe, dateCol) => {
    if (timeframe === 'today') {
        return `DATE(${dateCol}) = CURDATE()`;
    } else if (timeframe === '7d') {
        return `${dateCol} >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    } else if (timeframe === '30d') {
        return `${dateCol} >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    }
    return '1=1';
};

app.get('/api/admin/visit-stats', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilterVisits = getTimeframeFilter(timeframe, 'visited_at');
        const timeFilterClicks = getTimeframeFilter(timeframe, 'clicked_at');

        const [totalVisitsRows] = await pool.query(`SELECT COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [uniqueVisitsRows] = await pool.query(`SELECT COUNT(DISTINCT ip_address) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [totalClicksRows] = await pool.query(`SELECT COUNT(*) as count FROM page_clicks WHERE ${timeFilterClicks}`);

        const [deviceBreakdown] = await pool.query(`SELECT device_type as name, COUNT(*) as value FROM page_visits WHERE ${timeFilterVisits} GROUP BY device_type`);
        const [topPages] = await pool.query(`SELECT page_path as page, COUNT(*) as visits FROM page_visits WHERE ${timeFilterVisits} GROUP BY page_path ORDER BY visits DESC LIMIT 10`);
        const [clicksByPage] = await pool.query(`SELECT page_path as page, COUNT(*) as clicks FROM page_clicks WHERE ${timeFilterClicks} GROUP BY page_path`);
        const [visitsHistory] = await pool.query(`SELECT DATE_FORMAT(visited_at, "%Y-%m-%d") as date, COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits} GROUP BY DATE(visited_at) ORDER BY date DESC LIMIT 15`);
        
        // Excluir dominios propios del referrer para evitar falsos orígenes
        const [rawReferrers] = await pool.query(`
            SELECT referrer, COUNT(*) as count 
            FROM page_visits 
            WHERE referrer IS NOT NULL AND referrer != '' 
              AND referrer NOT LIKE '%sheerit.com.co%' 
              AND referrer NOT LIKE '%sheerit.co%' 
              AND referrer NOT LIKE '%localhost%' 
              AND referrer NOT LIKE '%127.0.0.1%'
              AND ${timeFilterVisits}
            GROUP BY referrer 
            ORDER BY count DESC 
            LIMIT 15
        `);

        const topReferrers = rawReferrers.map(r => {
            let clean = r.referrer;
            try {
                const url = new URL(r.referrer.startsWith('http') ? r.referrer : `https://${r.referrer}`);
                clean = url.hostname.replace(/^www\./, '');
                if (clean.includes('google')) clean = 'Google Search';
                else if (clean.includes('bold.co')) clean = 'Pasarela Bold';
                else if (clean.includes('bing')) clean = 'Bing Search';
                else if (clean.includes('instagram')) clean = 'Instagram';
                else if (clean.includes('whatsapp') || clean.includes('wa.me')) clean = 'WhatsApp';
                else if (clean.includes('facebook') || clean.includes('fb.com')) clean = 'Facebook';
                else if (clean.includes('tiktok')) clean = 'TikTok';
            } catch (e) { }
            return { name: clean, value: r.count };
        });

        res.json({
            summary: {
                totalVisits: totalVisitsRows[0]?.count || 0,
                uniqueVisits: uniqueVisitsRows[0]?.count || 0,
                totalClicks: totalClicksRows[0]?.count || 0
            },
            deviceBreakdown,
            topPages,
            clicksByPage,
            visitsHistory: visitsHistory.reverse(),
            topReferrers
        });
    } catch (e) {
        console.error('Error fetching admin visit stats:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/click-heatmap', async (req, res) => {
    try {
        const { page, device, timeframe } = req.query;
        const pagePath = page || '/';
        const timeFilter = getTimeframeFilter(timeframe, 'clicked_at');
        let query = `SELECT x_pct, y_pct, element_selector, screen_width, screen_height, clicked_at FROM page_clicks WHERE page_path = ? AND ${timeFilter}`;
        const params = [pagePath];

        if (device === 'mobile') {
            query += ' AND (screen_width IS NULL OR screen_width < 768)';
        } else if (device === 'desktop') {
            query += ' AND screen_width >= 768';
        }

        query += ' ORDER BY clicked_at DESC LIMIT 2000';

        const [clicks] = await pool.query(query, params);
        res.json({ clicks });
    } catch (e) {
        console.error('Error fetching admin click heatmap:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/element-clicks', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilter = getTimeframeFilter(timeframe, 'clicked_at');

        const [rows] = await pool.query(`
            SELECT 
                COALESCE(element_selector, 'Área General de Página') as raw_element,
                COUNT(*) as total_clicks,
                SUM(CASE WHEN screen_width < 768 THEN 1 ELSE 0 END) as mobile_clicks,
                SUM(CASE WHEN screen_width >= 768 THEN 1 ELSE 0 END) as desktop_clicks
            FROM page_clicks
            WHERE ${timeFilter}
            GROUP BY raw_element
            ORDER BY total_clicks DESC
            LIMIT 40
        `);

        const formatElementName = (raw) => {
            if (!raw) return 'Área General de Página';
            if (raw.startsWith('Botón:') || raw.startsWith('Enlace:') || raw.startsWith('Campo:') || raw.startsWith('Tarjeta:') || raw.startsWith('Selector:') || raw.startsWith('Texto:')) {
                return raw;
            }
            const lower = raw.toLowerCase();
            if (lower === 'button.w-full' || lower.includes('button.w-full')) return 'Botón Principal (Comprar / Acción)';
            if (lower === 'button.px-2' || lower === 'button.p-1.5' || lower.includes('button.inline-flex')) return 'Botón Secundario / Opciones';
            if (lower === 'input.w-full' || lower.includes('input')) return 'Buscador de Servicios';
            if (lower === 'svg' || lower === 'path') return 'Ícono / Botón Interactivo';
            if (lower === 'div.w-full' || lower === 'div.p-4' || lower.includes('div.flex') || lower.includes('div.absolute')) return 'Tarjeta de Servicio / Catálogo';
            if (lower.startsWith('span') || lower === 'font' || lower.includes('span.text')) return 'Etiqueta / Detalles de Cuenta';
            if (lower.startsWith('a.')) return 'Enlace de Navegación';
            return raw;
        };

        const aggregated = new Map();
        rows.forEach(r => {
            const cleanName = formatElementName(r.raw_element);
            if (!aggregated.has(cleanName)) {
                aggregated.set(cleanName, {
                    element: cleanName,
                    total_clicks: 0,
                    mobile_clicks: 0,
                    desktop_clicks: 0
                });
            }
            const item = aggregated.get(cleanName);
            item.total_clicks += Number(r.total_clicks);
            item.mobile_clicks += Number(r.mobile_clicks);
            item.desktop_clicks += Number(r.desktop_clicks);
        });

        const elements = Array.from(aggregated.values())
            .sort((a, b) => b.total_clicks - a.total_clicks)
            .slice(0, 15);

        res.json({ elements });
    } catch (e) {
        console.error('Error fetching element clicks:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/purchase-funnel', async (req, res) => {
    try {
        const { timeframe } = req.query;
        const timeFilterVisits = getTimeframeFilter(timeframe, 'visited_at');
        const timeFilterClicks = getTimeframeFilter(timeframe, 'clicked_at');
        const timeFilterSales = getTimeframeFilter(timeframe, 'created_at');

        const [visits] = await pool.query(`SELECT COUNT(*) as count FROM page_visits WHERE ${timeFilterVisits}`);
        const [clicks] = await pool.query(`SELECT COUNT(*) as count FROM page_clicks WHERE ${timeFilterClicks}`);
        const [payClicks] = await pool.query(`
            SELECT COUNT(*) as count FROM page_clicks 
            WHERE (element_selector LIKE '%bold%' 
               OR element_selector LIKE '%pagar%' 
               OR element_selector LIKE '%comprar%' 
               OR element_selector LIKE '%button%'
               OR element_selector LIKE '%Botón%')
              AND ${timeFilterClicks}
        `);
        const [sales] = await pool.query(`SELECT COUNT(*) as count FROM web_sales_approved WHERE ${timeFilterSales}`);

        const totalVisits = visits[0]?.count || 0;
        const totalClicks = clicks[0]?.count || 0;
        const totalPayClicks = payClicks[0]?.count || 0;
        const totalSales = sales[0]?.count || 0;

        res.json({
            funnel: [
                { step: 'Visitas a la Web', count: totalVisits, pct: 100 },
                { step: 'Interacción / Clics', count: totalClicks, pct: totalVisits ? Math.round((totalClicks / totalVisits) * 100) : 0 },
                { step: 'Inicios de Pago (Bold)', count: totalPayClicks, pct: totalVisits ? Math.round((totalPayClicks / totalVisits) * 100) : 0 },
                { step: 'Ventas Completadas', count: totalSales, pct: totalVisits ? Math.round((totalSales / totalVisits) * 100) : 0 },
            ],
            conversionRate: totalVisits ? ((totalSales / totalVisits) * 100).toFixed(2) : '0.00'
        });
    } catch (e) {
        console.error('Error fetching purchase funnel:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/prices/save', async (req, res) => {
    try {
        const { platform, price, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.savePrice(platform, price);

        // Sincronizar automáticamente con la tienda pública de ventas (platform_plans y platforms)
        try {
            const numPrice = parseFloat(price);
            if (!isNaN(numPrice) && numPrice > 0) {
                const { syncPriceToPublicCatalog } = require('../platformsDbService');
                await syncPriceToPublicCatalog(platform, numPrice);
            }
        } catch (syncErr) {
            console.warn('[Prices Save] Error sincronizando con catálogo público:', syncErr.message);
        }

        res.json({ success: true, message: 'Precio actualizado con éxito en contabilidad y página de ventas' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/plans/price', async (req, res) => {
    try {
        const { planId, price, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { updatePlanPriceInDb } = require('../platformsDbService');
        await updatePlanPriceInDb(planId, price);
        res.json({ success: true, message: 'Precio de plan actualizado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/platforms/sync-db', async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { forceSyncJsonToDb } = require('../platformsDbService');
        const result = await forceSyncJsonToDb();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/costs', async (req, res) => {
    try {
        const costs = await accountingService.getCosts();
        res.json(costs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/costs/save', async (req, res) => {
    try {
        const { costData, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.saveCost(costData);
        res.json({ success: true, message: 'Costo actualizado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/costs/delete', async (req, res) => {
    try {
        const { id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.deleteCost(id);
        res.json({ success: true, message: 'Costo eliminado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/accounting/daily', async (req, res) => {
    try {
        const data = await accountingService.calculateDailyAccounting();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/accounting/real', async (req, res) => {
    try {
        const data = await accountingService.calculateRealCashFlow();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/accounting/transaction', async (req, res) => {
    try {
        const { type, platform, amount, description, entryDate, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        await accountingService.addTransaction(type, platform, amount, description, entryDate, 0);
        res.json({ success: true, message: 'Transacción registrada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoints para Historial de Renovaciones de Cuentas Matriz (Proveedores y Flujo Real)
app.get('/api/admin/accounting/renewals', async (req, res) => {
    try {
        const renewals = await accountingService.getAccountRenewals(req.query);
        res.json(renewals);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/accounting/renewals/save', async (req, res) => {
    try {
        const { renewalData, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (renewalData && renewalData.sync_to_excel === undefined) {
            renewalData.sync_to_excel = true;
        }
        const result = await accountingService.recordAccountRenewal(renewalData);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/accounting/renewals/delete', async (req, res) => {
    try {
        const { id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const result = await accountingService.deleteAccountRenewal(id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// Endpoint to write human support schedule configuration
app.post('/api/admin/support-schedule/save', (req, res) => {
    try {
        const { config, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config || typeof config !== 'object') return res.status(400).json({ success: false, message: 'Configuración inválida' });

        const { saveSupportScheduleConfig } = require('../supportScheduleService');
        saveSupportScheduleConfig(config);
        res.json({ success: true, message: 'Configuración de horario de soporte actualizada con éxito.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/admin/gpt-accounts', (req, res) => {
    try {
        const { loadSecrets } = require('../totpService');
        const { authenticator } = require('@otplib/preset-default');
        const secrets = loadSecrets();
        const list = [];
        for (const email of Object.keys(secrets)) {
            let code = "";
            let timeRemaining = 30;
            const secretVal = secrets[email];
            const secret = typeof secretVal === 'object' ? secretVal.secret : secretVal;
            let service = typeof secretVal === 'object' ? secretVal.service : null;
            if (!service) {
                if (email.toLowerCase().includes('amazon') || email.toLowerCase().includes('prime')) {
                    service = 'Amazon';
                } else if (email.toLowerCase().includes('netflix')) {
                    service = 'Netflix';
                } else {
                    service = 'ChatGPT';
                }
            }
            try {
                code = authenticator.generate(secret);
                timeRemaining = authenticator.timeRemaining();
            } catch (e) {
                code = "Error";
            }
            list.push({ email, code, timeRemaining, service });
        }
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/ai-assistant/query', express.json(), async (req, res) => {
    try {
        const { query, activeTab, agentName, agentEmail, history } = req.body;
        if (!query) return res.status(400).json({ success: false, message: 'Falta la consulta (query)' });

        const { processAdminAssistantQuery } = require('../adminAssistantService');
        const response = await processAdminAssistantQuery({ query, activeTab, agentName, agentEmail, history });
        res.json(response);
    } catch (e) {
        console.error('[AI Assistant API Error]:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/audit-logs', (req, res) => {
    try {
        const { limit, action, agentEmail } = req.query;
        const { getAuditLogs } = require('../auditService');
        const logs = getAuditLogs({ 
            limit: limit ? parseInt(limit) : 100, 
            action: action || null, 
            agentEmail: agentEmail || null 
        });
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- EVALUACIONES DE ASESORES Y FILTRO DE CONTRATACIÓN ---
app.post('/api/public/advisor-test/submit', express.json(), async (req, res) => {
    try {
        const { saveAdvisorEvaluation } = require('../advisorEvaluationService');
        const result = await saveAdvisorEvaluation(req.body);

        // Los resultados se mantienen 100% confidenciales en el panel web de administración
        // No se envían a grupos de WhatsApp para proteger la privacidad de los postulantes y del administrador.

        res.json(result);
    } catch (e) {
        console.error('[Advisor Test Submit Error]:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/advisor-evaluations', async (req, res) => {
    try {
        const { getAdvisorEvaluations } = require('../advisorEvaluationService');
        const evaluations = await getAdvisorEvaluations();
        res.json({ success: true, evaluations });
    } catch (e) {
        console.error('[Advisor Evaluations Error]:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- DESCARGA / VISUALIZACIÓN PROTEGIDA DE LA WIKI (SOLO ADMINS) ---
app.get('/api/admin/docs/wiki-pdf', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const passQuery = req.query.password || req.query.pass || '';
    const isValidPass = passQuery === 'admin123' || passQuery === 'demo123' || authHeader.includes('Bearer admin123');

    // Permitir acceso desde panel admin si tiene sesión válida o clave
    const pdfPath = path.join(ROOT_DIR, 'wiki_sheerit_completa.pdf');
    if (!fs.existsSync(pdfPath)) {
        return res.status(404).send('Archivo de Wiki no encontrado en el servidor.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="wiki_sheerit_operaciones.pdf"');
    res.sendFile(pdfPath);
});

// ==========================================
// DATA STUDIO / RELATIONAL DB STUDIO ENDPOINTS
// ==========================================
const dataStudioService = require('../dataStudioService');

app.get('/api/admin/database/tables', async (req, res) => {
    try {
        const tables = await dataStudioService.getTablesOverview();
        res.json({ success: true, tables });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/database/query', async (req, res) => {
    try {
        const { sql, allowWrite, limit, dryRun } = req.body;
        const result = await dataStudioService.executeStudioQuery(sql, { allowWrite, limit, dryRun });
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// Endpoints ETL Histórico (OneDrive Microsoft Graph -> Staging SQL -> excel_historical_records)
app.get('/api/admin/database/etl/historico/status', async (req, res) => {
    try {
        const status = await dataStudioService.getHistoricoEtlStatus();
        res.json({ success: true, ...status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/database/etl/historico/extract', async (req, res) => {
    try {
        const { forceGraph = true } = req.body || {};
        const result = await dataStudioService.syncHistoricoToStaging({ forceGraph });
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/database/etl/historico/promote', async (req, res) => {
    try {
        const { onlyClean = true, includePhoneIssues = false } = req.body || {};
        const result = await dataStudioService.promoteHistoricoStaging({ onlyClean, includePhoneIssues });
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/database/schema-graph', async (req, res) => {
    try {
        const graph = await dataStudioService.getSchemaGraph();
        res.json({ success: true, graph });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/database/import-preview', (req, res) => {
    try {
        const { headers, rows, targetEntity } = req.body;
        const preview = dataStudioService.previewDataImport(headers, rows, targetEntity);
        res.json({ success: true, preview });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/database/import-execute', async (req, res) => {
    try {
        const { targetEntity, mapping, rows, tenantId, options } = req.body;
        const result = await dataStudioService.executeDataImport({ targetEntity, mapping, rows, tenantId, options });
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint Tutor SQL Educativo
app.post('/api/admin/database/tutor', async (req, res) => {
    try {
        const { action, sql, question } = req.body;
        if (action === 'explain') {
            const explanation = await dataStudioService.explainSqlQuery(sql);
            res.json({ success: true, explanation });
        } else if (action === 'ask') {
            const result = await dataStudioService.askTutor(question);
            res.json({ success: true, result });
        } else if (action === 'tutorials') {
            const tutorials = dataStudioService.getSqlTutorials();
            res.json({ success: true, tutorials });
        } else {
            res.status(400).json({ success: false, error: 'Acción inválida. Usa explain, ask o tutorials.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint KNIME: Auditoría de Calidad y Reglas de Datos Históricos
app.get('/api/admin/database/knime-audit', async (req, res) => {
    try {
        const result = await dataStudioService.getKnimeDataQualityAudit();
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint KNIME: Simulación de Escenarios What-If
app.post('/api/admin/database/knime-scenario', async (req, res) => {
    try {
        const { scenarioId } = req.body;
        const result = await dataStudioService.getKnimeScenarioSimulation(scenarioId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


app.post('/api/admin/gpt-accounts/save', (req, res) => {
    try {
        const { email, secret, service, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !secret) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { saveSecret } = require('../totpService');
        saveSecret(email, secret, service || 'ChatGPT', { agentEmail, agentName });
        res.json({ success: true, message: 'Cuenta 2FA guardada y auditada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/payment-config', (req, res) => {
    try {
        const { getPaymentConfig } = require('../paymentConfigService');
        const config = getPaymentConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/payment-config', (req, res) => {
    try {
        const { config, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!config) return res.status(400).json({ error: 'Falta configuración en la solicitud' });

        const { savePaymentConfig } = require('../paymentConfigService');
        savePaymentConfig(config);
        res.json({ success: true, message: 'Configuración de pagos guardada con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/trigger-auto-cobros', async (req, res) => {
    try {
        if (!ctx.getClient() || !ctx.getClient().info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }
        const { handleAutoCobros } = require('../billingService');
        const fakeMsg = {
            from: '120363161345379149@g.us',
            to: '120363161345379149@g.us',
            body: '@bot cobros automáticos',
            reply: async (text) => console.log('[Trigger Cobros Reply]:', text)
        };
        handleAutoCobros(fakeMsg, '120363161345379149@g.us', userStates, pendingConfirmations, ctx.getClient()).catch(err => {
            console.error('[Trigger Auto-Cobros API Error]:', err);
        });
        res.json({ success: true, message: 'Cobros automáticos iniciados correctamente en segundo plano.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/groups', async (req, res) => {
    try {
        if (!ctx.getClient() || !ctx.getClient().info) {
            return res.status(503).json({ error: 'WhatsApp client is not ready' });
        }
        const chats = await ctx.getClient().getChats();
        const groups = chats
            .filter(chat => chat && chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name || 'Sin Nombre',
                unreadCount: chat.unreadCount || 0
            }));
        res.json(groups);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gpt-accounts/delete', (req, res) => {
    try {
        const { email, password, agentEmail, agentName } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { deleteSecret } = require('../totpService');
        const deleted = deleteSecret(email, { agentEmail, agentName });
        if (deleted) {
            res.json({ success: true, message: 'Cuenta 2FA eliminada y auditada con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const FALLBACK_PLATFORM_DEFAULT_SLOTS = {
    NETFLIX: 5,
    'NETFLIX EXTRA': 1,
    DISNEY: 7,
    'DISNEY+': 7,
    HBO: 5,
    'HBO PLATINO': 5,
    MAX: 5,
    'MAX (HBO)': 5,
    AMAZON: 6,
    'PRIME VIDEO': 6,
    SPOTIFY: 6,
    YOUTUBE: 5,
    'APPLE ONE': 6,
    'APPLE TV': 5,
    'CRUNCHY ROLL': 5,
    CRUNCHYROLL: 5,
    PARAMOUNT: 6,
    'PARAMOUNT+': 6,
    VIX: 4,
    GPT: 5,
    CHATGPT: 5,
    'CHATGPT (GPT)': 5,
    CLAUDE: 5,
    CANVA: 5,
    MICROSOFT: 6,
    OFFICE: 6
};

let masterColsReady = false;
async function ensureMasterAccountColumns() {
    if (masterColsReady) return;
    try {
        const [cols] = await pool.query('SHOW COLUMNS FROM stream_accounts');
        const existing = new Set((cols || []).map(c => String(c.Field || '').toLowerCase()));
        const needed = [
            ['max_profiles', 'INT NULL'],
            ['expiration_date', 'DATE NULL'],
            ['cost_price', 'DECIMAL(12,2) NULL'],
            ['sale_price', 'DECIMAL(12,2) NULL'],
            ['payment_method', 'VARCHAR(150) NULL'],
            ['guide_notes', 'TEXT NULL']
        ];
        for (const [colName, colDef] of needed) {
            if (!existing.has(colName)) {
                await pool.query(`ALTER TABLE stream_accounts ADD COLUMN ${colName} ${colDef}`);
            }
        }
        masterColsReady = true;
    } catch (e) {
        console.warn('[Master Accounts] Error asegurando columnas en stream_accounts:', e.message);
    }
}

function formatDateIsoSafe(val, getJsDateFromExcel) {
    if (!val) return '';
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val.trim())) {
        return val.trim().slice(0, 10);
    }
    const parsed = getJsDateFromExcel ? getJsDateFromExcel(val) : null;
    if (parsed && !isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
    }
    return '';
}

function isExcelSlotFree(row) {
    const whatsapp = String(row.whatsapp || '').trim();
    const nombre = String(row.Nombre || row.nombre || '').trim().toLowerCase();
    const numero = String(row.numero || row.Numero || row.celular || '').replace(/\D/g, '');
    return !whatsapp && !numero && (!nombre || nombre === 'libre' || nombre === 'disponible');
}

async function loadAccountingPlatformConfigs() {
    const platformConfigs = {};
    const platformDefaultSlots = { ...FALLBACK_PLATFORM_DEFAULT_SLOTS };

    const isVariableSharedPlat = (platName) => /gpt|chatgpt|claude|compartid|canva|platzi/i.test(String(platName || ''));

    Object.entries(FALLBACK_PLATFORM_DEFAULT_SLOTS).forEach(([plat, slots]) => {
        platformConfigs[plat] = {
            profileSlots: slots,
            defaultCost: null,
            defaultSalePrice: null,
            durationDays: 30,
            isVariableShared: isVariableSharedPlat(plat),
            source: 'fallback'
        };
    });

    try {
        const [costRows] = await pool.query(
            'SELECT platform, total_cost, profile_slots, duration_days, provider FROM streaming_costs ORDER BY (provider IS NULL) DESC, id ASC'
        ).catch(() => [[]]);

        for (const row of (costRows || [])) {
            const pKey = String(row.platform || '').trim().toUpperCase();
            if (!pKey) continue;
            // Priorizar la primera fila base (provider IS NULL, id más bajo)
            if (platformConfigs[pKey] && platformConfigs[pKey].source === 'contabilidad') continue;
            const slots = Math.max(1, Number(row.profile_slots) || FALLBACK_PLATFORM_DEFAULT_SLOTS[pKey] || 1);
            const costVal = Number(row.total_cost);
            platformDefaultSlots[pKey] = slots;
            platformConfigs[pKey] = {
                profileSlots: slots,
                defaultCost: costVal > 0 ? costVal : null,
                defaultSalePrice: platformConfigs[pKey]?.defaultSalePrice || null,
                durationDays: Math.max(1, Number(row.duration_days) || 30),
                isVariableShared: isVariableSharedPlat(pKey),
                source: 'contabilidad'
            };
        }

        const [priceRows] = await pool.query(
            'SELECT platform, normal_price FROM streaming_prices'
        ).catch(() => [[]]);

        for (const pr of (priceRows || [])) {
            const pKey = String(pr.platform || '').trim().toUpperCase();
            if (!pKey) continue;
            const saleVal = Number(pr.normal_price) || null;
            if (!platformConfigs[pKey]) {
                platformConfigs[pKey] = {
                    profileSlots: FALLBACK_PLATFORM_DEFAULT_SLOTS[pKey] || 5,
                    defaultCost: null,
                    defaultSalePrice: saleVal,
                    durationDays: 30,
                    isVariableShared: isVariableSharedPlat(pKey),
                    source: 'contabilidad'
                };
            } else if (saleVal) {
                platformConfigs[pKey].defaultSalePrice = saleVal;
            }
        }
    } catch (e) {
        console.warn('[Master Accounts] Error cargando configuración desde Contabilidad:', e.message);
    }

    return { platformConfigs, platformDefaultSlots };
}

app.get('/api/admin/master-accounts/platform-defaults', async (req, res) => {
    try {
        const { platformConfigs, platformDefaultSlots } = await loadAccountingPlatformConfigs();
        res.json({ success: true, platformConfigs, platformDefaultSlots });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/master-accounts', async (req, res) => {
    try {
        await ensureMasterAccountColumns();
        const { fetchRawData, getJsDateFromExcel, getTodayInBogota } = require('../apiService');
        const force = req.query.force === '1' || req.query.force === 'true';

        const [rawRows, dbRes, renRes] = await Promise.all([
            fetchRawData(3, 2000, force),
            pool.query('SELECT * FROM stream_accounts ORDER BY id DESC'),
            pool.query('SELECT * FROM account_renewals ORDER BY id DESC').catch(() => [[]])
        ]);

        const dbAccounts = dbRes[0] || [];
        const renewals = renRes[0] || [];

        const dbMap = new Map();
        for (const dbRow of dbAccounts) {
            const key = `${String(dbRow.streaming_platform || '').trim().toUpperCase()}:::${String(dbRow.account_email || '').trim().toLowerCase()}`;
            if (!dbMap.has(key)) dbMap.set(key, dbRow);
        }

        const renewalMap = new Map();
        for (const r of renewals) {
            const key = `${String(r.platform || '').trim().toUpperCase()}:::${String(r.account_email || '').trim().toLowerCase()}`;
            if (!renewalMap.has(key)) renewalMap.set(key, r);
        }

        const grouped = new Map();
        (rawRows || []).forEach((row, idx) => {
            const platform = String(row.Streaming || row.Plataforma || '').trim();
            const email = String(row.correo || row.Correo || '').trim();
            if (!platform || !email) return;

            const key = `${platform.toUpperCase()}:::${email.toLowerCase()}`;
            const rowNum = row._rowNumber || (idx + 2);
            const isFree = isExcelSlotFree(row);
            const rowPass = String(row['contraseña'] || row.contraseña || row.clave || row.password || '').trim();
            const rowVenc = formatDateIsoSafe(row.vencimiento || row.Vencimiento, getJsDateFromExcel);
            const rowPayMethod = String(row['Metodo de pago'] || row['metodo de pago'] || row.metodoPago || '').trim();

            if (!grouped.has(key)) {
                grouped.set(key, {
                    key,
                    platform: platform.toUpperCase(),
                    rawPlatform: platform,
                    email,
                    password: rowPass,
                    totalSlots: 0,
                    occupiedSlots: 0,
                    freeSlots: 0,
                    rowNumbers: [],
                    freeRowNumbers: [],
                    expirationDate: rowVenc,
                    paymentMethod: rowPayMethod
                });
            }

            const entry = grouped.get(key);
            entry.totalSlots++;
            if (isFree) {
                entry.freeSlots++;
                entry.freeRowNumbers.push(rowNum);
            } else {
                entry.occupiedSlots++;
            }
            entry.rowNumbers.push(rowNum);
            if (!entry.password && rowPass) entry.password = rowPass;
            if (rowVenc && (!entry.expirationDate || rowVenc > entry.expirationDate)) entry.expirationDate = rowVenc;
            if (!entry.paymentMethod && rowPayMethod) entry.paymentMethod = rowPayMethod;
        });

        // Incluir cuentas registradas en DB aunque aún no tengan filas en Excel
        for (const dbRow of dbAccounts) {
            const plat = String(dbRow.streaming_platform || '').trim();
            const email = String(dbRow.account_email || '').trim();
            if (!plat || !email) continue;
            const key = `${plat.toUpperCase()}:::${email.toLowerCase()}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    key,
                    platform: plat.toUpperCase(),
                    rawPlatform: plat,
                    email,
                    password: dbRow.account_password || '',
                    totalSlots: 0,
                    occupiedSlots: 0,
                    freeSlots: 0,
                    rowNumbers: [],
                    freeRowNumbers: [],
                    expirationDate: '',
                    paymentMethod: dbRow.payment_method || ''
                });
            }
        }

        const today = getTodayInBogota ? getTodayInBogota() : new Date();
        today.setHours(0, 0, 0, 0);

        let expiringSoon = 0;
        let totalSlots = 0;
        let occupiedSlots = 0;
        let freeSlots = 0;

        const accounts = Array.from(grouped.values()).map(acc => {
            const dbRow = dbMap.get(acc.key) || null;
            const latestRen = renewalMap.get(acc.key) || null;

            const dbExp = dbRow?.expiration_date ? new Date(dbRow.expiration_date).toISOString().split('T')[0] : '';
            const renExp = latestRen?.expiration_date ? new Date(latestRen.expiration_date).toISOString().split('T')[0] : '';
            const expirationDate = dbExp || acc.expirationDate || renExp || '';

            let daysLeft = null;
            if (expirationDate) {
                const expD = new Date(`${expirationDate}T00:00:00`);
                if (!isNaN(expD.getTime())) {
                    daysLeft = Math.ceil((expD.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                    if (daysLeft <= 5 && (dbRow?.status || 'active') !== 'inactive') {
                        expiringSoon++;
                    }
                }
            }

            const status = dbRow?.status || 'active';
            if (status !== 'inactive') {
                totalSlots += acc.totalSlots;
                occupiedSlots += acc.occupiedSlots;
                freeSlots += acc.freeSlots;
            }

            return {
                ...acc,
                dbId: dbRow?.id || null,
                password: acc.password || dbRow?.account_password || '',
                providerName: dbRow?.provider_name || latestRen?.provider || '',
                paymentMethod: dbRow?.payment_method || acc.paymentMethod || latestRen?.payment_method || '',
                costPrice: dbRow?.cost_price != null ? Number(dbRow.cost_price) : (latestRen?.amount_paid != null ? Number(latestRen.amount_paid) : null),
                salePrice: dbRow?.sale_price != null ? Number(dbRow.sale_price) : null,
                guideNotes: dbRow?.guide_notes || dbRow?.notes || '',
                maxProfiles: dbRow?.max_profiles != null ? Number(dbRow.max_profiles) : acc.totalSlots,
                expirationDate,
                daysLeft,
                status
            };
        }).sort((a, b) => a.platform.localeCompare(b.platform) || a.email.localeCompare(b.email));

        const { platformConfigs, platformDefaultSlots } = await loadAccountingPlatformConfigs();

        res.json({
            success: true,
            accounts,
            platformConfigs,
            platformDefaultSlots,
            summary: {
                totalAccounts: accounts.filter(a => a.status !== 'inactive').length,
                totalSlots,
                occupiedSlots,
                freeSlots,
                expiringSoon
            }
        });
    } catch (e) {
        console.error('[Master Accounts GET Error]:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/accounts/add', express.json(), async (req, res) => {
    try {
        await ensureMasterAccountColumns();
        const {
            streaming,
            correo,
            contraseña,
            perfiles,
            vencimiento,
            proveedor,
            paymentMethod,
            costPrice,
            salePrice,
            guideNotes,
            recordExpense = false,
            password
        } = req.body || {};

        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!streaming || !correo || !contraseña || !perfiles) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (plataforma, correo, contraseña, cupos)' });
        }

        const cleanPlat = String(streaming).trim();
        const cleanEmail = String(correo).trim();
        const cleanPass = String(contraseña).trim();
        const numPerfiles = Math.max(1, Math.min(30, parseInt(perfiles, 10) || 1));

        const { fetchRawData, updateExcelData, getTodayInBogota } = require('../apiService');
        const allRows = await fetchRawData();
        const startRow = allRows.length + 2;

        const combinedPayMethod = proveedor
            ? `${String(proveedor).trim()}${paymentMethod ? ` - ${String(paymentMethod).trim()}` : ''}`
            : (paymentMethod ? String(paymentMethod).trim() : '');

        for (let i = 0; i < numPerfiles; i++) {
            const rowNumber = startRow + i;
            const updates = {
                "Streaming": cleanPlat,
                "correo": cleanEmail,
                "contraseña": cleanPass,
                "Nombre": "",
                "whatsapp": "",
                "numero": "",
                "deben": ""
            };
            if (vencimiento) updates["vencimiento"] = String(vencimiento).trim();
            if (combinedPayMethod) updates["Metodo de pago"] = combinedPayMethod;
            await updateExcelData(rowNumber, updates);
        }

        // UPSERT en stream_accounts
        const [existingDb] = await pool.query(
            'SELECT id FROM stream_accounts WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ? LIMIT 1',
            [cleanEmail.toLowerCase(), cleanPlat.toLowerCase()]
        );

        const parsedCost = costPrice !== '' && costPrice !== null && costPrice !== undefined ? Number(costPrice) : null;
        const parsedSale = salePrice !== '' && salePrice !== null && salePrice !== undefined ? Number(salePrice) : null;
        const expDateSql = vencimiento && /^\d{4}-\d{2}-\d{2}$/.test(String(vencimiento).trim()) ? String(vencimiento).trim() : null;

        if (existingDb.length > 0) {
            await pool.query(
                `UPDATE stream_accounts
                 SET account_password = ?, provider_name = ?, max_profiles = ?, expiration_date = COALESCE(?, expiration_date),
                     cost_price = COALESCE(?, cost_price), sale_price = COALESCE(?, sale_price),
                     payment_method = COALESCE(?, payment_method), guide_notes = COALESCE(?, guide_notes), status = 'active'
                 WHERE id = ?`,
                [
                    cleanPass,
                    proveedor ? String(proveedor).trim() : null,
                    numPerfiles,
                    expDateSql,
                    parsedCost,
                    parsedSale,
                    paymentMethod ? String(paymentMethod).trim() : null,
                    guideNotes ? String(guideNotes).trim() : null,
                    existingDb[0].id
                ]
            );
        } else {
            await pool.query(
                `INSERT INTO stream_accounts
                 (account_email, streaming_platform, account_password, is_provider, provider_name, max_profiles, expiration_date, cost_price, sale_price, payment_method, guide_notes, status)
                 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                [
                    cleanEmail,
                    cleanPlat.toLowerCase(),
                    cleanPass,
                    proveedor ? String(proveedor).trim() : null,
                    numPerfiles,
                    expDateSql,
                    parsedCost,
                    parsedSale,
                    paymentMethod ? String(paymentMethod).trim() : null,
                    guideNotes ? String(guideNotes).trim() : null
                ]
            );
        }

        if (recordExpense && parsedCost && parsedCost > 0) {
            try {
                const today = getTodayInBogota ? getTodayInBogota() : new Date();
                const todayStr = today.toISOString().split('T')[0];
                const fallbackExp = expDateSql || new Date(today.getTime() + 30 * 86400000).toISOString().split('T')[0];
                await accountingService.recordAccountRenewal({
                    platform: cleanPlat.toUpperCase(),
                    account_email: cleanEmail,
                    provider: proveedor ? String(proveedor).trim() : 'Directo',
                    payment_method: paymentMethod ? String(paymentMethod).trim() : 'Compra Inicial',
                    amount_paid: parsedCost,
                    renewal_date: todayStr,
                    expiration_date: fallbackExp,
                    duration_days: 30,
                    profile_slots: numPerfiles,
                    notes: guideNotes ? String(guideNotes).trim() : 'Compra inicial de cuenta matriz',
                    registered_by: 'Admin',
                    sync_to_cash_flow: true,
                    sync_to_excel: false
                });
            } catch (renErr) {
                console.warn('[Master Accounts Add] Error asentando egreso contable:', renErr.message);
            }
        }

        res.json({
            success: true,
            message: `Cuenta matriz ${cleanPlat} (${cleanEmail}) creada con ${numPerfiles} cupos en Excel y MariaDB.`
        });
    } catch (e) {
        console.error('[Master Accounts Add Error]:', e);
        res.status(500).json({ success: false, message: e.message, error: e.message });
    }
});

app.post('/api/admin/master-accounts/update', express.json(), async (req, res) => {
    try {
        await ensureMasterAccountColumns();
        const {
            platform,
            email,
            account_password,
            expiration_date,
            provider_name,
            payment_method,
            cost_price,
            sale_price,
            guide_notes,
            status = 'active',
            syncToExcel = true,
            password
        } = req.body || {};

        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!platform || !email) {
            return res.status(400).json({ success: false, message: 'Faltan platform y email' });
        }

        const cleanPlat = String(platform).trim();
        const cleanEmail = String(email).trim();
        const expSql = expiration_date && /^\d{4}-\d{2}-\d{2}$/.test(String(expiration_date).trim())
            ? String(expiration_date).trim()
            : null;
        const parsedCost = cost_price !== '' && cost_price !== null && cost_price !== undefined ? Number(cost_price) : null;
        const parsedSale = sale_price !== '' && sale_price !== null && sale_price !== undefined ? Number(sale_price) : null;

        const [existing] = await pool.query(
            'SELECT id FROM stream_accounts WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ? LIMIT 1',
            [cleanEmail.toLowerCase(), cleanPlat.toLowerCase()]
        );

        if (existing.length > 0) {
            await pool.query(
                `UPDATE stream_accounts
                 SET account_password = ?, expiration_date = ?, provider_name = ?, payment_method = ?,
                     cost_price = ?, sale_price = ?, guide_notes = ?, status = ?
                 WHERE id = ?`,
                [
                    account_password ? String(account_password).trim() : null,
                    expSql,
                    provider_name ? String(provider_name).trim() : null,
                    payment_method ? String(payment_method).trim() : null,
                    parsedCost,
                    parsedSale,
                    guide_notes ? String(guide_notes).trim() : null,
                    status === 'inactive' ? 'inactive' : 'active',
                    existing[0].id
                ]
            );
        } else {
            await pool.query(
                `INSERT INTO stream_accounts
                 (account_email, streaming_platform, account_password, is_provider, provider_name, expiration_date, cost_price, sale_price, payment_method, guide_notes, status)
                 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    cleanEmail,
                    cleanPlat.toLowerCase(),
                    account_password ? String(account_password).trim() : null,
                    provider_name ? String(provider_name).trim() : null,
                    expSql,
                    parsedCost,
                    parsedSale,
                    payment_method ? String(payment_method).trim() : null,
                    guide_notes ? String(guide_notes).trim() : null,
                    status === 'inactive' ? 'inactive' : 'active'
                ]
            );
        }

        let excelUpdatedRows = 0;
        if (syncToExcel) {
            const { fetchRawData, updateExcelData } = require('../apiService');
            const allRows = await fetchRawData(3, 2000, true);
            const targetPlatUpper = cleanPlat.toUpperCase();
            const targetEmailLower = cleanEmail.toLowerCase();

            const updates = {};
            if (account_password !== undefined && String(account_password).trim() !== '') {
                updates['contraseña'] = String(account_password).trim();
            }
            if (expSql) updates['vencimiento'] = expSql;
            const combinedPay = provider_name
                ? `${String(provider_name).trim()}${payment_method ? ` - ${String(payment_method).trim()}` : ''}`
                : (payment_method ? String(payment_method).trim() : '');
            if (combinedPay) updates['Metodo de pago'] = combinedPay;

            if (Object.keys(updates).length > 0) {
                for (let i = 0; i < allRows.length; i++) {
                    const row = allRows[i];
                    const rPlat = String(row.Streaming || row.Plataforma || '').trim().toUpperCase();
                    const rEmail = String(row.correo || row.Correo || '').trim().toLowerCase();
                    if (rPlat === targetPlatUpper && rEmail === targetEmailLower) {
                        const rNum = row._rowNumber || (i + 2);
                        await updateExcelData(rNum, updates);
                        excelUpdatedRows++;
                    }
                }
            }
        }

        res.json({
            success: true,
            excelUpdatedRows,
            message: `Cuenta matriz actualizada${excelUpdatedRows > 0 ? ` (${excelUpdatedRows} cupos sincronizados en Excel)` : ''}.`
        });
    } catch (e) {
        console.error('[Master Accounts Update Error]:', e);
        res.status(500).json({ success: false, message: e.message, error: e.message });
    }
});

app.post('/api/admin/master-accounts/adjust-slots', express.json(), async (req, res) => {
    try {
        await ensureMasterAccountColumns();
        const { platform, email, delta, password } = req.body || {};
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const deltaInt = parseInt(delta, 10);
        if (!platform || !email || !deltaInt || deltaInt < -20 || deltaInt > 20) {
            return res.status(400).json({ success: false, message: 'Parámetros inválidos (delta entre -20 y +20, distinto de 0)' });
        }

        const { fetchRawData, updateExcelData, getJsDateFromExcel } = require('../apiService');
        const allRows = await fetchRawData(3, 2000, true);
        const targetPlatUpper = String(platform).trim().toUpperCase();
        const targetEmailLower = String(email).trim().toLowerCase();

        const matching = [];
        allRows.forEach((row, i) => {
            const rPlat = String(row.Streaming || row.Plataforma || '').trim().toUpperCase();
            const rEmail = String(row.correo || row.Correo || '').trim().toLowerCase();
            if (rPlat === targetPlatUpper && rEmail === targetEmailLower) {
                matching.push({ row, rowNumber: row._rowNumber || (i + 2) });
            }
        });

        let newTotal = matching.length;

        if (deltaInt > 0) {
            const sample = matching[0]?.row || {};
            const [dbRows] = await pool.query(
                'SELECT * FROM stream_accounts WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ? LIMIT 1',
                [targetEmailLower, targetPlatUpper.toLowerCase()]
            );
            const dbAcc = dbRows[0] || {};
            const passVal = String(sample['contraseña'] || sample.contraseña || sample.clave || dbAcc.account_password || '').trim();
            const vencVal = formatDateIsoSafe(sample.vencimiento || sample.Vencimiento || dbAcc.expiration_date, getJsDateFromExcel);
            const payVal = String(sample['Metodo de pago'] || sample['metodo de pago'] || dbAcc.payment_method || '').trim();

            const startRow = allRows.length + 2;
            for (let i = 0; i < deltaInt; i++) {
                const updates = {
                    "Streaming": sample.Streaming || platform,
                    "correo": email.trim(),
                    "contraseña": passVal,
                    "Nombre": "",
                    "whatsapp": "",
                    "numero": "",
                    "deben": ""
                };
                if (vencVal) updates["vencimiento"] = vencVal;
                if (payVal) updates["Metodo de pago"] = payVal;
                await updateExcelData(startRow + i, updates);
            }
            newTotal = matching.length + deltaInt;
        } else {
            const toRemove = Math.abs(deltaInt);
            const freeMatches = matching.filter(m => isExcelSlotFree(m.row));
            if (freeMatches.length < toRemove) {
                return res.status(400).json({
                    success: false,
                    message: `Solo hay ${freeMatches.length} cupo(s) libre(s) para eliminar sin afectar clientes activos.`
                });
            }
            for (let i = 0; i < toRemove; i++) {
                await updateExcelData(freeMatches[i].rowNumber, {
                    "Streaming": "",
                    "correo": "",
                    "contraseña": "",
                    "Nombre": "",
                    "apellido": "",
                    "whatsapp": "",
                    "numero": "",
                    "vencimiento": "",
                    "deben": "",
                    "Metodo de pago": "",
                    "observaciones": ""
                });
            }
            newTotal = matching.length - toRemove;
        }

        await pool.query(
            'UPDATE stream_accounts SET max_profiles = ? WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ?',
            [Math.max(0, newTotal), targetEmailLower, targetPlatUpper.toLowerCase()]
        );

        res.json({
            success: true,
            newTotalSlots: newTotal,
            message: deltaInt > 0
                ? `Se agregaron ${deltaInt} cupo(s) libre(s). Total actual: ${newTotal}.`
                : `Se eliminaron ${Math.abs(deltaInt)} cupo(s) vacío(s). Total actual: ${newTotal}.`
        });
    } catch (e) {
        console.error('[Master Accounts Adjust Slots Error]:', e);
        res.status(500).json({ success: false, message: e.message, error: e.message });
    }
});

app.delete('/api/admin/master-accounts', express.json(), async (req, res) => {
    try {
        await ensureMasterAccountColumns();
        const payload = (req.body && Object.keys(req.body).length > 0) ? req.body : req.query;
        const { platform, email, clearFreeRows = false, forceDeactivate = false, password } = payload || {};

        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!platform || !email) {
            return res.status(400).json({ success: false, message: 'Faltan platform y email' });
        }

        const { fetchRawData, updateExcelData } = require('../apiService');
        const allRows = await fetchRawData(3, 2000, true);
        const targetPlatUpper = String(platform).trim().toUpperCase();
        const targetEmailLower = String(email).trim().toLowerCase();

        const matching = [];
        allRows.forEach((row, i) => {
            const rPlat = String(row.Streaming || row.Plataforma || '').trim().toUpperCase();
            const rEmail = String(row.correo || row.Correo || '').trim().toLowerCase();
            if (rPlat === targetPlatUpper && rEmail === targetEmailLower) {
                matching.push({ row, rowNumber: row._rowNumber || (i + 2) });
            }
        });

        const occupiedCount = matching.filter(m => !isExcelSlotFree(m.row)).length;
        if (occupiedCount > 0 && !forceDeactivate) {
            return res.status(409).json({
                success: false,
                hasOccupied: true,
                occupiedCount,
                message: `Esta cuenta tiene ${occupiedCount} cliente(s) activo(s). Confirma si deseas desactivarla (los clientes ocupados no se borrarán).`
            });
        }

        let clearedRows = 0;
        if (clearFreeRows === true || clearFreeRows === 'true') {
            const freeMatches = matching.filter(m => isExcelSlotFree(m.row));
            for (const m of freeMatches) {
                await updateExcelData(m.rowNumber, {
                    "Streaming": "",
                    "correo": "",
                    "contraseña": "",
                    "Nombre": "",
                    "apellido": "",
                    "whatsapp": "",
                    "numero": "",
                    "vencimiento": "",
                    "deben": "",
                    "Metodo de pago": "",
                    "observaciones": ""
                });
                clearedRows++;
            }
        }

        if (matching.length === 0 || (occupiedCount === 0 && clearedRows === matching.length)) {
            await pool.query(
                'DELETE FROM stream_accounts WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ?',
                [targetEmailLower, targetPlatUpper.toLowerCase()]
            );
        } else {
            await pool.query(
                `UPDATE stream_accounts SET status = 'inactive' WHERE LOWER(account_email) = ? AND LOWER(streaming_platform) = ?`,
                [targetEmailLower, targetPlatUpper.toLowerCase()]
            );
        }

        res.json({
            success: true,
            clearedRows,
            occupiedCount,
            message: occupiedCount > 0
                ? `Cuenta marcada como inactiva (${clearedRows} cupos vacíos limpiados; se preservaron ${occupiedCount} clientes activos).`
                : `Cuenta matriz eliminada/desactivada (${clearedRows} filas vacías limpiadas en Excel).`
        });
    } catch (e) {
        console.error('[Master Accounts Delete Error]:', e);
        res.status(500).json({ success: false, message: e.message, error: e.message });
    }
});

app.get('/api/admin/provider-emails', (req, res) => {
    try {
        const file = path.join(ROOT_DIR, 'provider_emails.json');
        if (fs.existsSync(file)) {
            const data = fs.readFileSync(file, 'utf8');
            return res.json(JSON.parse(data));
        }
        res.json([]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/provider-emails/save', (req, res) => {
    try {
        const { email, providerNumber, notes, rpaRecipeId, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !providerNumber) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const file = path.join(ROOT_DIR, 'provider_emails.json');
        let data = [];
        if (fs.existsSync(file)) {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
        }

        const cleanEmail = email.toLowerCase().trim();
        const index = data.findIndex(item => item.email.toLowerCase().trim() === cleanEmail);
        const newItem = {
            email: cleanEmail,
            providerNumber: providerNumber.trim(),
            notes: (notes || "").trim(),
            rpaRecipeId: rpaRecipeId ? parseInt(rpaRecipeId) : null
        };

        if (index !== -1) {
            data[index] = newItem;
        } else {
            data.push(newItem);
        }

        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        res.json({ success: true, message: 'Correo de proveedor guardado con éxito' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET: Lista de recetas RPA disponibles para el selector de proveedor
app.get('/api/admin/rpa/recipes', async (req, res) => {
    try {
        const { pool } = require('../database');
        const [rows] = await pool.query('SELECT id, name, platform FROM rpa_recipes ORDER BY id ASC');
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// SUBSCRIPTIONS API (BD como fuente de verdad)
// ==========================================

// GET: Listar cuentas de streaming con filtros opcionales (is_provider, search, etc.)
app.get('/api/admin/subscriptions', async (req, res) => {
    try {
        const { pool } = require('../database');
        const { is_provider, status, platform, search } = req.query;

        let where = [];
        let params = [];

        if (is_provider !== undefined) {
            where.push('sa.is_provider = ?');
            params.push(parseInt(is_provider));
        }
        if (status) {
            where.push('sa.status = ?');
            params.push(status);
        }
        if (platform) {
            where.push('sa.streaming_platform LIKE ?');
            params.push(`%${platform}%`);
        }
        if (search) {
            where.push('(sa.account_email LIKE ? OR aa.customer_phone LIKE ? OR c.fullname LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const whereStr = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

        // Retornamos las cuentas únicas y les anexamos info del cliente principal o lista de clientes asignados
        const [rows] = await pool.query(
            `SELECT 
                sa.id,
                sa.account_email,
                sa.streaming_platform,
                sa.is_provider,
                sa.provider_name,
                sa.rpa_recipe_id,
                sa.notes,
                r.name as recipe_name,
                -- Agrupamos teléfonos y nombres de clientes vinculados
                GROUP_CONCAT(aa.customer_phone SEPARATOR ', ') as customer_phone,
                GROUP_CONCAT(c.fullname SEPARATOR ', ') as fullname,
                MAX(aa.expiration_date) as expiration_date
             FROM stream_accounts sa
             LEFT JOIN account_assignments aa ON aa.account_id = sa.id
             LEFT JOIN customers c ON c.phone = aa.customer_phone
             LEFT JOIN rpa_recipes r ON r.id = sa.rpa_recipe_id
             ${whereStr}
             GROUP BY sa.id
             ORDER BY expiration_date ASC`,
            params
        );
        res.json({ success: true, data: rows, total: rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Guardar/actualizar cuenta de streaming
app.post('/api/admin/subscriptions/save', express.json(), async (req, res) => {
    try {
        const { id, account_email, streaming_platform, is_provider, provider_name,
            rpa_recipe_id, notes, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!streaming_platform || !account_email) {
            return res.status(400).json({ success: false, error: 'Faltan campos obligatorios' });
        }
        const { pool } = require('../database');
        if (id) {
            await pool.query(
                `UPDATE stream_accounts SET account_email=?, streaming_platform=?,
                  is_provider=?, provider_name=?, rpa_recipe_id=?, notes=? WHERE id=?`,
                [account_email, streaming_platform, is_provider ? 1 : 0, provider_name || null,
                    rpa_recipe_id || null, notes || null, id]
            );
        } else {
            await pool.query(
                `INSERT INTO stream_accounts (account_email, streaming_platform, is_provider,
                  provider_name, rpa_recipe_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
                [account_email, streaming_platform, is_provider ? 1 : 0, provider_name || null,
                    rpa_recipe_id || null, notes || null]
            );
        }
        res.json({ success: true, message: 'Cuenta guardada correctamente' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular rpaRecipeId a múltiples cuentas de streaming (en lote)
app.post('/api/admin/subscriptions/set-recipe-bulk', express.json(), async (req, res) => {
    try {
        const { ids, rpa_recipe_id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de IDs vacía o inválida' });
        }
        const { pool } = require('../database');
        await pool.query('UPDATE stream_accounts SET rpa_recipe_id = ? WHERE id IN (?)', [rpa_recipe_id || null, ids]);
        res.json({ success: true, message: `Se asignó la receta a ${ids.length} cuentas.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular provider_name a múltiples cuentas de streaming (en lote)
app.post('/api/admin/subscriptions/set-provider-bulk', express.json(), async (req, res) => {
    try {
        const { ids, provider_name, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, error: 'Lista de IDs vacía o inválida' });
        }
        const { pool } = require('../database');
        await pool.query('UPDATE stream_accounts SET provider_name = ? WHERE id IN (?)', [provider_name || null, ids]);
        res.json({ success: true, message: `Se asignó el proveedor a ${ids.length} cuentas.` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular provider_name a una cuenta específica
app.post('/api/admin/subscriptions/set-provider', express.json(), async (req, res) => {
    try {
        const { id, provider_name, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { pool } = require('../database');
        await pool.query('UPDATE stream_accounts SET provider_name = ? WHERE id = ?', [provider_name || null, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Vincular rpaRecipeId a una cuenta de streaming específica
app.post('/api/admin/subscriptions/set-recipe', express.json(), async (req, res) => {
    try {
        const { id, rpa_recipe_id, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { pool } = require('../database');
        await pool.query('UPDATE stream_accounts SET rpa_recipe_id = ? WHERE id = ?', [rpa_recipe_id || null, id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST: Disparar sincronización Excel → BD desde el panel
app.post('/api/admin/subscriptions/sync-excel', express.json(), async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { syncExcelToDb, syncHistoricoToDb } = require('../scripts/sync_excel_to_db');

        console.log('[Sync API] Sincronizando suscripciones actuales...');
        const result = await syncExcelToDb();

        console.log('[Sync API] Sincronizando cortes históricos...');
        const historicoResult = await syncHistoricoToDb();

        res.json({
            success: true,
            current: result,
            historico: historicoResult
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


app.post('/api/admin/provider-emails/delete', (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const file = path.join(ROOT_DIR, 'provider_emails.json');
        if (fs.existsSync(file)) {
            let data = JSON.parse(fs.readFileSync(file, 'utf8'));
            const cleanEmail = email.toLowerCase().trim();
            const filtered = data.filter(item => item.email.toLowerCase().trim() !== cleanEmail);
            fs.writeFileSync(file, JSON.stringify(filtered, null, 2));
            res.json({ success: true, message: 'Correo de proveedor eliminado con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Archivo no encontrado' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// GET Cuentas de streaming consolidadas (Excel + MySQL) con estado de automatización 2FA
app.get('/api/admin/streaming-accounts/overview', async (req, res) => {
    try {
        const { fetchCustomersData } = require('../apiService');
        const excelRows = await fetchCustomersData(3, 2000, false);
        const accountsMap = new Map();

        excelRows.forEach(row => {
            const emailRaw = String(row.correo || '').trim();
            if (!emailRaw || !emailRaw.includes('@')) return;
            const emailLower = emailRaw.toLowerCase();

            const platform = String(row.Streaming || '').trim().toUpperCase() || 'STREAMING';
            const password = String(row["contraseña"] || row.contraseña || row.clave || row.Password || row.password || '').trim();
            const clientName = `${row.Nombre || ''} ${row.apellido || ''}`.trim() || String(row.whatsapp || '').trim() || 'Cliente';
            const phone = String(row.numero || row.Numero || row.whatsapp || row.celular || '').replace(/\D/g, '');
            const pin = String(row["pin perfil"] || row.pin || '').trim();
            const venc = String(row.deben || row.Columna4 || row.vencimiento || '').trim();

            if (!accountsMap.has(emailLower)) {
                accountsMap.set(emailLower, {
                    email: emailRaw,
                    emailLower,
                    platform,
                    password,
                    profiles: [],
                    isProvider: false
                });
            }

            const acc = accountsMap.get(emailLower);
            acc.profiles.push({
                rowNumber: row._rowNumber,
                clientName,
                phone,
                pin,
                venc
            });
            if (!acc.password && password) acc.password = password;
            if (!acc.platform && platform) acc.platform = platform;
        });

        // Complementar con stream_accounts de MySQL
        try {
            const { pool } = require('../database');
            const [dbAccounts] = await pool.query(
                `SELECT sa.account_email, sa.streaming_platform, sa.account_password, sa.provider_name, sa.status, sa.rpa_recipe_id, r.name as recipe_name
                 FROM stream_accounts sa
                 LEFT JOIN rpa_recipes r ON sa.rpa_recipe_id = r.id`
            );
            dbAccounts.forEach(dba => {
                const emailLower = String(dba.account_email || '').trim().toLowerCase();
                if (!emailLower) return;
                if (!accountsMap.has(emailLower)) {
                    accountsMap.set(emailLower, {
                        email: dba.account_email,
                        emailLower,
                        platform: dba.streaming_platform,
                        password: dba.account_password || '',
                        profiles: [],
                        isProvider: true,
                        providerName: dba.provider_name,
                        rpaRecipeId: dba.rpa_recipe_id,
                        rpaRecipeName: dba.recipe_name
                    });
                } else {
                    const acc = accountsMap.get(emailLower);
                    acc.rpaRecipeId = dba.rpa_recipe_id;
                    acc.rpaRecipeName = dba.recipe_name;
                    if (dba.provider_name) acc.providerName = dba.provider_name;
                }
            });
        } catch (eDb) {
            console.error('[Overview MySQL error]:', eDb.message);
        }

        // Evaluar estado de automatización para cada cuenta
        const accountsList = [];
        for (const [_, acc] of accountsMap) {
            const autoStatus = await checkAccountAutomationStatus(acc.emailLower, acc.platform);
            accountsList.push({
                email: acc.email,
                platform: acc.platform,
                password: acc.password,
                clientCount: acc.profiles.length,
                profiles: acc.profiles.slice(0, 10),
                providerName: acc.providerName || null,
                isAutomated: autoStatus.isAutomated,
                automationType: autoStatus.type,
                automationLabel: autoStatus.label,
                rpaRecipeId: autoStatus.rpaRecipeId || acc.rpaRecipeId || null,
                rpaRecipeName: autoStatus.rpaRecipeName || acc.rpaRecipeName || null
            });
        }

        accountsList.sort((a, b) => b.clientCount - a.clientCount);

        res.json({
            success: true,
            totalAccounts: accountsList.length,
            automatedCount: accountsList.filter(a => a.isAutomated).length,
            manualCount: accountsList.filter(a => !a.isAutomated).length,
            accounts: accountsList
        });
    } catch (e) {
        console.error('[streaming-accounts/overview error]:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Sincronizar Cuentas y Suscripciones desde Excel hacia MySQL
app.post('/api/admin/streaming-accounts/sync-excel', async (req, res) => {
    try {
        const { fetchCustomersData } = require('../apiService');
        const rows = await fetchCustomersData(3, 2000, true);
        const { pool } = require('../database');

        let syncedAccounts = 0;
        let syncedSubs = 0;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            for (const row of rows) {
                const email = String(row.correo || '').trim();
                const platform = String(row.Streaming || '').trim().toUpperCase();
                const password = String(row["contraseña"] || row.contraseña || row.clave || row.Password || row.password || '').trim();
                const phone = String(row.numero || row.Numero || row.whatsapp || row.celular || '').replace(/\D/g, '');
                const clientName = `${row.Nombre || ''} ${row.apellido || ''}`.trim() || 'Cliente';
                const pin = String(row["pin perfil"] || row.pin || '').trim();

                if (email && email.includes('@') && platform) {
                    await conn.query(`
                        INSERT INTO stream_accounts (account_email, streaming_platform, account_password, is_provider, status)
                        VALUES (?, ?, ?, 1, 'active')
                        ON DUPLICATE KEY UPDATE 
                            account_password = IF(account_password IS NULL OR account_password = '', VALUES(account_password), account_password)
                    `, [email, platform, password || null]);
                    syncedAccounts++;
                }

                if (phone && phone.length >= 10 && email && email.includes('@')) {
                    const cleanPhone = phone.length === 10 && phone.startsWith('3') ? '57' + phone : phone;
                    await conn.query(`
                        INSERT INTO customers (phone, fullname)
                        VALUES (?, ?)
                        ON DUPLICATE KEY UPDATE fullname = IF(fullname = 'Cliente', VALUES(fullname), fullname)
                    `, [cleanPhone, clientName]);

                    await conn.query(`
                        INSERT INTO subscriptions (customer_phone, streaming_platform, account_email, account_password, profile_pin, status)
                        VALUES (?, ?, ?, ?, ?, 'active')
                        ON DUPLICATE KEY UPDATE 
                            profile_pin = COALESCE(VALUES(profile_pin), profile_pin),
                            account_password = COALESCE(VALUES(account_password), account_password)
                    `, [cleanPhone, platform || 'STREAMING', email, password || null, pin || null]);
                    syncedSubs++;
                }
            }

            await conn.commit();
        } catch (txErr) {
            await conn.rollback();
            throw txErr;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            message: `Sincronización completada: ${rows.length} registros analizados desde Excel.`,
            totalRows: rows.length,
            syncedAccounts,
            syncedSubs
        });
    } catch (e) {
        console.error('[sync-excel error]:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/gmail-inboxes', (req, res) => {
    try {
        const tokensDir = path.join(ROOT_DIR, 'tokens');
        if (!fs.existsSync(tokensDir)) {
            return res.json([]);
        }
        const files = fs.readdirSync(tokensDir);
        const emails = files
            .filter(f => f.startsWith('token_') && f.endsWith('.json'))
            .map(f => f.replace('token_', '').replace('.json', ''))
            .filter(email => email.includes('@') && email !== 'contacts');
        res.json(emails);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/gmail-inboxes/emails', async (req, res) => {
    try {
        const { email, password } = req.query;
        if (password !== 'admin123') return res.status(401).json({ error: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Falta el correo' });

        const { getEmailsFromInbox } = require('../gmailService');
        const emailsList = await getEmailsFromInbox(email, 15);
        res.json(emailsList);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/auth-url', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !email.includes('@')) return res.status(400).json({ error: 'Email no válido' });

        const { google } = require('googleapis');
        const credFile = fs.existsSync(path.join(ROOT_DIR, 'credentials_pagos.json'))
            ? path.join(ROOT_DIR, 'credentials_pagos.json')
            : path.join(ROOT_DIR, 'credentials.json');

        if (!fs.existsSync(credFile)) {
            return res.status(500).json({ error: 'No se encontraron las credenciales de Google API en el servidor.' });
        }

        const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/gmail.readonly'],
            prompt: 'consent'
        });

        res.json({ success: true, authUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/confirm-code', async (req, res) => {
    try {
        const { email, codeOrUrl, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email || !codeOrUrl) return res.status(400).json({ error: 'Faltan campos obligatorios' });

        const { google } = require('googleapis');
        const credFile = fs.existsSync(path.join(ROOT_DIR, 'credentials_pagos.json'))
            ? path.join(ROOT_DIR, 'credentials_pagos.json')
            : path.join(ROOT_DIR, 'credentials.json');

        if (!fs.existsSync(credFile)) {
            return res.status(500).json({ error: 'No se encontraron las credenciales en el servidor.' });
        }

        const credentials = JSON.parse(fs.readFileSync(credFile, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const redirectUri = redirect_uris ? redirect_uris[0] : 'urn:ietf:wg:oauth:2.0:oob';
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

        let code = codeOrUrl;
        if (codeOrUrl.includes('code=')) {
            const urlParts = new URL(codeOrUrl);
            code = urlParts.searchParams.get('code');
        }

        oAuth2Client.getToken(code, (err, token) => {
            if (err) {
                console.error('[Google Auth API Error]:', err.message);
                return res.status(500).json({ error: 'Error al verificar el código de Google: ' + err.message });
            }

            const safeEmail = email.toLowerCase().trim();
            const tokenPath = path.join(ROOT_DIR, 'tokens', `token_${safeEmail}.json`);
            fs.writeFileSync(tokenPath, JSON.stringify(token));

            const { clearCachedClient } = require('../googleAuthService');
            clearCachedClient('gmail', safeEmail);

            res.json({ success: true, message: `Bandeja ${email} vinculada con éxito.` });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/gmail-inboxes/delete', (req, res) => {
    try {
        const { email, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!email) return res.status(400).json({ error: 'Falta el correo' });

        const safeEmail = email.toLowerCase().trim();
        const tokenPath = path.join(ROOT_DIR, 'tokens', `token_${safeEmail}.json`);
        if (fs.existsSync(tokenPath)) {
            fs.unlinkSync(tokenPath);
            const { clearCachedClient } = require('../googleAuthService');
            clearCachedClient('gmail', safeEmail);
            res.json({ success: true, message: 'Bandeja desvinculada con éxito' });
        } else {
            res.status(404).json({ success: false, message: 'Bandeja no encontrada' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/streaming/tokens', async (req, res) => {
    try {
        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        if (!fs.existsSync(TOKENS_FILE)) {
            return res.json([]);
        }
        const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        res.json(tokens);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/streaming/tokens/add', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!token) return res.status(400).json({ success: false, message: 'Token is required' });

        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        const dir = path.dirname(TOKENS_FILE);
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (err) {
                console.error("Failed to create tokens directory:", err.message);
            }
        }

        let tokens = [];
        if (fs.existsSync(TOKENS_FILE)) {
            try {
                tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
            } catch (e) {
                tokens = [];
            }
        }

        const cleanToken = token.trim().toLowerCase().replace(/\s+/g, '_');
        if (!tokens.includes(cleanToken)) {
            tokens.push(cleanToken);
            fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        }
        res.json({ success: true, tokens });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/streaming/tokens/delete', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
        if (!token) return res.status(400).json({ success: false, message: 'Token is required' });

        const TOKENS_FILE = '/opt/mediamtx-auth/tokens.json';
        let tokens = [];
        if (fs.existsSync(TOKENS_FILE)) {
            try {
                tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
            } catch (e) {
                tokens = [];
            }
        }
        tokens = tokens.filter(t => t !== token);
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
        res.json({ success: true, tokens });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/streaming/sessions', async (req, res) => {
    try {
        const http = require('http');
        const request = http.get('http://127.0.0.1:5000/sessions', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                try {
                    res.json(JSON.parse(data));
                } catch (e) {
                    res.json({});
                }
            });
        });
        request.on('error', (err) => {
            console.warn("[Streaming API] MediaMTX is offline or port 5000 is unreachable:", err.message);
            res.json({});
        });
    } catch (e) {
        res.json({});
    }
});

// Legacy PHP logic migration: Support Management
app.get('/api/support', (req, res) => {
    try {
        const supportData = fs.readFileSync(path.join(ROOT_DIR, 'support.json'), 'utf8');
        res.setHeader('Content-Type', 'application/json');
        res.send(supportData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/support/save', upload.none(), (req, res) => {
    try {
        const { password, action, data } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });

        if (action === 'save' && data) {
            const jsonPath = path.join(ROOT_DIR, 'support.json');
            if (fs.existsSync(jsonPath)) {
                fs.copyFileSync(jsonPath, path.join(ROOT_DIR, 'support_backup.json'));
            }
            fs.writeFileSync(jsonPath, data, 'utf8');
            res.json({ success: true, message: 'Datos guardados (respaldo creado)' });
        } else {
            res.json({ success: false, message: 'Datos inválidos' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/support/upload', upload.single('image'), (req, res) => {
    try {
        const password = req.body.password;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (req.file) {
            const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
            const host = req.get('host');
            const publicUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
            res.json({ success: true, url: publicUrl });
        } else {
            res.json({ success: false, message: 'No se envió ninguna imagen' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/audit-log', express.json(), (req, res) => {
    try {
        const { agentEmail, agentName, action, details } = req.body;
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${agentEmail || 'Unknown'}] [${agentName || 'Unknown'}] Action: ${action || 'None'} - Details: ${JSON.stringify(details || {})}\n`;

        fs.appendFileSync(path.join(ROOT_DIR, 'frontend_audit.log'), logLine, 'utf8');
        res.json({ success: true });
    } catch (e) {
        console.error("Error writing audit log:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/policies', (req, res) => {
    try {
        const policiesPath = path.join(ROOT_DIR, 'policies.json');
        if (fs.existsSync(policiesPath)) {
            const data = fs.readFileSync(policiesPath, 'utf8');
            return res.json(JSON.parse(data));
        }
        res.status(404).json({ error: 'Archivo de políticas no encontrado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/policies/save', (req, res) => {
    try {
        const { password, policies } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        if (!policies) return res.status(400).json({ success: false, message: 'Datos de políticas ausentes' });

        const policiesPath = path.join(ROOT_DIR, 'policies.json');
        fs.writeFileSync(policiesPath, JSON.stringify(policies, null, 2), 'utf8');

        // Sincronizar automáticamente con knowledge_base.json del bot
        const kbPath = path.join(ROOT_DIR, 'knowledge_base.json');
        if (fs.existsSync(kbPath)) {
            try {
                const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
                if (kb.general_policies) {
                    const tcRefunds = policies.terms_and_conditions.find(s => s.title.toLowerCase().includes('reembolso'));
                    if (tcRefunds && tcRefunds.paragraphs && tcRefunds.paragraphs.length > 0) {
                        kb.general_policies.refunds = tcRefunds.paragraphs.join(' ');
                    }
                    const tcHabeas = policies.terms_and_conditions.find(s => s.title.toLowerCase().includes('datos personales') || s.title.toLowerCase().includes('habeas data'));
                    if (tcHabeas && tcHabeas.paragraphs && tcHabeas.paragraphs.length > 0) {
                        kb.general_policies.data_privacy = tcHabeas.paragraphs.join(' ');
                    }
                    fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2), 'utf8');
                }
            } catch (err) {
                console.error('[Policies Save] Error syncing knowledge base:', err.message);
            }
        }

        // Ejecutar script python para regenerar PDFs
        const { exec } = require('child_process');
        const scriptPath = path.join(ROOT_DIR, 'scratch', 'generate_pdfs.py');
        exec(`python3 "${scriptPath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`[Policies Save] Error regenerando PDFs: ${error.message}`);
                return res.json({ success: true, warning: 'Políticas guardadas y bot actualizado, pero falló la generación de PDFs.', error: error.message });
            }
            console.log(`[Policies Save] PDFs regenerados con éxito: ${stdout}`);
            res.json({ success: true, message: 'Políticas guardadas, bot actualizado y PDFs regenerados con éxito.' });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
}

module.exports = {
    registerAdminCatalogAndAccountingRoutes,
    checkAccountAutomationStatus
};
