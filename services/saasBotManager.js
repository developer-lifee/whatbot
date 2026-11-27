const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const { pool } = require('../database');
const elevenLabsService = require('./elevenLabsService');

const SESSIONS_ROOT = path.join(__dirname, '..', 'saas_wa_sessions');
if (!fs.existsSync(SESSIONS_ROOT)) {
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
}

const sessions = new Map(); // tenantId -> { sock, status, qrDataUrl, phone, lastError, isStarting, manualStop }
const chatHistories = new Map(); // `${tenantId}:${jid}` -> [{ role, content }]

let saasTablesReady = false;
async function ensureSaasBotTables() {
  if (saasTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_tenants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(100) UNIQUE NOT NULL,
      owner_name VARCHAR(150) NOT NULL,
      business_name VARCHAR(200) NOT NULL,
      email VARCHAR(190) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      plan_name VARCHAR(80) DEFAULT 'Plan Básico 30K',
      monthly_message_limit INT DEFAULT 500,
      messages_used_month INT DEFAULT 0,
      usage_reset_month VARCHAR(7) DEFAULT '',
      status VARCHAR(30) DEFAULT 'active',
      is_bot_active TINYINT(1) DEFAULT 1,
      business_description TEXT,
      system_prompt MEDIUMTEXT,
      knowledge_base MEDIUMTEXT,
      bot_tone VARCHAR(40) DEFAULT 'amigable',
      elevenlabs_enabled TINYINT(1) DEFAULT 0,
      elevenlabs_api_key VARCHAR(255) NULL,
      elevenlabs_voice_id VARCHAR(120) NULL,
      elevenlabs_model_id VARCHAR(80) DEFAULT 'eleven_multilingual_v2',
      reply_mode VARCHAR(30) DEFAULT 'text',
      wa_status VARCHAR(30) DEFAULT 'DISCONNECTED',
      wa_phone VARCHAR(40) NULL,
      last_connected_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_messages_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_jid VARCHAR(120) NOT NULL,
      direction ENUM('in','out') NOT NULL,
      message_type VARCHAR(20) DEFAULT 'text',
      body TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant_created (tenant_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  saasTablesReady = true;
}

function getCurrentMonthKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function getTenantById(tenantId) {
  await ensureSaasBotTables();
  const [rows] = await pool.query('SELECT * FROM saas_bot_tenants WHERE id = ? LIMIT 1', [tenantId]);
  if (rows.length === 0) return null;
  const tenant = rows[0];
  const monthKey = getCurrentMonthKey();
  if (tenant.usage_reset_month !== monthKey) {
    await pool.query(
      'UPDATE saas_bot_tenants SET messages_used_month = 0, usage_reset_month = ? WHERE id = ?',
      [monthKey, tenant.id]
    );
    tenant.messages_used_month = 0;
    tenant.usage_reset_month = monthKey;
  }
  return tenant;
}

function sanitizeTenant(tenant) {
  if (!tenant) return null;
  const { password_hash, elevenlabs_api_key, ...rest } = tenant;
  return {
    ...rest,
    has_elevenlabs_key: Boolean(elevenlabs_api_key && String(elevenlabs_api_key).trim()),
    elevenlabs_api_key_masked: elevenlabs_api_key
      ? `${String(elevenlabs_api_key).slice(0, 6)}...${String(elevenlabs_api_key).slice(-4)}`
      : ''
  };
}

function getGeminiKeys() {
  return Array.from(new Set(
    Object.entries(process.env)
      .filter(([key, val]) => (key.startsWith('GEMINI_API_KEY') || key.startsWith('GOOGLE_API_KEY')) && val && val.trim().length > 10)
      .map(([, val]) => val.trim())
  ));
}

async function callLlmCompletion(messages, { temperature = 0.5, maxTokens = 700, jsonMode = false } = {}) {
  const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (deepseekKey) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${deepseekKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text && text.trim()) return text.trim();
      } else {
        console.warn('[SaaS Bot LLM] DeepSeek HTTP', res.status);
      }
    } catch (err) {
      console.warn('[SaaS Bot LLM] DeepSeek fallo:', err.message);
    }
  }

  const geminiKeys = getGeminiKeys();
  const sysText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  for (const key of geminiKeys) {
    for (const model of ['gemini-flash-lite-latest', 'gemini-3.8-flash']) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(sysText ? { systemInstruction: { parts: [{ text: sysText }] } } : {}),
            contents,
            generationConfig: {
              temperature,
              maxOutputTokens: maxTokens,
              ...(jsonMode ? { responseMimeType: 'application/json' } : {})
            }
          }),
          signal: AbortSignal.timeout(25000)
        });
        if (res.ok) {
          const data = await res.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text && text.trim()) return text.trim();
        }
      } catch (err) {
        console.warn(`[SaaS Bot LLM] Gemini (${model}) fallo:`, err.message);
      }
    }
  }

  throw new Error('No hay proveedor de IA disponible para responder en este momento.');
}

