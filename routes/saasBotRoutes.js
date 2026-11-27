const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { pool } = require('../database');
const { hashPassword, signSessionToken, verifySessionToken } = require('../authService');
const elevenLabsService = require('../services/elevenLabsService');
const saasBotManager = require('../services/saasBotManager');

const AUDIO_UPLOADS_ROOT = path.join(__dirname, '..', 'uploads', 'saas_audios');
const AUDIO_TMP_DIR = path.join(AUDIO_UPLOADS_ROOT, 'tmp');
if (!fs.existsSync(AUDIO_TMP_DIR)) {
  fs.mkdirSync(AUDIO_TMP_DIR, { recursive: true });
}

const audioUpload = multer({
  dest: AUDIO_TMP_DIR,
  limits: { fileSize: 15 * 1024 * 1024 }
});

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
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = headerToken || String(req.query?.token || '').trim();
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== 'saas_bot' || !payload.tenantId) {
    return res.status(401).json({ success: false, message: 'Sesión expirada o no autorizada.' });
  }
  req.tenantId = Number(payload.tenantId);
  next();
}

function generateRandomInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pickBlock = (len) => Array.from(crypto.randomBytes(len), (b) => alphabet[b % alphabet.length]).join('');
  return `SH-${pickBlock(4)}-${pickBlock(4)}`;
}

