const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../database');
const { hashPassword, signSessionToken, verifySessionToken } = require('../authService');
const elevenLabsService = require('../services/elevenLabsService');
const saasBotManager = require('../services/saasBotManager');

function toCleanSlug(text) {
  const base = String(text || '')
    .toLowerCase()
    .trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `bot-${crypto.randomBytes(3).toString('hex')}`;
}

async function resolveUniqueSlug(businessName) {
  const base = toCleanSlug(businessName);
  const [existing] = await pool.query('SELECT id FROM saas_bot_tenants WHERE slug = ? LIMIT 1', [base]);
  if (existing.length === 0) return base;
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

function requireSaasTenant(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== 'saas_bot' || !payload.tenantId) {
    return res.status(401).json({ success: false, message: 'Sesión expirada o no autorizada.' });
  }
  req.tenantId = Number(payload.tenantId);
  next();
}

function registerSaasBotRoutes(app) {
  // Inicialización diferida segura al primer tráfico o arranque
  saasBotManager.ensureSaasBotTables().catch(err => {
    console.warn('[SaaS Bot Routes] Error inicializando tablas:', err.message);
  });

  // Registro público de cliente Bot SaaS
  app.post('/api/saas-bot/register', express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const {
        ownerName,
        businessName,
        email,
        password,
        businessDescription = ''
      } = req.body || {};

      const cleanOwner = String(ownerName || '').trim();
      const cleanBiz = String(businessName || '').trim();
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPass = String(password || '').trim();

      if (!cleanOwner || !cleanBiz || !cleanEmail || cleanPass.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Nombre, negocio, correo y contraseña (mínimo 6 caracteres) son obligatorios.'
        });
      }

      const [dup] = await pool.query('SELECT id FROM saas_bot_tenants WHERE email = ? LIMIT 1', [cleanEmail]);
      if (dup.length > 0) {
        return res.status(409).json({ success: false, message: 'Ya existe una cuenta registrada con ese correo.' });
      }

      const slug = await resolveUniqueSlug(cleanBiz);
      const passwordHash = await hashPassword(cleanPass);
      const monthKey = saasBotManager.getCurrentMonthKey();

      const [result] = await pool.query(
        `INSERT INTO saas_bot_tenants
         (slug, owner_name, business_name, email, password_hash, plan_name, monthly_message_limit, usage_reset_month, business_description)
         VALUES (?, ?, ?, ?, ?, 'Plan Básico 30K', 500, ?, ?)`,
        [slug, cleanOwner, cleanBiz, cleanEmail, passwordHash, monthKey, String(businessDescription || '').trim()]
      );

      const tenant = await saasBotManager.getTenantById(result.insertId);
      const token = signSessionToken({ role: 'saas_bot', tenantId: tenant.id, email: tenant.email });

      res.json({
        success: true,
        token,
        tenant: saasBotManager.sanitizeTenant(tenant)
      });
    } catch (err) {
      console.error('[SaaS Bot Register Error]:', err.message);
      res.status(500).json({ success: false, message: 'Error creando cuenta del bot.' });
    }
  });

  // Login de cliente Bot SaaS
  app.post('/api/saas-bot/login', express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
      const cleanPass = String(req.body?.password || '').trim();

      if (!cleanEmail || !cleanPass) {
        return res.status(400).json({ success: false, message: 'Ingresa correo y contraseña.' });
      }

      const [rows] = await pool.query('SELECT * FROM saas_bot_tenants WHERE email = ? LIMIT 1', [cleanEmail]);
      if (rows.length === 0) {
        return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos.' });
      }

      const row = rows[0];
      const match = await bcrypt.compare(cleanPass, row.password_hash);
      if (!match) {
        return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos.' });
      }

      const tenant = await saasBotManager.getTenantById(row.id);
      const token = signSessionToken({ role: 'saas_bot', tenantId: tenant.id, email: tenant.email });

      res.json({
        success: true,
        token,
        tenant: saasBotManager.sanitizeTenant(tenant)
      });
    } catch (err) {
      console.error('[SaaS Bot Login Error]:', err.message);
      res.status(500).json({ success: false, message: 'Error al iniciar sesión.' });
    }
  });

  // Perfil completo, consumo y logs recientes
  app.get('/api/saas-bot/me', requireSaasTenant, async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }
      const [logs] = await pool.query(
        'SELECT id, customer_jid, direction, message_type, body, created_at FROM saas_bot_messages_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 25',
        [tenant.id]
      );
      res.json({
        success: true,
        tenant: saasBotManager.sanitizeTenant(tenant),
        session: saasBotManager.getTenantSessionState(tenant.id),
        logs
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Conectar sesión WhatsApp y generar QR
  app.post('/api/saas-bot/whatsapp/connect', requireSaasTenant, async (req, res) => {
    try {
      const session = await saasBotManager.startTenantSession(req.tenantId);
      res.json({ success: true, session });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/saas-bot/whatsapp/status', requireSaasTenant, async (req, res) => {
    try {
      const session = saasBotManager.getTenantSessionState(req.tenantId);
      res.json({ success: true, session });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/whatsapp/disconnect', requireSaasTenant, async (req, res) => {
    try {
      const session = await saasBotManager.disconnectTenantSession(req.tenantId);
      res.json({ success: true, session });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Generador automático de prompt y base de conocimiento con IA
  app.post('/api/saas-bot/generate-config', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }
      const {
        businessName = tenant.business_name,
        businessDescription = tenant.business_description,
        productsOrServices = '',
        tone = tenant.bot_tone || 'amigable'
      } = req.body || {};

      if (!String(businessDescription || '').trim() && !String(productsOrServices || '').trim()) {
        return res.status(400).json({ success: false, message: 'Describe brevemente tu negocio o productos para generarlo automáticamente.' });
      }

      const generated = await saasBotManager.generateSaasBotConfig({
        businessName,
        businessDescription,
        productsOrServices,
        tone
      });

      res.json({ success: true, ...generated });
    } catch (err) {
      console.error('[SaaS Bot Generate Config Error]:', err.message);
      res.status(500).json({ success: false, message: err.message || 'No se pudo generar la configuración.' });
    }
  });

  // Guardar configuración del bot y de ElevenLabs
  app.put('/api/saas-bot/config', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }

      const b = req.body || {};
      const nextApiKey = b.clear_elevenlabs_key
        ? null
        : (b.elevenlabs_api_key && String(b.elevenlabs_api_key).trim() && !String(b.elevenlabs_api_key).includes('...')
            ? String(b.elevenlabs_api_key).trim()
            : tenant.elevenlabs_api_key);

      await pool.query(
        `UPDATE saas_bot_tenants SET
          business_name = ?,
          business_description = ?,
          system_prompt = ?,
          knowledge_base = ?,
          bot_tone = ?,
          is_bot_active = ?,
          elevenlabs_enabled = ?,
          elevenlabs_api_key = ?,
          elevenlabs_voice_id = ?,
          elevenlabs_model_id = ?,
          reply_mode = ?
         WHERE id = ?`,
        [
          b.business_name !== undefined ? String(b.business_name).trim() : tenant.business_name,
          b.business_description !== undefined ? String(b.business_description) : tenant.business_description,
          b.system_prompt !== undefined ? String(b.system_prompt) : tenant.system_prompt,
          b.knowledge_base !== undefined ? String(b.knowledge_base) : tenant.knowledge_base,
          b.bot_tone !== undefined ? String(b.bot_tone) : tenant.bot_tone,
          b.is_bot_active !== undefined ? (b.is_bot_active ? 1 : 0) : tenant.is_bot_active,
          b.elevenlabs_enabled !== undefined ? (b.elevenlabs_enabled ? 1 : 0) : tenant.elevenlabs_enabled,
          nextApiKey,
          b.elevenlabs_voice_id !== undefined ? String(b.elevenlabs_voice_id || '').trim() : tenant.elevenlabs_voice_id,
          b.elevenlabs_model_id !== undefined ? String(b.elevenlabs_model_id || 'eleven_multilingual_v2').trim() : tenant.elevenlabs_model_id,
          b.reply_mode !== undefined ? String(b.reply_mode || 'text') : tenant.reply_mode,
          tenant.id
        ]
      );

      const updated = await saasBotManager.getTenantById(tenant.id);
      res.json({ success: true, tenant: saasBotManager.sanitizeTenant(updated) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Listar voces disponibles de ElevenLabs
  app.post('/api/saas-bot/elevenlabs/voices', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      const rawKey = String(req.body?.apiKey || '').trim();
      const apiKey = (rawKey && !rawKey.includes('...')) ? rawKey : tenant?.elevenlabs_api_key;

      if (!apiKey) {
        return res.status(400).json({ success: false, message: 'Ingresa tu API Key de ElevenLabs primero.' });
      }

      const voices = await elevenLabsService.listVoices(apiKey);
      res.json({ success: true, voices });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // Unir múltiples segmentos de ElevenLabs en 1 solo MP3 y enviarlo opcionalmente por WhatsApp
  app.post('/api/saas-bot/elevenlabs/merge', requireSaasTenant, express.json({ limit: '5mb' }), async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }

      const rawKey = String(req.body?.apiKey || '').trim();
      const apiKey = (rawKey && !rawKey.includes('...')) ? rawKey : tenant.elevenlabs_api_key;
      const defaultVoiceId = String(req.body?.defaultVoiceId || tenant.elevenlabs_voice_id || '').trim();
      const modelId = String(req.body?.modelId || tenant.elevenlabs_model_id || 'eleven_multilingual_v2').trim();
      const pauseMs = req.body?.pauseMs !== undefined ? Number(req.body.pauseMs) : 300;
      const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
      const sendToPhone = String(req.body?.sendToPhone || '').trim();

      const result = await elevenLabsService.mergeElevenLabsSegments(segments, {
        apiKey,
        defaultVoiceId,
        modelId,
        pauseMs
      });

      let sentToWhatsApp = false;
      if (sendToPhone) {
        await saasBotManager.sendTenantAudioOrText(tenant.id, sendToPhone, {
          oggBuffer: result.oggBuffer,
          text: `Audio unido (${result.segmentsCount} segmentos)`
        });
        sentToWhatsApp = true;
      }

      res.json({
        success: true,
        audioBase64: result.mp3Buffer.toString('base64'),
        mimeType: 'audio/mpeg',
        segmentsCount: result.segmentsCount,
        totalChars: result.totalChars,
        sentToWhatsApp
      });
    } catch (err) {
      console.error('[SaaS Bot Merge Error]:', err.message);
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // Endpoints administrativos para crear/listar clientes SaaS
  app.get('/api/admin/saas-bots', async (req, res) => {
    try {
      const pwd = req.headers['x-admin-password'] || req.query.password;
      if (pwd !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });
      await saasBotManager.ensureSaasBotTables();
      const [rows] = await pool.query('SELECT * FROM saas_bot_tenants ORDER BY id DESC');
      res.json({
        success: true,
        tenants: rows.map(r => ({
          ...saasBotManager.sanitizeTenant(r),
          liveSession: saasBotManager.getTenantSessionState(r.id)
        }))
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/admin/saas-bots/create', express.json(), async (req, res) => {
    try {
      const { password: adminPwd, ownerName, businessName, email, clientPassword, planName = 'Plan Básico 30K', monthlyLimit = 500, businessDescription = '' } = req.body || {};
      if (adminPwd !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

      await saasBotManager.ensureSaasBotTables();
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPass = String(clientPassword || '').trim();
      if (!ownerName || !businessName || !cleanEmail || cleanPass.length < 6) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios o contraseña < 6 chars.' });
      }

      const slug = await resolveUniqueSlug(businessName);
      const passwordHash = await hashPassword(cleanPass);
      const monthKey = saasBotManager.getCurrentMonthKey();

      const [result] = await pool.query(
        `INSERT INTO saas_bot_tenants
         (slug, owner_name, business_name, email, password_hash, plan_name, monthly_message_limit, usage_reset_month, business_description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [slug, String(ownerName).trim(), String(businessName).trim(), cleanEmail, passwordHash, planName, Number(monthlyLimit) || 500, monthKey, String(businessDescription || '').trim()]
      );

      const tenant = await saasBotManager.getTenantById(result.insertId);
      res.json({ success: true, tenant: saasBotManager.sanitizeTenant(tenant) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

module.exports = { registerSaasBotRoutes };