/**
 * Genera automáticamente system_prompt y knowledge_base a partir de la descripción del negocio del cliente.
 */
async function generateSaasBotConfig({ businessName, businessDescription, productsOrServices = '', tone = 'amigable' }) {
  const prompt = `Eres un arquitecto experto en bots de atención al cliente y ventas por WhatsApp en Latinoamérica.
Con base en los datos del negocio, genera un JSON válido con exactamente dos claves string: "system_prompt" y "knowledge_base".

Datos del negocio:
- Nombre del negocio: ${businessName || 'Mi Negocio'}
- Tono deseado: ${tone || 'amigable'}
- Descripción del negocio: ${businessDescription || ''}
- Productos, servicios, precios u horarios: ${productsOrServices || 'No especificados aún'}

Reglas para "system_prompt":
- Escríbelo en segunda persona para guiar al asistente ("Eres el asistente virtual oficial de...").
- Mantén respuestas cortas, claras y naturales para WhatsApp (máximo 2-3 párrafos).
- Indica nunca inventar precios ni políticas que no estén en la base de conocimiento; si falta un dato, pedir amablemente un momento para confirmar con el equipo.

Reglas para "knowledge_base":
- Organízala con viñetas claras: Qué ofrece, Precios/Planes (si fueron provistos), Medios de pago/Entrega, Preguntas Frecuentes (FAQ) sugeridas para este tipo de negocio y Políticas de atención.

Responde ÚNICAMENTE con el objeto JSON.`;

  const raw = await callLlmCompletion(
    [{ role: 'user', content: prompt }],
    { temperature: 0.4, maxTokens: 1200, jsonMode: true }
  );

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    system_prompt: String(parsed.system_prompt || '').trim(),
    knowledge_base: String(parsed.knowledge_base || '').trim()
  };
}

function getTenantSessionDir(tenantId) {
  return path.join(SESSIONS_ROOT, `tenant_${tenantId}`);
}

function getTenantSessionState(tenantId) {
  const mem = sessions.get(Number(tenantId));
  if (!mem) {
    return { status: 'DISCONNECTED', qrDataUrl: null, phone: null, lastError: null };
  }
  return {
    status: mem.status || 'DISCONNECTED',
    qrDataUrl: mem.qrDataUrl || null,
    phone: mem.phone || null,
    lastError: mem.lastError || null
  };
}

async function logTenantMessage(tenantId, customerJid, direction, messageType, body) {
  try {
    await pool.query(
      'INSERT INTO saas_bot_messages_log (tenant_id, customer_jid, direction, message_type, body) VALUES (?, ?, ?, ?, ?)',
      [tenantId, customerJid, direction, messageType, String(body || '').slice(0, 4000)]
    );
  } catch (err) {
    console.warn(`[SaaS Bot #${tenantId}] Error guardando log:`, err.message);
  }
}