function registerSaasBotRoutes(app, routeContext = {}) {
  // Inicialización diferida segura al primer tráfico o arranque
  saasBotManager.ensureSaasBotTables().catch(err => {
    console.warn('[SaaS Bot Routes] Error inicializando tablas:', err.message);
  });

  // Registro público de cliente Bot SaaS
  app.post('/api/saas-bot/register', express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const {
        activationCode,
        ownerName,
        businessName,
        email,
        password,
        businessDescription = ''
      } = req.body || {};

      const cleanCode = String(activationCode || '').trim().toUpperCase();
      const cleanOwner = String(ownerName || '').trim();
      const cleanBiz = String(businessName || '').trim();
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPass = String(password || '').trim();

      if (!cleanCode) {
        return res.status(400).json({
          success: false,
          message: 'Necesitas un código de activación válido para crear tu cuenta. Solicítalo a tu asesor Sheerit.'
        });
      }

      if (!cleanOwner || !cleanBiz || !cleanEmail || cleanPass.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Nombre, negocio, correo y contraseña (mínimo 6 caracteres) son obligatorios.'
        });
      }

      const [inviteRows] = await pool.query(
        'SELECT * FROM saas_bot_invite_codes WHERE code = ? LIMIT 1',
        [cleanCode]
      );
      if (inviteRows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'Código de activación inválido. Verifica que esté bien escrito.'
        });
      }
      const invite = inviteRows[0];
      if (invite.used_by_tenant_id) {
        return res.status(409).json({
          success: false,
          message: 'Este código de activación ya fue utilizado.'
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
         (slug, owner_name, business_name, email, password_hash, plan_name, monthly_message_limit, amount_paid, expires_at, usage_reset_month, business_description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
        [
          slug,
          cleanOwner,
          cleanBiz,
          cleanEmail,
          passwordHash,
          invite.plan_name || 'Plan Básico 30K',
          Number(invite.monthly_message_limit) || 500,
          Number(invite.amount_paid) || 0,
          Number(invite.duration_days) || 30,
          monthKey,
          String(businessDescription || '').trim()
        ]
      );

      await pool.query(
        'UPDATE saas_bot_invite_codes SET used_by_tenant_id = ?, used_at = NOW() WHERE id = ? AND used_by_tenant_id IS NULL',
        [result.insertId, invite.id]
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

  // Perfil completo, consumo, logs recientes y ajustes de mejora
  app.get('/api/saas-bot/me', requireSaasTenant, async (req, res) => {
    try {
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }
      const [rawLogs] = await pool.query(
        'SELECT id, customer_jid, direction, message_type, body, decision_meta, created_at FROM saas_bot_messages_log WHERE tenant_id = ? ORDER BY id DESC LIMIT 40',
        [tenant.id]
      );
      const logs = rawLogs.map(l => ({
        ...l,
        decision_meta: saasBotManager.parseDecisionMeta(l.decision_meta)
      }));
      const [improvements] = await pool.query(
        `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
                explanation_plain, scope, practical_proposal, proposed_prompt_addition,
                proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
         FROM saas_bot_improvements
         WHERE tenant_id = ?
         ORDER BY id DESC
         LIMIT 40`,
        [tenant.id]
      );
      res.json({
        success: true,
        tenant: saasBotManager.sanitizeTenant(tenant),
        session: saasBotManager.getTenantSessionState(tenant.id),
        logs,
        improvements
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Historial paginado con búsqueda
  app.get('/api/saas-bot/logs', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const limit = Math.min(100, Math.max(10, Number(req.query?.limit) || 40));
      const beforeId = Number(req.query?.beforeId) || 0;
      const search = String(req.query?.search || '').trim();

      const params = [req.tenantId];
      let whereSql = 'WHERE tenant_id = ?';
      if (beforeId > 0) {
        whereSql += ' AND id < ?';
        params.push(beforeId);
      }
      if (search) {
        whereSql += ' AND (body LIKE ? OR customer_jid LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }

      params.push(limit + 1);
      const [rows] = await pool.query(
        `SELECT id, customer_jid, direction, message_type, body, decision_meta, created_at
         FROM saas_bot_messages_log
         ${whereSql}
         ORDER BY id DESC
         LIMIT ?`,
        params
      );

      const hasMore = rows.length > limit;
      const sliced = (hasMore ? rows.slice(0, limit) : rows).map(l => ({
        ...l,
        decision_meta: saasBotManager.parseDecisionMeta(l.decision_meta)
      }));
      const nextBeforeId = sliced.length > 0 ? sliced[sliced.length - 1].id : null;

      res.json({ success: true, logs: sliced, hasMore, nextBeforeId });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Listar ajustes de mejora del cliente (sin exponer campos técnicos internos)
  app.get('/api/saas-bot/improvements', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const [improvements] = await pool.query(
        `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
                explanation_plain, scope, practical_proposal, proposed_prompt_addition,
                proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
         FROM saas_bot_improvements
         WHERE tenant_id = ?
         ORDER BY id DESC
         LIMIT 50`,
        [req.tenantId]
      );
      res.json({ success: true, improvements });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Crear consulta o ajuste de mejora conectado a agy + reporte previo a Sheerit General
  app.post('/api/saas-bot/improvements', requireSaasTenant, express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const tenant = await saasBotManager.getTenantById(req.tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cuenta no encontrada.' });
      }

      const clientQuestion = String(req.body?.clientQuestion || '').trim();
      const messageLogId = req.body?.messageLogId ? Number(req.body.messageLogId) : null;
      if (clientQuestion.length < 4) {
        return res.status(400).json({ success: false, message: 'Cuéntanos brevemente qué quieres entender o mejorar.' });
      }

      let messageLog = null;
      let previousInMsg = null;
      if (messageLogId) {
        const [msgRows] = await pool.query(
          'SELECT id, customer_jid, direction, message_type, body, decision_meta, created_at FROM saas_bot_messages_log WHERE id = ? AND tenant_id = ? LIMIT 1',
          [messageLogId, tenant.id]
        );
        if (msgRows.length > 0) {
          messageLog = {
            ...msgRows[0],
            decision_meta: saasBotManager.parseDecisionMeta(msgRows[0].decision_meta)
          };
          const [inRows] = await pool.query(
            `SELECT id, body, created_at FROM saas_bot_messages_log
             WHERE tenant_id = ? AND customer_jid = ? AND direction = 'in' AND id < ?
             ORDER BY id DESC LIMIT 1`,
            [tenant.id, messageLog.customer_jid, messageLog.id]
          );
          if (inRows.length > 0) previousInMsg = inRows[0];
        }
      }

      const [activeAudios] = await pool.query(
        'SELECT id, title, trigger_description, duration_sec FROM saas_bot_audios WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
        [tenant.id]
      );

      const analysis = await saasBotManager.analyzeTenantImprovement(tenant, {
        messageLog,
        previousInMsg,
        activeAudios,
        clientQuestion
      });

      const [ins] = await pool.query(
        `INSERT INTO saas_bot_improvements
         (tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
          explanation_plain, scope, practical_proposal, proposed_prompt_addition,
          proposed_audio_id, proposed_audio_trigger, technical_summary, agy_conversation_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
        [
          tenant.id,
          messageLog ? messageLog.id : null,
          messageLog ? messageLog.customer_jid : null,
          previousInMsg ? previousInMsg.body : null,
          messageLog ? messageLog.body : null,
          clientQuestion,
          analysis.explanation_plain,
          analysis.scope,
          analysis.practical_proposal,
          analysis.proposed_prompt_addition || null,
          analysis.proposed_audio_id || null,
          analysis.proposed_audio_trigger || null,
          analysis.technical_summary || null,
          analysis.agy_conversation_id || null
        ]
      );

      const [savedRows] = await pool.query(
        `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
                explanation_plain, scope, practical_proposal, proposed_prompt_addition,
                proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
         FROM saas_bot_improvements WHERE id = ? LIMIT 1`,
        [ins.insertId]
      );
      const improvement = savedRows[0];

      // Notificar a Sheerit General en segundo plano para decidir si queda en capa cliente o escala a Errors bot
      const waClient = typeof routeContext?.getClient === 'function' ? routeContext.getClient() : null;
      if (waClient && typeof waClient.sendMessage === 'function') {
        const scopeLabel = analysis.scope === 'core_engine'
          ? '🔴 CLASE MADRE (motor global)'
          : '🟡 CAPA CLIENTE (solo su bot)';
        const reportMsg =
          `✨ *[AJUSTE DE MEJORA BOT SAAS #${improvement.id}]*\n\n` +
          `🏢 *Negocio:* ${tenant.business_name} (${tenant.owner_name})\n` +
          `🏷️ *Clasificación IA (agy):* ${scopeLabel}\n` +
          `💬 *Consulta del cliente:* "${clientQuestion}"\n` +
          (previousInMsg?.body ? `📥 *Cliente final preguntó:* "${String(previousInMsg.body).slice(0, 180)}"\n` : '') +
          (messageLog?.body ? `🤖 *Bot respondió:* "${String(messageLog.body).slice(0, 180)}"\n` : '') +
          `\n💡 *Propuesta práctica:* ${analysis.practical_proposal}\n` +
          `⚙️ *Resumen técnico:* ${analysis.technical_summary || 'Ajuste de configuración en capa cliente.'}\n\n` +
          `👉 Si aplica para mejora global del motor, escribe aquí:\n*@escalar-madre #${improvement.id}*`;
        waClient.sendMessage('120363102144405222@g.us', reportMsg, { sendSeen: false }).catch(e => {
          console.warn('[SaaS Improvement] No se pudo enviar aviso a Sheerit General:', e.message);
        });
      }

      res.json({ success: true, improvement });
    } catch (err) {
      console.error('[SaaS Improvement Create Error]:', err.message);
      res.status(500).json({ success: false, message: err.message || 'No se pudo analizar el ajuste.' });
    }
  });

  app.post('/api/saas-bot/improvements/:id/accept', requireSaasTenant, async (req, res) => {
    try {
      const result = await saasBotManager.acceptTenantImprovement(req.tenantId, Number(req.params.id));
      res.json({
        success: true,
        improvement: result.improvement
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/improvements/:id/apply', requireSaasTenant, async (req, res) => {
    try {
      const waClient = typeof routeContext?.getClient === 'function' ? routeContext.getClient() : null;
      const result = await saasBotManager.applyTenantImprovement(req.tenantId, Number(req.params.id), { waClient });
      res.json({
        success: true,
        improvement: result.improvement,
        tenant: result.tenant ? saasBotManager.sanitizeTenant(result.tenant) : undefined,
        queuedForRestart: Boolean(result.queuedForRestart)
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/improvements/:id/revert', requireSaasTenant, async (req, res) => {
    try {
      const result = await saasBotManager.revertTenantImprovement(req.tenantId, Number(req.params.id));
      res.json({
        success: true,
        improvement: result.improvement,
        tenant: saasBotManager.sanitizeTenant(result.tenant)
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/improvements/:id/dismiss', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      await pool.query(
        "UPDATE saas_bot_improvements SET status = 'dismissed' WHERE id = ? AND tenant_id = ? AND status IN ('proposed', 'accepted')",
        [Number(req.params.id), req.tenantId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
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

  // Vincular WhatsApp por código numérico de 8 dígitos (pairing code)
  app.post('/api/saas-bot/whatsapp/pairing-code', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const phone = String(req.body?.phone || '').trim();
      if (!phone) {
        return res.status(400).json({ success: false, message: 'Ingresa tu número de WhatsApp (ej. 3001234567).' });
      }
      const result = await saasBotManager.requestTenantPairingCode(req.tenantId, phone);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
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

      const nextPauseMins = b.human_pause_minutes !== undefined
        ? Math.min(1440, Math.max(0, Number(b.human_pause_minutes) || 0))
        : (tenant.human_pause_minutes ?? 30);

      await pool.query(
        `UPDATE saas_bot_tenants SET
          business_name = ?,
          business_description = ?,
          system_prompt = ?,
          knowledge_base = ?,
          bot_tone = ?,
          is_bot_active = ?,
          human_pause_minutes = ?,
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
          nextPauseMins,
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

  // ==================== BIBLIOTECA DE AUDIOS PREGRABADOS + FLUJOS (IMAGEN/TEXTO) ====================
  app.get('/api/saas-bot/audios', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const [rows] = await pool.query(
        `SELECT id, tenant_id, title, trigger_description, original_filename,
                image_filename, followup_text, (image_path IS NOT NULL AND image_path <> '') AS has_image,
                duration_sec, is_active, created_at
         FROM saas_bot_audios
         WHERE tenant_id = ?
         ORDER BY id ASC`,
        [req.tenantId]
      );
      res.json({ success: true, audios: rows });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/audios/upload', requireSaasTenant, audioUpload.fields([{ name: 'audio', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
    const audioFile = req.files?.audio?.[0] || null;
    const imageFile = req.files?.image?.[0] || null;
    const tmpAudio = audioFile ? audioFile.path : null;
    const tmpImage = imageFile ? imageFile.path : null;
    try {
      await saasBotManager.ensureSaasBotTables();
      if (!audioFile) {
        return res.status(400).json({ success: false, message: 'Debes adjuntar un archivo de audio.' });
      }
      const title = String(req.body?.title || '').trim();
      const triggerDesc = String(req.body?.trigger_description || '').trim();
      const followupText = String(req.body?.followup_text || '').trim() || null;
      if (!title || !triggerDesc) {
        return res.status(400).json({ success: false, message: 'Indica el título del audio y cuándo debe enviarlo el bot.' });
      }

      const tenantDir = path.join(AUDIO_UPLOADS_ROOT, `tenant_${req.tenantId}`);
      fs.mkdirSync(tenantDir, { recursive: true });
      const finalPath = path.join(tenantDir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.mp3`);

      const durationSec = await elevenLabsService.normalizeUploadedAudioToMp3(tmpAudio, finalPath);

      let finalImagePath = null;
      let originalImageName = null;
      if (imageFile && tmpImage && fs.existsSync(tmpImage)) {
        const ext = (path.extname(imageFile.originalname || '.jpg') || '.jpg').toLowerCase().slice(0, 10);
        finalImagePath = path.join(tenantDir, `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
        fs.copyFileSync(tmpImage, finalImagePath);
        originalImageName = imageFile.originalname || `imagen${ext}`;
      }

      const [ins] = await pool.query(
        `INSERT INTO saas_bot_audios
         (tenant_id, title, trigger_description, file_path, original_filename, image_path, image_filename, followup_text, duration_sec, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [req.tenantId, title, triggerDesc, finalPath, audioFile.originalname || 'audio.mp3', finalImagePath, originalImageName, followupText, durationSec]
      );

      const [[created]] = await pool.query(
        `SELECT id, tenant_id, title, trigger_description, original_filename,
                image_filename, followup_text, (image_path IS NOT NULL AND image_path <> '') AS has_image,
                duration_sec, is_active, created_at
         FROM saas_bot_audios WHERE id = ?`,
        [ins.insertId]
      );
      res.json({ success: true, audio: created });
    } catch (err) {
      console.error('[SaaS Audio Upload Error]:', err.message);
      res.status(400).json({ success: false, message: err.message || 'No se pudo procesar el archivo.' });
    } finally {
      for (const f of [tmpAudio, tmpImage]) {
        if (f) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
        }
      }
    }
  });

  app.put('/api/saas-bot/audios/:id', requireSaasTenant, express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const audioId = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT * FROM saas_bot_audios WHERE id = ? AND tenant_id = ? LIMIT 1', [audioId, req.tenantId]);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Audio no encontrado.' });
      }

      const b = req.body || {};
      await pool.query(
        'UPDATE saas_bot_audios SET title = ?, trigger_description = ?, followup_text = ?, is_active = ? WHERE id = ? AND tenant_id = ?',
        [
          b.title !== undefined ? String(b.title).trim() : existing.title,
          b.trigger_description !== undefined ? String(b.trigger_description).trim() : existing.trigger_description,
          b.followup_text !== undefined ? (String(b.followup_text).trim() || null) : existing.followup_text,
          b.is_active !== undefined ? (b.is_active ? 1 : 0) : existing.is_active,
          audioId,
          req.tenantId
        ]
      );

      const [[updated]] = await pool.query(
        `SELECT id, tenant_id, title, trigger_description, original_filename,
                image_filename, followup_text, (image_path IS NOT NULL AND image_path <> '') AS has_image,
                duration_sec, is_active, created_at
         FROM saas_bot_audios WHERE id = ?`,
        [audioId]
      );
      res.json({ success: true, audio: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.delete('/api/saas-bot/audios/:id', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const audioId = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT file_path, image_path FROM saas_bot_audios WHERE id = ? AND tenant_id = ? LIMIT 1', [audioId, req.tenantId]);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Audio no encontrado.' });
      }
      await pool.query('DELETE FROM saas_bot_audios WHERE id = ? AND tenant_id = ?', [audioId, req.tenantId]);
      for (const p of [existing.file_path, existing.image_path]) {
        if (p) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
        }
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/saas-bot/audios/:id/image', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const audioId = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT image_path FROM saas_bot_audios WHERE id = ? AND tenant_id = ? LIMIT 1', [audioId, req.tenantId]);
      if (!existing || !existing.image_path || !fs.existsSync(existing.image_path)) {
        return res.status(404).json({ success: false, message: 'Imagen no encontrada.' });
      }
      return res.sendFile(path.resolve(existing.image_path));
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  // ==================== CHATS EN VIVO & CONTROL MANUAL (MODO SEMIAUTOMÁTICO) ====================
  app.get('/api/saas-bot/chats', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const [rows] = await pool.query(
        `SELECT l.customer_jid AS chatId, l.body AS lastBody, l.direction AS lastDirection,
                l.message_type AS lastType, l.created_at AS lastAt
         FROM saas_bot_messages_log l
         INNER JOIN (
           SELECT MAX(id) AS max_id
           FROM saas_bot_messages_log
           WHERE tenant_id = ?
           GROUP BY customer_jid
         ) latest ON l.id = latest.max_id
         ORDER BY l.id DESC
         LIMIT 35`,
        [req.tenantId]
      );

      const chats = rows.map(r => {
        const pauseState = saasBotManager.getChatPauseState(req.tenantId, r.chatId);
        return {
          ...r,
          phone: String(r.chatId || '').replace(/@.*/, ''),
          isPaused: pauseState.isPaused,
          pausedUntil: pauseState.pausedUntil,
          pauseReason: pauseState.reason
        };
      });
      res.json({ success: true, chats });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.get('/api/saas-bot/chats/:chatId/messages', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const chatId = decodeURIComponent(String(req.params.chatId || ''));
      const [rows] = await pool.query(
        `SELECT id, customer_jid, direction, message_type, body, decision_meta, created_at
         FROM saas_bot_messages_log
         WHERE tenant_id = ? AND customer_jid = ?
         ORDER BY id DESC
         LIMIT 50`,
        [req.tenantId, chatId]
      );
      const messages = rows.reverse().map(m => ({
        ...m,
        decision_meta: saasBotManager.parseDecisionMeta(m.decision_meta)
      }));
      const pauseState = saasBotManager.getChatPauseState(req.tenantId, chatId);
      res.json({ success: true, messages, pauseState });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/chats/:chatId/pause', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const chatId = decodeURIComponent(String(req.params.chatId || ''));
      const paused = Boolean(req.body?.paused);
      const minutes = req.body?.minutes !== undefined ? Number(req.body.minutes) : 30;
      const pauseState = saasBotManager.setChatPauseState(req.tenantId, chatId, paused ? minutes : 0, 'manual');
      res.json({ success: true, pauseState });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/chats/:chatId/send-manual', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const chatId = decodeURIComponent(String(req.params.chatId || ''));
      const audioIds = Array.isArray(req.body?.audioIds) ? req.body.audioIds.map(Number).filter(n => n > 0) : [];
      const text = String(req.body?.text || '').trim();
      const result = await saasBotManager.sendManualFlowToChat(req.tenantId, chatId, { audioIds, text });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/simulate', requireSaasTenant, express.json(), async (req, res) => {
    try {
      const { messages, history, humanPaused } = req.body || {};
      const simulation = await saasBotManager.simulateTenantChatTurn(req.tenantId, {
        messages,
        history,
        humanPaused: Boolean(humanPaused)
      });
      res.json({ success: true, simulation });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message || 'No se pudo simular la conversación.' });
    }
  });

  app.get('/api/saas-bot/audios/:id/stream', requireSaasTenant, async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const audioId = Number(req.params.id);
      const [[existing]] = await pool.query('SELECT file_path FROM saas_bot_audios WHERE id = ? AND tenant_id = ? LIMIT 1', [audioId, req.tenantId]);
      if (!existing || !existing.file_path || !fs.existsSync(existing.file_path)) {
        return res.status(404).json({ success: false, message: 'Archivo de audio no encontrado.' });
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.sendFile(path.resolve(existing.file_path));
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/saas-bot/audios/merge-library', requireSaasTenant, express.json(), async (req, res) => {
    try {
      await saasBotManager.ensureSaasBotTables();
      const audioIds = Array.isArray(req.body?.audioIds) ? req.body.audioIds.map(Number).filter(n => n > 0) : [];
      if (audioIds.length === 0) {
        return res.status(400).json({ success: false, message: 'Selecciona al menos 1 audio de tu biblioteca.' });
      }

      const [rows] = await pool.query(
        `SELECT id, title, file_path FROM saas_bot_audios WHERE tenant_id = ? AND id IN (${audioIds.map(() => '?').join(',')})`,
        [req.tenantId, ...audioIds]
      );
      const byId = new Map(rows.map(r => [Number(r.id), r]));
      const ordered = audioIds.map(id => byId.get(id)).filter(Boolean);
      if (ordered.length === 0) {
        return res.status(404).json({ success: false, message: 'Audios seleccionados no encontrados.' });
      }

      const pauseMs = req.body?.pauseMs !== undefined ? Number(req.body.pauseMs) : 350;
      const result = await elevenLabsService.buildFreshWhatsAppVoiceNoteFromFiles(
        ordered.map(r => r.file_path),
        { pauseMs }
      );

      const sendToPhone = String(req.body?.sendToPhone || '').trim();
      let sentToWhatsApp = false;
      if (sendToPhone) {
        const titles = ordered.map(r => r.title).join(' + ');
        await saasBotManager.sendTenantAudioOrText(req.tenantId, sendToPhone, {
          oggBuffer: result.oggBuffer,
          durationSec: result.durationSec,
          text: `[Nota de voz unida: ${titles}]`
        });
        sentToWhatsApp = true;
      }

      res.json({
        success: true,
        audioBase64: result.mp3Buffer.toString('base64'),
        mimeType: 'audio/mpeg',
        filesCount: result.filesCount,
        durationSec: result.durationSec,
        sentToWhatsApp
      });
    } catch (err) {
      console.error('[SaaS Library Merge Error]:', err.message);
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

  app.get('/api/admin/saas-bots/invite-codes', async (req, res) => {
    try {
      const pwd = req.headers['x-admin-password'] || req.query.password;
      if (pwd !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

      await saasBotManager.ensureSaasBotTables();
      const [codes] = await pool.query(`
        SELECT c.*, t.owner_name AS used_owner_name, t.business_name AS used_business_name, t.email AS used_email
        FROM saas_bot_invite_codes c
        LEFT JOIN saas_bot_tenants t ON c.used_by_tenant_id = t.id
        ORDER BY c.id DESC
      `);
      res.json({ success: true, codes });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/admin/saas-bots/invite-codes', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      const adminPwd = b.password || req.headers['x-admin-password'];
      if (adminPwd !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

      await saasBotManager.ensureSaasBotTables();
      const rawCode = b.code ? String(b.code) : generateRandomInviteCode();
      const cleanCode = rawCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!cleanCode) {
        return res.status(400).json({ success: false, message: 'Código de activación inválido.' });
      }

      const [existing] = await pool.query('SELECT id FROM saas_bot_invite_codes WHERE code = ? LIMIT 1', [cleanCode]);
      if (existing.length > 0) {
        return res.status(409).json({ success: false, message: `El código ${cleanCode} ya existe.` });
      }

      const planName = String(b.planName || 'Plan Básico 30K').trim();
      const amountPaid = b.amountPaid !== undefined ? Number(b.amountPaid) : 30000;
      const monthlyLimit = b.monthlyLimit !== undefined ? Number(b.monthlyLimit) : 500;
      const durationDays = b.durationDays !== undefined ? Number(b.durationDays) : 30;
      const clientHint = b.clientHint ? String(b.clientHint).trim() : null;
      const syncToCashFlow = b.syncToCashFlow !== false;

      let cashFlowEntryId = null;
      if (syncToCashFlow && amountPaid > 0) {
        const todayBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
        const desc = `Pago Bot WhatsApp SaaS (${planName}) - ${clientHint || cleanCode} [Código: ${cleanCode}]`;
        const [cfRes] = await pool.query(
          'INSERT INTO cash_flow_entries (type, platform, amount, description, entry_date, is_automated) VALUES (?, ?, ?, ?, ?, ?)',
          ['income', 'BOT SAAS', amountPaid, desc, todayBogota, 1]
        );
        cashFlowEntryId = cfRes.insertId;
      }

      const [insRes] = await pool.query(
        `INSERT INTO saas_bot_invite_codes
         (code, plan_name, amount_paid, monthly_message_limit, duration_days, client_hint, cash_flow_entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cleanCode, planName, amountPaid, monthlyLimit, durationDays, clientHint, cashFlowEntryId]
      );

      const [rows] = await pool.query('SELECT * FROM saas_bot_invite_codes WHERE id = ? LIMIT 1', [insRes.insertId]);
      res.json({
        success: true,
        inviteCode: rows[0],
        cashFlowEntryId
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  const handleImpersonateTenant = async (req, res) => {
    try {
      const adminPwd = req.body?.password || req.query?.password || req.headers['x-admin-password'];
      if (adminPwd !== 'admin123') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      const tenantId = Number(req.params.id);
      const tenant = await saasBotManager.getTenantById(tenantId);
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Cliente SaaS no encontrado.' });
      }
      const token = signSessionToken({
        role: 'saas_bot',
        tenantId: tenant.id,
        email: tenant.email,
        impersonatedBy: 'admin'
      });
      res.json({
        success: true,
        token,
        loginUrl: `https://sheerit.co/mi-bot?impersonate=${encodeURIComponent(token)}`,
        tenant: saasBotManager.sanitizeTenant(tenant)
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  };

  app.get('/api/admin/saas-bots/:id/impersonate', handleImpersonateTenant);
  app.post('/api/admin/saas-bots/:id/impersonate', express.json(), handleImpersonateTenant);
}

module.exports = { registerSaasBotRoutes };