async function handleIncomingTenantMessage(tenantId, msg) {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter')) {
    return;
  }

  const m = msg.message;
  if (!m) return;

  const isVoiceMsg = Boolean(m.audioMessage);
  const rawText = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();

  if (!rawText && !isVoiceMsg) return;

  const tenant = await getTenantById(tenantId);
  if (!tenant || tenant.status !== 'active' || !tenant.is_bot_active) {
    return;
  }

  if (tenant.monthly_message_limit > 0 && tenant.messages_used_month >= tenant.monthly_message_limit) {
    console.warn(`[SaaS Bot #${tenantId}] Límite mensual alcanzado (${tenant.messages_used_month}/${tenant.monthly_message_limit}).`);
    return;
  }

  const incomingText = rawText || 'Hola, te envié una nota de voz. ¿Me puedes ayudar?';
  await logTenantMessage(tenantId, remoteJid, 'in', isVoiceMsg ? 'audio' : 'text', incomingText);

  const histKey = `${tenantId}:${remoteJid}`;
  const history = chatHistories.get(histKey) || [];

  const systemInstruction = [
    tenant.system_prompt || `Eres el asistente virtual oficial de ${tenant.business_name}.`,
    `Tono de atención: ${tenant.bot_tone || 'amigable'}.`,
    tenant.business_description ? `Descripción del negocio: ${tenant.business_description}` : '',
    tenant.knowledge_base ? `BASE DE CONOCIMIENTO:\n${tenant.knowledge_base}` : '',
    'Regla de WhatsApp: responde claro, conciso y natural en español sin inventar datos no confirmados.'
  ].filter(Boolean).join('\n\n');

  const llmMessages = [
    { role: 'system', content: systemInstruction },
    ...history.slice(-8),
    { role: 'user', content: incomingText }
  ];

  let replyText;
  try {
    replyText = await callLlmCompletion(llmMessages, { temperature: 0.5, maxTokens: 550 });
  } catch (err) {
    console.error(`[SaaS Bot #${tenantId}] Error generando respuesta IA:`, err.message);
    return;
  }

  history.push({ role: 'user', content: incomingText });
  history.push({ role: 'assistant', content: replyText });
  chatHistories.set(histKey, history.slice(-12));

  const sess = sessions.get(Number(tenantId));
  if (!sess || !sess.sock || sess.status !== 'CONNECTED') return;

  const shouldReplyVoice = Boolean(
    tenant.elevenlabs_enabled &&
    tenant.elevenlabs_api_key &&
    tenant.elevenlabs_voice_id &&
    (tenant.reply_mode === 'voice' || (tenant.reply_mode === 'auto_match' && isVoiceMsg))
  );

  let sentType = 'text';
  if (shouldReplyVoice) {
    try {
      const mp3Buf = await elevenLabsService.textToSpeechMp3(replyText, {
        apiKey: tenant.elevenlabs_api_key,
        voiceId: tenant.elevenlabs_voice_id,
        modelId: tenant.elevenlabs_model_id || 'eleven_multilingual_v2'
      });
      const oggBuf = await elevenLabsService.convertMp3ToWhatsAppOgg(mp3Buf);
      await sess.sock.sendMessage(remoteJid, {
        audio: oggBuf,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true
      });
      sentType = 'audio';
    } catch (voiceErr) {
      console.warn(`[SaaS Bot #${tenantId}] Falló voz ElevenLabs, enviando texto:`, voiceErr.message);
      await sess.sock.sendMessage(remoteJid, { text: replyText });
    }
  } else {
    await sess.sock.sendMessage(remoteJid, { text: replyText });
  }

  await pool.query(
    'UPDATE saas_bot_tenants SET messages_used_month = messages_used_month + 1, usage_reset_month = ? WHERE id = ?',
    [getCurrentMonthKey(), tenantId]
  );
  await logTenantMessage(tenantId, remoteJid, 'out', sentType, replyText);
}

/**
 * Inicia o recupera la sesión WhatsApp (Baileys sin Chromium) de un cliente SaaS.
 */
async function startTenantSession(tenantId) {
  await ensureSaasBotTables();
  const id = Number(tenantId);
  const existing = sessions.get(id);
  if (existing && (existing.isStarting || existing.status === 'CONNECTED')) {
    return getTenantSessionState(id);
  }

  const sessionDir = getTenantSessionDir(id);
  fs.mkdirSync(sessionDir, { recursive: true });

  const stateObj = {
    sock: null,
    status: 'CONNECTING',
    qrDataUrl: null,
    phone: null,
    lastError: null,
    isStarting: true,
    manualStop: false
  };
  sessions.set(id, stateObj);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('SheeritBot'),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    stateObj.sock = sock;
    stateObj.isStarting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          stateObj.qrDataUrl = await qrcode.toDataURL(qr);
          stateObj.status = 'QR_READY';
          stateObj.lastError = null;
          await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['QR_READY', id]).catch(() => {});
        } catch (qrErr) {
          stateObj.lastError = qrErr.message;
        }
      }

      if (connection === 'open') {
        const rawUser = sock.user?.id || '';
        const phone = rawUser.split(':')[0].split('@')[0].replace(/\D/g, '') || null;
        stateObj.status = 'CONNECTED';
        stateObj.qrDataUrl = null;
        stateObj.phone = phone;
        stateObj.lastError = null;
        await pool.query(
          'UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = ?, last_connected_at = NOW() WHERE id = ?',
          ['CONNECTED', phone, id]
        ).catch(() => {});
        console.log(`[SaaS Bot #${id}] ✅ WhatsApp conectado (${phone || 'OK'})`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        stateObj.qrDataUrl = null;

        if (stateObj.manualStop || loggedOut) {
          stateObj.status = 'DISCONNECTED';
          stateObj.phone = null;
          if (loggedOut) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
          }
          await pool.query('UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = NULL WHERE id = ?', ['DISCONNECTED', id]).catch(() => {});
          console.log(`[SaaS Bot #${id}] Sesión cerrada (${loggedOut ? 'loggedOut' : 'manual'}).`);
        } else {
          stateObj.status = 'CONNECTING';
          stateObj.lastError = lastDisconnect?.error?.message || 'Reconectando...';
          setTimeout(() => {
            const cur = sessions.get(id);
            if (cur && !cur.manualStop) {
              cur.status = 'DISCONNECTED';
              cur.isStarting = false;
              startTenantSession(id).catch(() => {});
            }
          }, 4000);
        }
      }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify' || !Array.isArray(upsert.messages)) return;
      for (const msg of upsert.messages) {
        if (msg?.key?.fromMe) continue;
        handleIncomingTenantMessage(id, msg).catch(err => {
          console.error(`[SaaS Bot #${id}] Error procesando mensaje:`, err.message);
        });
      }
    });
  } catch (err) {
    stateObj.isStarting = false;
    stateObj.status = 'DISCONNECTED';
    stateObj.lastError = err.message;
    console.error(`[SaaS Bot #${id}] Error iniciando sesión Baileys:`, err.message);
  }

  return getTenantSessionState(id);
}

async function disconnectTenantSession(tenantId) {
  const id = Number(tenantId);
  const mem = sessions.get(id);
  const sessionDir = getTenantSessionDir(id);

  if (mem) {
    mem.manualStop = true;
    mem.status = 'DISCONNECTED';
    mem.qrDataUrl = null;
    if (mem.sock) {
      try { await mem.sock.logout(); } catch {}
      try { mem.sock.end(); } catch {}
    }
    sessions.delete(id);
  }

  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  await ensureSaasBotTables();
  await pool.query('UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = NULL WHERE id = ?', ['DISCONNECTED', id]);
  return { status: 'DISCONNECTED', qrDataUrl: null, phone: null };
}

async function sendTenantAudioOrText(tenantId, targetPhone, { text, oggBuffer } = {}) {
  const id = Number(tenantId);
  const mem = sessions.get(id);
  if (!mem || !mem.sock || mem.status !== 'CONNECTED') {
    throw new Error('Tu WhatsApp no está conectado. Escanea el código QR primero.');
  }

  const digits = String(targetPhone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error('Número de destino inválido (mínimo 10 dígitos).');
  }
  const normalized = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
  const jid = `${normalized}@s.whatsapp.net`;

  if (oggBuffer) {
    await mem.sock.sendMessage(jid, {
      audio: oggBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });
    await logTenantMessage(id, jid, 'out', 'audio', text || '[Audio unido de ElevenLabs]');
  } else if (text) {
    await mem.sock.sendMessage(jid, { text });
    await logTenantMessage(id, jid, 'out', 'text', text);
  }
}

async function autoRestoreSavedSessions() {
  try {
    await ensureSaasBotTables();
    const [rows] = await pool.query("SELECT id FROM saas_bot_tenants WHERE status = 'active' AND wa_status = 'CONNECTED'");
    for (const row of rows) {
      const credsFile = path.join(getTenantSessionDir(row.id), 'creds.json');
      if (fs.existsSync(credsFile)) {
        console.log(`[SaaS Bot] 🔄 Restaurando sesión guardada del cliente #${row.id}...`);
        startTenantSession(row.id).catch(err => {
          console.warn(`[SaaS Bot] No se pudo restaurar cliente #${row.id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[SaaS Bot] Error restaurando sesiones guardadas:', err.message);
  }
}

module.exports = {
  ensureSaasBotTables,
  getTenantById,
  sanitizeTenant,
  generateSaasBotConfig,
  startTenantSession,
  disconnectTenantSession,
  getTenantSessionState,
  sendTenantAudioOrText,
  autoRestoreSavedSessions,
  getCurrentMonthKey
};
