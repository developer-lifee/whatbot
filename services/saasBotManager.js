const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { pool } = require('../database');
const elevenLabsService = require('./elevenLabsService');
const { callAgyCli, extractJsonFromAgyOutput } = require('../cliAgentService');

const SESSIONS_ROOT = path.join(__dirname, '..', 'saas_wa_sessions');
if (!fs.existsSync(SESSIONS_ROOT)) {
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
}

const sessions = new Map(); // tenantId -> { client, status, qrDataUrl, phone, lastError, isStarting, manualStop }
const chatHistories = new Map(); // `${tenantId}:${chatId}` -> [{ role, content }]
const incomingBatches = new Map(); // `${tenantId}:${chatId}` -> { items: [], timer: Timeout }
const tenantQueues = new Map(); // tenantId -> Promise chain
const humanPausedChats = new Map(); // `${tenantId}:${chatId}` -> { pausedUntil, reason, updatedAt }
const botSentMessageIds = new Set();

function markBotSentMessage(sentMsg) {
  const id = sentMsg?.id?._serialized;
  if (!id) return;
  botSentMessageIds.add(id);
  setTimeout(() => botSentMessageIds.delete(id), 60000);
}

function getChatPauseState(tenantId, chatId) {
  const key = `${Number(tenantId)}:${chatId}`;
  const entry = humanPausedChats.get(key);
  if (!entry) return { isPaused: false, pausedUntil: null, reason: null };
  if (entry.pausedUntil && Date.now() >= entry.pausedUntil) {
    humanPausedChats.delete(key);
    return { isPaused: false, pausedUntil: null, reason: null };
  }
  return { isPaused: true, pausedUntil: entry.pausedUntil, reason: entry.reason };
}

function setChatPauseState(tenantId, chatId, pauseMinutes = 30, reason = 'manual') {
  const key = `${Number(tenantId)}:${chatId}`;
  const mins = Number(pauseMinutes) || 0;
  if (mins <= 0) {
    humanPausedChats.delete(key);
    return { isPaused: false, pausedUntil: null, reason: null };
  }
  const pausedUntil = Date.now() + mins * 60 * 1000;
  humanPausedChats.set(key, { pausedUntil, reason, updatedAt: Date.now() });
  return { isPaused: true, pausedUntil, reason };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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
      amount_paid DECIMAL(12,2) DEFAULT 0,
      expires_at DATETIME NULL,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_audios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      title VARCHAR(150) NOT NULL,
      trigger_description TEXT NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      original_filename VARCHAR(255) NULL,
      duration_sec INT DEFAULT 5,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant_audio (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_invite_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(60) UNIQUE NOT NULL,
      plan_name VARCHAR(80) DEFAULT 'Plan Básico 30K',
      amount_paid DECIMAL(12,2) DEFAULT 30000,
      monthly_message_limit INT DEFAULT 500,
      duration_days INT DEFAULT 30,
      client_hint VARCHAR(150) NULL,
      used_by_tenant_id INT NULL,
      used_at DATETIME NULL,
      cash_flow_entry_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_code_used (code, used_by_tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [cols] = await pool.query('SHOW COLUMNS FROM saas_bot_tenants');
  const colNames = new Set(cols.map(c => c.Field));
  if (!colNames.has('amount_paid')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN amount_paid DECIMAL(12,2) DEFAULT 0 AFTER monthly_message_limit');
  }
  if (!colNames.has('expires_at')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN expires_at DATETIME NULL AFTER amount_paid');
  }
  if (!colNames.has('human_pause_minutes')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN human_pause_minutes INT DEFAULT 30 AFTER is_bot_active');
  }
  if (!colNames.has('dashboard_prefs')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN dashboard_prefs LONGTEXT NULL');
  }
  if (!colNames.has('enabled_modules')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN enabled_modules LONGTEXT NULL');
  }
  if (!colNames.has('store_slug')) {
    await pool.query('ALTER TABLE saas_bot_tenants ADD COLUMN store_slug VARCHAR(120) NULL AFTER enabled_modules').catch(() => {});
  }

  const [audioCols] = await pool.query('SHOW COLUMNS FROM saas_bot_audios');
  const audioColNames = new Set(audioCols.map(c => c.Field));
  if (!audioColNames.has('image_path')) {
    await pool.query('ALTER TABLE saas_bot_audios ADD COLUMN image_path VARCHAR(500) NULL AFTER original_filename');
  }
  if (!audioColNames.has('image_filename')) {
    await pool.query('ALTER TABLE saas_bot_audios ADD COLUMN image_filename VARCHAR(255) NULL AFTER image_path');
  }
  if (!audioColNames.has('followup_text')) {
    await pool.query('ALTER TABLE saas_bot_audios ADD COLUMN followup_text TEXT NULL AFTER image_filename');
  }

  const [logCols] = await pool.query('SHOW COLUMNS FROM saas_bot_messages_log');
  const logColNames = new Set(logCols.map(c => c.Field));
  if (!logColNames.has('decision_meta')) {
    await pool.query('ALTER TABLE saas_bot_messages_log ADD COLUMN decision_meta TEXT NULL AFTER body');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_improvements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      message_log_id INT NULL,
      customer_jid VARCHAR(120) NULL,
      incoming_text TEXT NULL,
      bot_reply TEXT NULL,
      client_question TEXT NOT NULL,
      explanation_plain TEXT NULL,
      scope ENUM('tenant_config','core_engine') DEFAULT 'tenant_config',
      practical_proposal TEXT NULL,
      proposed_prompt_addition TEXT NULL,
      proposed_audio_id INT NULL,
      proposed_audio_trigger TEXT NULL,
      technical_summary TEXT NULL,
      agy_conversation_id VARCHAR(120) NULL,
      status ENUM('proposed','accepted','applied','reverted','escalated_core','queued_restart','dismissed') DEFAULT 'proposed',
      previous_snapshot MEDIUMTEXT NULL,
      applied_at DATETIME NULL,
      reverted_at DATETIME NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_imp_tenant (tenant_id, status, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(
    "ALTER TABLE saas_bot_improvements MODIFY COLUMN status ENUM('proposed','accepted','applied','reverted','escalated_core','queued_restart','dismissed') DEFAULT 'proposed'"
  ).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS saas_bot_data_sources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      name VARCHAR(140) NOT NULL,
      source_type ENUM('google_sheets','uploaded_table','retailer_store') DEFAULT 'google_sheets',
      sheet_url VARCHAR(600) NULL,
      headers_json LONGTEXT NULL,
      rows_json LONGTEXT NULL,
      row_count INT DEFAULT 0,
      last_synced_at DATETIME NULL,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ds_tenant (tenant_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(
    "ALTER TABLE saas_bot_data_sources MODIFY COLUMN source_type ENUM('google_sheets','uploaded_table','retailer_store') DEFAULT 'google_sheets'"
  ).catch(() => {});

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

function parseDashboardPrefs(raw) {
  let obj = {};
  if (raw && typeof raw === 'object') {
    obj = { ...raw };
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed;
      }
    } catch {}
  }
  const favs = Array.isArray(obj.favoriteAudioIds)
    ? Array.from(new Set(obj.favoriteAudioIds.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)))
    : [];
  return {
    ...obj,
    favoriteAudioIds: favs
  };
}

async function updateTenantDashboardPrefs(tenantId, patch = {}) {
  await ensureSaasBotTables();
  const [[row]] = await pool.query('SELECT dashboard_prefs FROM saas_bot_tenants WHERE id = ? LIMIT 1', [Number(tenantId)]);
  if (!row) throw new Error('Cuenta no encontrada.');
  const current = parseDashboardPrefs(row.dashboard_prefs);
  const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = parseDashboardPrefs({ ...current, ...safePatch });
  await pool.query('UPDATE saas_bot_tenants SET dashboard_prefs = ? WHERE id = ?', [
    JSON.stringify(merged),
    Number(tenantId)
  ]);
  return merged;
}

function parseEnabledModules(raw) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
  }
  return Array.from(new Set(list.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)));
}

async function setTenantEnabledModules(tenantId, modulesArray = []) {
  await ensureSaasBotTables();
  const normalized = parseEnabledModules(modulesArray);
  await pool.query('UPDATE saas_bot_tenants SET enabled_modules = ? WHERE id = ?', [
    JSON.stringify(normalized),
    Number(tenantId)
  ]);
  return normalized;
}

function toGoogleSheetsCsvUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Ingresa una URL válida de Google Sheets o CSV.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('La URL debe empezar por http:// o https://');
  }

  if (parsed.hostname.includes('docs.google.com') && parsed.pathname.includes('/spreadsheets/d/')) {
    if (parsed.pathname.includes('/export') && parsed.searchParams.get('format') === 'csv') {
      return parsed.toString();
    }
    if (parsed.pathname.includes('/pub') && parsed.searchParams.get('output') === 'csv') {
      return parsed.toString();
    }
    const match = parsed.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) throw new Error('No se encontró el ID del documento de Google Sheets.');
    const sheetId = match[1];
    let gid = parsed.searchParams.get('gid') || '';
    if (!gid && parsed.hash && parsed.hash.includes('gid=')) {
      const hMatch = parsed.hash.match(/gid=(\d+)/);
      if (hMatch) gid = hMatch[1];
    }
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  }

  return parsed.toString();
}

function parseCsvTable(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  const firstLine = (text.split(/\r?\n/)[0] || '');
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';

  const matrix = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some(c => c !== '')) matrix.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some(c => c !== '')) matrix.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some(c => c !== '')) matrix.push(row);

  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((h, idx) => h || `Columna_${idx + 1}`);
  const rows = [];
  for (let r = 1; r < matrix.length && rows.length < 1500; r++) {
    const rawRow = matrix[r];
    if (!rawRow.some(c => c !== '')) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = rawRow[idx] !== undefined ? String(rawRow[idx]).trim() : '';
    });
    rows.push(obj);
  }
  return { headers, rows };
}

function formatDataSourceSummary(row) {
  let headers = [];
  let rows = [];
  try { headers = JSON.parse(row.headers_json || '[]'); } catch {}
  try { rows = JSON.parse(row.rows_json || '[]'); } catch {}
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    source_type: row.source_type,
    sheet_url: row.sheet_url,
    headers: Array.isArray(headers) ? headers : [],
    previewRows: Array.isArray(rows) ? rows.slice(0, 15) : [],
    row_count: Number(row.row_count || rows.length || 0),
    last_synced_at: row.last_synced_at,
    is_active: Boolean(row.is_active)
  };
}

async function listTenantDataSources(tenantId) {
  await ensureSaasBotTables();
  const [rows] = await pool.query(
    'SELECT * FROM saas_bot_data_sources WHERE tenant_id = ? AND is_active = 1 ORDER BY id DESC',
    [Number(tenantId)]
  );
  return rows.map(formatDataSourceSummary);
}

async function syncGoogleSheetSource(tenantId, { id = null, name = '', sheetUrl = '' } = {}) {
  await ensureSaasBotTables();
  let targetId = id ? Number(id) : null;
  let finalName = String(name || '').trim();
  let finalUrl = String(sheetUrl || '').trim();

  if (targetId) {
    const [[existing]] = await pool.query(
      'SELECT * FROM saas_bot_data_sources WHERE id = ? AND tenant_id = ? LIMIT 1',
      [targetId, Number(tenantId)]
    );
    if (!existing) throw new Error('Fuente de datos no encontrada.');
    if (!finalName) finalName = existing.name;
    if (!finalUrl) finalUrl = existing.sheet_url || '';
  }

  if (!finalUrl) throw new Error('Ingresa el enlace de tu Google Sheets.');
  const csvUrl = toGoogleSheetsCsvUrl(finalUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let csvText = '';
  try {
    const res = await fetch(csvUrl, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Google Sheets respondió HTTP ${res.status}. Verifica que sea pública en lectura.`);
    }
    csvText = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const lowerHead = csvText.slice(0, 400).toLowerCase();
  if (lowerHead.includes('<!doctype html') || lowerHead.includes('<html') || lowerHead.includes('servicelogin')) {
    throw new Error("Asegúrate de que tu hoja esté compartida como 'Cualquier persona con el enlace (Lector)' o 'Publicada en la web'.");
  }

  const { headers, rows } = parseCsvTable(csvText);
  if (headers.length === 0) {
    throw new Error('La hoja está vacía o no tiene encabezados válidos.');
  }

  const safeName = finalName || 'Hoja Google Sheets';
  if (targetId) {
    await pool.query(
      'UPDATE saas_bot_data_sources SET name = ?, sheet_url = ?, headers_json = ?, rows_json = ?, row_count = ?, last_synced_at = NOW() WHERE id = ? AND tenant_id = ?',
      [safeName, finalUrl, JSON.stringify(headers), JSON.stringify(rows), rows.length, targetId, Number(tenantId)]
    );
  } else {
    const [ins] = await pool.query(
      `INSERT INTO saas_bot_data_sources
       (tenant_id, name, source_type, sheet_url, headers_json, rows_json, row_count, last_synced_at, is_active)
       VALUES (?, ?, 'google_sheets', ?, ?, ?, ?, NOW(), 1)`,
      [Number(tenantId), safeName, finalUrl, JSON.stringify(headers), JSON.stringify(rows), rows.length]
    );
    targetId = ins.insertId;
  }

  const [[saved]] = await pool.query('SELECT * FROM saas_bot_data_sources WHERE id = ? LIMIT 1', [targetId]);
  return formatDataSourceSummary(saved);
}

async function importUploadedTableSource(tenantId, { name = '', headers = [], rows = [] } = {}) {
  await ensureSaasBotTables();
  const safeName = String(name || '').trim() || 'Tabla Excel / CSV';
  if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows) || rows.length === 0) {
    throw new Error('La tabla no contiene encabezados o filas válidas.');
  }
  const cleanHeaders = headers.map((h, idx) => String(h || '').trim() || `Columna_${idx + 1}`).slice(0, 40);
  const cleanRows = [];
  for (const r of rows) {
    if (cleanRows.length >= 1500) break;
    if (!r || typeof r !== 'object') continue;
    const obj = {};
    let hasVal = false;
    for (const h of cleanHeaders) {
      const v = r[h] !== undefined && r[h] !== null ? String(r[h]).trim() : '';
      if (v) hasVal = true;
      obj[h] = v;
    }
    if (hasVal) cleanRows.push(obj);
  }
  if (cleanRows.length === 0) {
    throw new Error('No se encontraron filas con contenido válido en el archivo.');
  }

  const [ins] = await pool.query(
    `INSERT INTO saas_bot_data_sources
     (tenant_id, name, source_type, sheet_url, headers_json, rows_json, row_count, last_synced_at, is_active)
     VALUES (?, ?, 'uploaded_table', NULL, ?, ?, ?, NOW(), 1)`,
    [Number(tenantId), safeName, JSON.stringify(cleanHeaders), JSON.stringify(cleanRows), cleanRows.length]
  );
  const [[saved]] = await pool.query('SELECT * FROM saas_bot_data_sources WHERE id = ? LIMIT 1', [ins.insertId]);
  return formatDataSourceSummary(saved);
}

async function deleteTenantDataSource(tenantId, sourceId) {
  await ensureSaasBotTables();
  const [res] = await pool.query('DELETE FROM saas_bot_data_sources WHERE id = ? AND tenant_id = ?', [
    Number(sourceId),
    Number(tenantId)
  ]);
  if (!res.affectedRows) throw new Error('Fuente de datos no encontrada.');
  return { deleted: true };
}

function parseStoreProductsArray(rawProducts) {
  let list = [];
  if (Array.isArray(rawProducts)) {
    list = rawProducts;
  } else if (typeof rawProducts === 'string' && rawProducts.trim()) {
    try {
      const parsed = JSON.parse(rawProducts);
      if (Array.isArray(parsed)) list = parsed;
    } catch {}
  }
  return list.filter(p => p && String(p.name || '').trim() !== '');
}

async function syncRetailerStoreToTenant(tenantId, storeRow) {
  await ensureSaasBotTables();
  if (!storeRow || !storeRow.slug) throw new Error('Tienda inválida para sincronizar.');
  const id = Number(tenantId);
  const products = parseStoreProductsArray(storeRow.products_json ?? storeRow.products);
  const headers = ['Producto', 'Categoría', 'Precio COP', 'Descripción'];
  const rows = products.map((p) => ({
    Producto: String(p.name || '').trim(),
    'Categoría': String(p.category || 'General').trim(),
    'Precio COP': `$${Number(p.price || 0).toLocaleString('es-CO')}`,
    'Descripción': String(p.description || '').trim()
  }));

  const storeUrl = `https://sheerit.co/tienda/${storeRow.slug}`;
  const dsName = `Catálogo Tienda: ${String(storeRow.store_name || storeRow.slug).trim()}`.slice(0, 140);

  const [existingDs] = await pool.query(
    "SELECT id FROM saas_bot_data_sources WHERE tenant_id = ? AND source_type = 'retailer_store' ORDER BY id DESC LIMIT 1",
    [id]
  );

  if (existingDs.length > 0) {
    await pool.query(
      `UPDATE saas_bot_data_sources
       SET name = ?, sheet_url = ?, headers_json = ?, rows_json = ?, row_count = ?, last_synced_at = NOW(), is_active = 1
       WHERE id = ?`,
      [dsName, storeUrl, JSON.stringify(headers), JSON.stringify(rows), rows.length, existingDs[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO saas_bot_data_sources
       (tenant_id, name, source_type, sheet_url, headers_json, rows_json, row_count, last_synced_at, is_active)
       VALUES (?, ?, 'retailer_store', ?, ?, ?, ?, NOW(), 1)`,
      [id, dsName, storeUrl, JSON.stringify(headers), JSON.stringify(rows), rows.length]
    );
  }

  const [[tenantRow]] = await pool.query('SELECT knowledge_base FROM saas_bot_tenants WHERE id = ? LIMIT 1', [id]);
  if (tenantRow) {
    const existingKb = String(tenantRow.knowledge_base || '')
      .replace(/\[TIENDA WEB CONECTADA\][\s\S]*?\[\/TIENDA WEB CONECTADA\]\s*/g, '')
      .trim();

    const productSummaryLines = products.slice(0, 40).map((p) => {
      const cat = p.category ? ` (${p.category})` : '';
      const desc = p.description ? ` — ${String(p.description).trim()}` : '';
      return `- ${String(p.name || '').trim()}${cat}: $${Number(p.price || 0).toLocaleString('es-CO')} COP${desc}`;
    });

    const storeBlock = [
      '[TIENDA WEB CONECTADA]',
      `Tienda: ${storeRow.store_name || storeRow.slug}${storeRow.city ? ` | Ciudad: ${storeRow.city}` : ''}`,
      `Catálogo y compras online: ${storeUrl}`,
      productSummaryLines.length > 0
        ? `Productos actuales:\n${productSummaryLines.join('\n')}`
        : 'Productos actuales: revisa el catálogo en el enlace de la tienda.',
      '[/TIENDA WEB CONECTADA]'
    ].join('\n');

    const nextKb = existingKb ? `${existingKb}\n\n${storeBlock}` : storeBlock;
    await pool.query('UPDATE saas_bot_tenants SET knowledge_base = ? WHERE id = ?', [nextKb, id]);
  }

  const tenantPrefix = `${id}:`;
  for (const key of chatHistories.keys()) {
    if (String(key).startsWith(tenantPrefix)) {
      chatHistories.delete(key);
    }
  }

  return { syncedProductsCount: rows.length };
}

async function getLinkedStoreForTenant(tenantId) {
  await ensureSaasBotTables();
  const [[tenantRow]] = await pool.query('SELECT store_slug FROM saas_bot_tenants WHERE id = ? LIMIT 1', [Number(tenantId)]);
  const slug = tenantRow?.store_slug ? String(tenantRow.store_slug).trim() : '';
  if (!slug) return null;

  const [rows] = await pool.query(
    'SELECT slug, store_name, business_type, owner_phone, city, products_json, status, updated_at FROM retailer_stores WHERE slug = ? LIMIT 1',
    [slug]
  ).catch(() => [[]]);
  if (!rows || rows.length === 0) return null;

  const s = rows[0];
  const products = parseStoreProductsArray(s.products_json);
  return {
    slug: s.slug,
    storeName: s.store_name,
    businessType: s.business_type,
    ownerPhone: s.owner_phone,
    city: s.city,
    url: `https://sheerit.co/tienda/${s.slug}`,
    productsCount: products.length,
    status: s.status,
    updatedAt: s.updated_at
  };
}

async function linkRetailerStoreToTenant(tenantId, rawSlug) {
  await ensureSaasBotTables();
  const id = Number(tenantId);
  const cleanSlug = String(rawSlug || '')
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\/[^/]+\/tienda\//i, '')
    .replace(/^\/?tienda\//i, '')
    .replace(/[^a-z0-9-]/g, '');

  if (!cleanSlug) {
    throw new Error('Ingresa el identificador (slug) o enlace de tu tienda, ej: cafe-de-la-sierra.');
  }

  const [rows] = await pool.query('SELECT * FROM retailer_stores WHERE slug = ? LIMIT 1', [cleanSlug]);
  if (!rows || rows.length === 0) {
    throw new Error('No encontramos ninguna tienda con ese identificador (slug). Verifica el enlace de tu tienda.');
  }

  const storeRow = rows[0];
  await pool.query('UPDATE saas_bot_tenants SET store_slug = ? WHERE id = ?', [storeRow.slug, id]);
  const { syncedProductsCount } = await syncRetailerStoreToTenant(id, storeRow);
  const linkedStore = await getLinkedStoreForTenant(id);
  return { linkedStore, syncedProductsCount };
}

async function unlinkRetailerStoreFromTenant(tenantId) {
  await ensureSaasBotTables();
  const id = Number(tenantId);
  await pool.query('UPDATE saas_bot_tenants SET store_slug = NULL WHERE id = ?', [id]);
  await pool.query("UPDATE saas_bot_data_sources SET is_active = 0 WHERE tenant_id = ? AND source_type = 'retailer_store'", [id]);
  return { unlinked: true };
}

const normDataText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

async function buildLiveDataContextForMessage(tenant, incomingText) {
  if (!tenant) return '';
  const hasCrmSheets = parseEnabledModules(tenant.enabled_modules).includes('crm_sheets');
  const [sources] = hasCrmSheets
    ? await pool.query(
        'SELECT * FROM saas_bot_data_sources WHERE tenant_id = ? AND is_active = 1 ORDER BY id DESC',
        [Number(tenant.id)]
      )
    : await pool.query(
        "SELECT * FROM saas_bot_data_sources WHERE tenant_id = ? AND is_active = 1 AND source_type = 'retailer_store' ORDER BY id DESC",
        [Number(tenant.id)]
      );
  if (!sources || sources.length === 0) return '';

  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (src.source_type === 'google_sheets' && src.sheet_url) {
      const syncedMs = src.last_synced_at ? new Date(src.last_synced_at).getTime() : 0;
      if (!syncedMs || syncedMs < fiveMinAgo) {
        try {
          await syncGoogleSheetSource(tenant.id, { id: src.id });
          const [[refreshed]] = await pool.query('SELECT * FROM saas_bot_data_sources WHERE id = ? LIMIT 1', [src.id]);
          if (refreshed) sources[i] = refreshed;
        } catch {}
      }
    }
  }

  const tokens = Array.from(
    new Set(
      normDataText(incomingText)
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3)
    )
  );

  const scoredRows = [];
  const fallbackRows = [];

  for (const src of sources) {
    let rows = [];
    try { rows = JSON.parse(src.rows_json || '[]'); } catch {}
    if (!Array.isArray(rows) || rows.length === 0) continue;

    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      if (fallbackRows.length < 5) fallbackRows.push({ sourceName: src.name, row: r });
      if (tokens.length === 0) continue;

      const rowVals = Object.values(r).map(normDataText);
      const joined = rowVals.join(' ');
      let score = 0;
      for (const tok of tokens) {
        if (rowVals.some(v => v === tok || v.split(/\s+/).includes(tok))) {
          score += 3;
        } else if (joined.includes(tok)) {
          score += 1;
        }
      }
      if (score > 0) {
        scoredRows.push({ score, sourceName: src.name, row: r });
      }
    }
  }

  scoredRows.sort((a, b) => b.score - a.score);
  const picked = scoredRows.length > 0 ? scoredRows.slice(0, 8) : fallbackRows.slice(0, 5);
  if (picked.length === 0) return '';

  const lines = picked.map((item, i) => {
    const kv = Object.entries(item.row)
      .filter(([, v]) => String(v || '').trim() !== '')
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    return `${i + 1}. [${item.sourceName}] ${kv}`;
  });

  return `DATOS EN VIVO DE TU HOJA / TABLA CONECTADA (ÚSALOS COMO FUENTE VERIFICADA DE VERDAD):\n${lines.join('\n')}`;
}

function sanitizeTenant(tenant) {
  if (!tenant) return null;
  const { password_hash, elevenlabs_api_key, dashboard_prefs, enabled_modules, ...rest } = tenant;
  return {
    ...rest,
    dashboard_prefs: parseDashboardPrefs(dashboard_prefs),
    enabled_modules: parseEnabledModules(enabled_modules),
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

/**
 * Decididor IA: evalúa si debe responder con 1 o más audios pregrabados (unidos en una sola nota de voz),
 * con texto, o con audio + dato puntual en texto.
 */
async function decideTenantReplyWithAudioLibrary(tenant, activeAudios, history, incomingText, liveDataContext = '') {
  const audioCatalog = activeAudios.map(a => (
    `- ID ${a.id} | Título: "${a.title}" (${a.duration_sec || 5}s) | Cuándo usarlo: ${a.trigger_description}`
  )).join('\n');

  const systemInstruction = [
    tenant.system_prompt || `Eres el asistente virtual oficial de ${tenant.business_name}.`,
    `Tono de atención: ${tenant.bot_tone || 'amigable'}.`,
    tenant.business_description ? `Descripción del negocio: ${tenant.business_description}` : '',
    tenant.knowledge_base ? `BASE DE CONOCIMIENTO:\n${tenant.knowledge_base}` : '',
    liveDataContext || '',
    `\nBIBLIOTECA DE AUDIOS PREGRABADOS DISPONIBLES:\n${audioCatalog}`,
    `\nINSTRUCCIONES DEL DECIDIDOR DE RESPUESTA (OBLIGATORIO):
Responde ÚNICAMENTE con un JSON válido con este formato exacto:
{
  "mode": "audio" | "text" | "audio_and_text",
  "audio_ids": [1, 2],
  "reply_text": "",
  "reason": "Explicación breve en español sencillo (1 frase) de por qué elegiste este audio o respuesta."
}
Reglas para decidir:
1. Si la intención del cliente encaja con uno o más audios disponibles (ej. saludo + precios, o explicación + medios de pago), elige "mode": "audio" y pon en "audio_ids" los IDs en el orden lógico en que deben unirse en una sola nota de voz fluida (máximo 4 audios).
2. Usa "mode": "audio_and_text" solo si además del audio hace falta dejar por escrito un dato puntual (un número de cuenta, un enlace o un valor exacto que esté en la base de conocimiento).
3. Si ningún audio aplica a lo que preguntó el cliente, usa "mode": "text", deja "audio_ids": [] y redacta en "reply_text" una respuesta humana, natural y breve para WhatsApp.`
  ].filter(Boolean).join('\n\n');

  const raw = await callLlmCompletion(
    [
      { role: 'system', content: systemInstruction },
      ...history.slice(-8),
      { role: 'user', content: incomingText }
    ],
    { temperature: 0.35, maxTokens: 600, jsonMode: true }
  );

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  const validMap = new Map(activeAudios.map(a => [Number(a.id), a]));
  const pickedIds = Array.isArray(parsed.audio_ids)
    ? parsed.audio_ids.map(n => Number(n)).filter(id => validMap.has(id)).slice(0, 4)
    : [];

  let mode = parsed.mode;
  if (pickedIds.length === 0) mode = 'text';
  else if (mode !== 'audio' && mode !== 'audio_and_text') mode = 'audio';

  return {
    mode,
    pickedAudios: pickedIds.map(id => validMap.get(id)),
    replyText: String(parsed.reply_text || '').trim(),
    reason: String(parsed.reason || '').trim()
  };
}

/**
 * Envía nota de voz nativa PTT simulando grabación humana proporcional a la duración (sin marca de reenviado).
 */
async function sendHumanVoiceNote(client, chatId, oggBuffer, durationSec = 5) {
  const recMs = Math.min(Math.max(3500, (Number(durationSec) || 5) * 650), 14000) + randomBetween(200, 900);
  const chat = await client.getChatById(chatId).catch(() => null);
  if (chat) await chat.sendStateRecording().catch(() => {});
  await sleep(recMs);
  const media = new MessageMedia('audio/ogg; codecs=opus', oggBuffer.toString('base64'), 'voice.ogg');
  const sent = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
  markBotSentMessage(sent);
  if (chat) await chat.clearState().catch(() => {});
}

/**
 * Envía imagen adjunta (por flujo de producto/oferta) con pausa natural y caption opcional.
 */
async function sendHumanImage(client, chatId, imagePath, caption = '') {
  if (!imagePath || !fs.existsSync(imagePath)) return false;
  await sleep(randomBetween(1100, 2100));
  const media = MessageMedia.fromFilePath(imagePath);
  const sent = await client.sendMessage(chatId, media, caption ? { caption } : {});
  markBotSentMessage(sent);
  return true;
}

/**
 * Envía texto simulando escritura humana proporcional al largo del mensaje.
 */
async function sendHumanText(client, chatId, text) {
  const typeMs = Math.min(Math.max(1500, String(text || '').length * 38), 7500) + randomBetween(200, 700);
  const chat = await client.getChatById(chatId).catch(() => null);
  if (chat) await chat.sendStateTyping().catch(() => {});
  await sleep(typeMs);
  const sent = await client.sendMessage(chatId, text);
  markBotSentMessage(sent);
  if (chat) await chat.clearState().catch(() => {});
}

function getTenantSessionDir(tenantId) {
  return path.join(SESSIONS_ROOT, `session-saas-tenant-${tenantId}`);
}

function cleanChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { force: true }); } catch {}
    }
  }
}

function getTenantSessionState(tenantId) {
  const mem = sessions.get(Number(tenantId));
  if (!mem) {
    return { status: 'DISCONNECTED', qrDataUrl: null, pairingCode: null, qrUpdatedAt: null, phone: null, lastError: null };
  }
  return {
    status: mem.status || 'DISCONNECTED',
    qrDataUrl: mem.qrDataUrl || null,
    pairingCode: mem.pairingCode || null,
    qrUpdatedAt: mem.qrUpdatedAt || null,
    phone: mem.phone || null,
    lastError: mem.lastError || null
  };
}

function parseDecisionMeta(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function logTenantMessage(tenantId, customerJid, direction, messageType, body, decisionMeta = null) {
  try {
    const metaJson = decisionMeta ? JSON.stringify(decisionMeta).slice(0, 4000) : null;
    await pool.query(
      'INSERT INTO saas_bot_messages_log (tenant_id, customer_jid, direction, message_type, body, decision_meta) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, customerJid, direction, messageType, String(body || '').slice(0, 4000), metaJson]
    );
  } catch (err) {
    console.warn(`[SaaS Bot #${tenantId}] Error guardando log:`, err.message);
  }
}

function enqueueTenantBatch(tenantId, remoteJid, items) {
  const prev = tenantQueues.get(tenantId) || Promise.resolve();
  const next = prev
    .then(() => processHumanTenantBatch(tenantId, remoteJid, items))
    .catch(err => {
      console.error(`[SaaS Bot #${tenantId}] Error en cola humana:`, err.message);
    })
    .then(() => sleep(randomBetween(2500, 5500)));

  tenantQueues.set(tenantId, next);
}

async function processHumanTenantBatch(tenantId, remoteJid, batchItems) {
  const tenant = await getTenantById(tenantId);
  if (!tenant || tenant.status !== 'active' || !tenant.is_bot_active) return;

  if (tenant.expires_at && new Date(tenant.expires_at).getTime() < Date.now()) {
    console.warn(`[SaaS Bot #${tenantId}] Suscripción vencida (${tenant.expires_at}).`);
    return;
  }

  if (tenant.monthly_message_limit > 0 && tenant.messages_used_month >= tenant.monthly_message_limit) {
    console.warn(`[SaaS Bot #${tenantId}] Límite mensual alcanzado (${tenant.messages_used_month}/${tenant.monthly_message_limit}).`);
    return;
  }

  const sess = sessions.get(Number(tenantId));
  if (!sess || !sess.client || sess.status !== 'CONNECTED') return;

  const isVoiceMsg = batchItems.some(x => x.isVoice);
  const combinedText = batchItems.map(x => x.text).filter(Boolean).join('\n').trim();
  const incomingText = combinedText || 'Hola, te envié una nota de voz. ¿Me puedes ayudar?';

  await logTenantMessage(tenantId, remoteJid, 'in', isVoiceMsg ? 'audio' : 'text', incomingText);

  const pauseState = getChatPauseState(tenantId, remoteJid);
  if (pauseState.isPaused) {
    console.log(`[SaaS Bot #${tenantId}] ⏸️ Chat ${remoteJid} en control manual hasta ${new Date(pauseState.pausedUntil).toLocaleTimeString('es-CO')} — bot pausado.`);
    return;
  }

  // Pausa humana antes de marcar mensajes como leídos en WhatsApp Web
  await sleep(randomBetween(1200, 2800));
  const chat = await sess.client.getChatById(remoteJid).catch(() => null);
  if (chat) {
    await chat.sendSeen().catch(() => {});
  }

  const histKey = `${tenantId}:${remoteJid}`;
  const history = chatHistories.get(histKey) || [];

  const [activeAudios] = await pool.query(
    'SELECT id, title, trigger_description, file_path, image_path, image_filename, followup_text, duration_sec FROM saas_bot_audios WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
    [tenantId]
  );

  const liveDataContext = await buildLiveDataContextForMessage(tenant, incomingText).catch(() => '');

  let sentType = 'text';
  let logSummary = '';
  let decisionMeta = null;

  if (activeAudios.length > 0) {
    let decision;
    try {
      decision = await decideTenantReplyWithAudioLibrary(tenant, activeAudios, history, incomingText, liveDataContext);
    } catch (err) {
      console.error(`[SaaS Bot #${tenantId}] Error en decididor de audios:`, err.message);
      return;
    }

    decisionMeta = {
      mode: decision.mode,
      audioIds: decision.pickedAudios.map(a => Number(a.id)),
      audioTitles: decision.pickedAudios.map(a => a.title),
      reason: decision.reason || ''
    };

    if ((decision.mode === 'audio' || decision.mode === 'audio_and_text') && decision.pickedAudios.length > 0) {
      try {
        const audioPaths = decision.pickedAudios.map(a => a.file_path);
        const built = await elevenLabsService.buildFreshWhatsAppVoiceNoteFromFiles(audioPaths, { pauseMs: 350 });
        await sendHumanVoiceNote(sess.client, remoteJid, built.oggBuffer, built.durationSec);
        const titles = decision.pickedAudios.map(a => a.title).join(' + ');
        sentType = 'audio';
        logSummary = `[Nota de voz: ${titles} (${built.durationSec}s)]`;

        const sentFollowups = new Set();
        for (const picked of decision.pickedAudios) {
          const cleanFollowup = picked.followup_text ? String(picked.followup_text).trim() : '';
          if (picked.image_path && fs.existsSync(picked.image_path)) {
            await sendHumanImage(sess.client, remoteJid, picked.image_path, cleanFollowup);
            sentType = 'flow';
            logSummary += `\n[Imagen: ${picked.image_filename || 'adjunta'}]`;
            if (cleanFollowup) {
              logSummary += `\n${cleanFollowup}`;
              sentFollowups.add(cleanFollowup);
            }
          } else if (cleanFollowup && !sentFollowups.has(cleanFollowup)) {
            await sleep(randomBetween(900, 1800));
            await sendHumanText(sess.client, remoteJid, cleanFollowup);
            sentType = 'audio+text';
            logSummary += `\n${cleanFollowup}`;
            sentFollowups.add(cleanFollowup);
          }
        }

        if (decision.mode === 'audio_and_text' && decision.replyText && !sentFollowups.has(decision.replyText.trim())) {
          await sleep(randomBetween(1000, 2200));
          await sendHumanText(sess.client, remoteJid, decision.replyText);
          sentType = sentType === 'flow' ? 'flow' : 'audio+text';
          logSummary += `\n${decision.replyText}`;
        }
      } catch (audioErr) {
        console.warn(`[SaaS Bot #${tenantId}] Error armando nota de voz de biblioteca:`, audioErr.message);
        if (decision.replyText) {
          await sendHumanText(sess.client, remoteJid, decision.replyText);
          logSummary = decision.replyText;
        } else {
          return;
        }
      }
    } else if (decision.replyText) {
      await sendHumanText(sess.client, remoteJid, decision.replyText);
      logSummary = decision.replyText;
    } else {
      return;
    }

    history.push({ role: 'user', content: incomingText });
    history.push({ role: 'assistant', content: logSummary });
    chatHistories.set(histKey, history.slice(-12));
  } else {
    // Flujo clásico (texto o ElevenLabs TTS) si el cliente no ha subido audios pregrabados
    const systemInstruction = [
      tenant.system_prompt || `Eres el asistente virtual oficial de ${tenant.business_name}.`,
      `Tono de atención: ${tenant.bot_tone || 'amigable'}.`,
      tenant.business_description ? `Descripción del negocio: ${tenant.business_description}` : '',
      tenant.knowledge_base ? `BASE DE CONOCIMIENTO:\n${tenant.knowledge_base}` : '',
      liveDataContext || '',
      'Regla de WhatsApp: responde claro, conciso y natural en español sin inventar datos no confirmados.'
    ].filter(Boolean).join('\n\n');

    let replyText;
    try {
      replyText = await callLlmCompletion([
        { role: 'system', content: systemInstruction },
        ...history.slice(-8),
        { role: 'user', content: incomingText }
      ], { temperature: 0.5, maxTokens: 550 });
    } catch (err) {
      console.error(`[SaaS Bot #${tenantId}] Error generando respuesta IA:`, err.message);
      return;
    }

    history.push({ role: 'user', content: incomingText });
    history.push({ role: 'assistant', content: replyText });
    chatHistories.set(histKey, history.slice(-12));

    const shouldReplyVoice = Boolean(
      tenant.elevenlabs_enabled &&
      tenant.elevenlabs_api_key &&
      tenant.elevenlabs_voice_id &&
      (tenant.reply_mode === 'voice' || (tenant.reply_mode === 'auto_match' && isVoiceMsg))
    );

    if (shouldReplyVoice) {
      try {
        const mp3Buf = await elevenLabsService.textToSpeechMp3(replyText, {
          apiKey: tenant.elevenlabs_api_key,
          voiceId: tenant.elevenlabs_voice_id,
          modelId: tenant.elevenlabs_model_id || 'eleven_multilingual_v2'
        });
        const oggBuf = await elevenLabsService.convertMp3ToWhatsAppOgg(mp3Buf);
        const approxSec = Math.max(4, Math.round(replyText.length / 15));
        await sendHumanVoiceNote(sess.client, remoteJid, oggBuf, approxSec);
        sentType = 'audio';
      } catch (voiceErr) {
        console.warn(`[SaaS Bot #${tenantId}] Falló voz ElevenLabs, enviando texto:`, voiceErr.message);
        await sendHumanText(sess.client, remoteJid, replyText);
      }
    } else {
      await sendHumanText(sess.client, remoteJid, replyText);
    }
    logSummary = replyText;
  }

  await pool.query(
    'UPDATE saas_bot_tenants SET messages_used_month = messages_used_month + 1, usage_reset_month = ? WHERE id = ?',
    [getCurrentMonthKey(), tenantId]
  );
  await logTenantMessage(tenantId, remoteJid, 'out', sentType, logSummary, decisionMeta);
}

function handleIncomingTenantMessage(tenantId, msg) {
  const remoteJid = msg?.from;
  if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.includes('@newsletter') || msg.fromMe) {
    return;
  }

  const isVoiceMsg = msg.type === 'ptt' || msg.type === 'audio';
  const rawText = String(msg.body || '').trim();

  if (!rawText && !isVoiceMsg) return;

  // Agrupa ráfagas de mensajes del mismo cliente durante 5.5s antes de procesar en la cola humana
  const batchKey = `${tenantId}:${remoteJid}`;
  let batch = incomingBatches.get(batchKey);
  if (!batch) {
    batch = { items: [], timer: null };
    incomingBatches.set(batchKey, batch);
  }
  batch.items.push({ text: rawText, isVoice: isVoiceMsg });

  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    const done = incomingBatches.get(batchKey);
    incomingBatches.delete(batchKey);
    if (done && done.items.length > 0) {
      enqueueTenantBatch(tenantId, remoteJid, done.items);
    }
  }, 5500);
}

/**
 * Fuerza la inicialización completa de WhatsApp Web (Store, WWebJS, ClientInfo, listeners y evento ready)
 * para evitar sesiones autenticadas en 1.34.6 que no emiten 'ready' tras vincular.
 */
async function ensureTenantClientReady(id, client, stateObj) {
  if (!client || !client.pupPage || stateObj?.manualStop) return false;
  try {
    await client.pupPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const continueBtn = buttons.find(b => b.innerText && (
        b.innerText.toLowerCase().includes('continuar') ||
        b.innerText.toLowerCase().includes('aceptar') ||
        b.innerText.toLowerCase().includes('entendido')
      ));
      if (continueBtn) continueBtn.click();
    }).catch(() => {});

    const hasStore = await client.pupPage.evaluate(() => typeof window.Store !== 'undefined').catch(() => false);
    if (!hasStore) return false;

    const hasWWebJS = await client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined').catch(() => false);
    if (!hasWWebJS) {
      const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
      await client.pupPage.evaluate(LoadUtils);
    }

    await client.pupPage.evaluate(() => {
      try {
        const WAWebMsgKey = window.require ? window.require('WAWebMsgKey') : null;
        if (WAWebMsgKey && WAWebMsgKey.prototype && !WAWebMsgKey.prototype._serialized) {
          Object.defineProperty(WAWebMsgKey.prototype, '_serialized', {
            get() { return this.toString(); },
            configurable: true
          });
        }
      } catch (_) {}
    }).catch(() => {});

    if (!client.info || !client.info.wid) {
      const ClientInfo = require('whatsapp-web.js/src/structures/ClientInfo');
      const InterfaceController = require('whatsapp-web.js/src/util/InterfaceController');
      const infoData = await client.pupPage.evaluate(() => {
        const user = window.Store.User ? (
          (typeof window.Store.User.getMaybeMePnUser === 'function' && window.Store.User.getMaybeMePnUser()) ||
          (typeof window.Store.User.getMaybeMeLidUser === 'function' && window.Store.User.getMaybeMeLidUser()) ||
          null
        ) : null;
        const conn = window.Store.Conn ? window.Store.Conn.serialize() : {};
        return { ...conn, wid: user };
      }).catch(() => null);
      if (infoData && infoData.wid) {
        client.info = new ClientInfo(client, infoData);
        client.interface = new InterfaceController(client);
      }
    }

    const hasPageListeners = await client.pupPage.evaluate(() => Boolean(window.__whatbotListenersAttached)).catch(() => false);
    if (!client._eventsAttached || !hasPageListeners) {
      let attachedInPage = false;
      try {
        await Promise.race([
          client.attachEventListeners(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('attachEventListeners timeout (15s)')), 15000))
        ]);
        attachedInPage = true;
      } catch (attErr) {
        console.warn(`[SaaS Bot #${id}] ⚠️ attachEventListeners falló o dio timeout:`, attErr.message);
        attachedInPage = await client.pupPage.evaluate(() => {
          try {
            if (window.Store && window.Store.Msg && typeof window.onAddMessageEvent === 'function') {
              window.Store.Msg.off('add');
              window.Store.Msg.on('add', (msg) => {
                if (msg && msg.isNewMsg && window.WWebJS) {
                  window.onAddMessageEvent(window.WWebJS.getMessageModel(msg));
                }
              });
              return true;
            }
          } catch (_) {}
          return false;
        }).catch(() => false);
      }
      if (attachedInPage) {
        await client.pupPage.evaluate(() => { window.__whatbotListenersAttached = true; }).catch(() => {});
        client._eventsAttached = true;
      }
    }

    if (!client._readyEmitted) {
      client._readyEmitted = true;
      console.log(`[SaaS Bot #${id}] 🎉 Conexión completada tras autenticación. Emitiendo ready...`);
      client.emit('ready');
    }
    return true;
  } catch (err) {
    console.warn(`[SaaS Bot #${id}] ⚠️ Error en ensureTenantClientReady:`, err.message);
    return false;
  }
}

/**
 * Inicia o recupera la sesión WhatsApp Web real (whatsapp-web.js + LocalAuth) de un cliente SaaS.
 */
async function startTenantSession(tenantId, options = {}) {
  await ensureSaasBotTables();
  const id = Number(tenantId);
  const attempt = Number(options.attempt || 1);
  const forceRestart = Boolean(options.forceRestart);
  const existing = sessions.get(id);
  if (!forceRestart && existing && (existing.isStarting || existing.status === 'CONNECTED' || existing.status === 'QR_READY' || existing.status === 'PAIRING_CODE_READY')) {
    return getTenantSessionState(id);
  }

  if (existing) {
    if (existing.startupWatchdog) {
      clearTimeout(existing.startupWatchdog);
      existing.startupWatchdog = null;
    }
    if (existing.authReadyInterval) {
      clearInterval(existing.authReadyInterval);
      existing.authReadyInterval = null;
    }
    if (existing.client) {
      try { await existing.client.destroy(); } catch {}
    }
  }

  const sessionDir = getTenantSessionDir(id);
  cleanChromiumLocks(sessionDir);

  const stateObj = {
    client: null,
    status: 'CONNECTING',
    qrDataUrl: null,
    pairingCode: null,
    qrUpdatedAt: null,
    phone: null,
    lastError: null,
    isStarting: true,
    manualStop: false,
    startupWatchdog: null,
    authReadyInterval: null
  };
  const clearStartupWatchdog = () => {
    if (stateObj.startupWatchdog) {
      clearTimeout(stateObj.startupWatchdog);
      stateObj.startupWatchdog = null;
    }
  };
  const clearAuthReadyInterval = () => {
    if (stateObj.authReadyInterval) {
      clearInterval(stateObj.authReadyInterval);
      stateObj.authReadyInterval = null;
    }
  };
  sessions.set(id, stateObj);

  try {
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `saas-tenant-${id}`,
        dataPath: SESSIONS_ROOT
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials'
        ],
        timeout: 60000,
        protocolTimeout: 180000
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      webVersionCache: {
        type: 'none'
      },
      markOnlineAvailable: false,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 15000
    });

    stateObj.client = client;

    client.on('qr', async (qr) => {
      try {
        clearStartupWatchdog();
        stateObj.qrUpdatedAt = Date.now();
        stateObj.isStarting = false;
        stateObj.lastError = null;
        if (stateObj.status === 'PAIRING_CODE_READY' && stateObj.pairingCode) {
          return;
        }
        stateObj.qrDataUrl = await qrcode.toDataURL(qr);
        stateObj.status = 'QR_READY';
        await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['QR_READY', id]).catch(() => {});
        console.log(`[SaaS Bot #${id}] 📷 QR de WhatsApp Web generado`);
      } catch (qrErr) {
        stateObj.lastError = qrErr.message;
      }
    });

    client.on('code', async (code) => {
      try {
        clearStartupWatchdog();
        const cleanCode = String(code || '').trim();
        if (!cleanCode) return;
        stateObj.pairingCode = cleanCode;
        stateObj.qrDataUrl = null;
        stateObj.qrUpdatedAt = Date.now();
        stateObj.isStarting = false;
        stateObj.status = 'PAIRING_CODE_READY';
        stateObj.lastError = null;
        await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['PAIRING_CODE_READY', id]).catch(() => {});
        console.log(`[SaaS Bot #${id}] 🔢 Código de vinculación actualizado: ${cleanCode}`);
      } catch (codeErr) {
        stateObj.lastError = codeErr.message;
      }
    });

    client.on('loading_screen', (percent, message) => {
      clearStartupWatchdog();
      console.log(`[SaaS Bot #${id}] ⏳ Sincronizando chats (${percent}%${message ? ` - ${message}` : ''})...`);
      if (stateObj.status !== 'CONNECTED') {
        stateObj.lastError = `Sincronizando chats (${percent}%)...`;
      }
    });

    client.on('authenticated', () => {
      clearStartupWatchdog();
      clearAuthReadyInterval();
      stateObj.status = 'CONNECTING';
      stateObj.isStarting = true;
      stateObj.qrDataUrl = null;
      stateObj.pairingCode = null;
      stateObj.lastError = 'Sesión vinculada en el celular. Sincronizando chats...';
      client._eventsAttached = false;
      console.log(`[SaaS Bot #${id}] ✅ [AUTENTICADO] Sesión validada en WhatsApp Web. Verificando estado ready...`);

      let checks = 0;
      stateObj.authReadyInterval = setInterval(async () => {
        checks++;
        if (checks > 60 || stateObj.manualStop) {
          clearAuthReadyInterval();
          return;
        }
        try {
          const ready = await ensureTenantClientReady(id, client, stateObj);
          if (ready && client._eventsAttached) {
            clearAuthReadyInterval();
          }
        } catch (_) {}
      }, 2000);
    });

    client.on('ready', async () => {
      clearStartupWatchdog();
      clearAuthReadyInterval();
      client._readyEmitted = true;
      const phone = client.info?.wid?.user ? String(client.info.wid.user).replace(/\D/g, '') : null;
      stateObj.status = 'CONNECTED';
      stateObj.isStarting = false;
      stateObj.qrDataUrl = null;
      stateObj.pairingCode = null;
      stateObj.qrUpdatedAt = null;
      stateObj.phone = phone;
      stateObj.lastError = null;
      await pool.query(
        'UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = ?, last_connected_at = NOW() WHERE id = ?',
        ['CONNECTED', phone, id]
      ).catch(() => {});
      console.log(`[SaaS Bot #${id}] ✅ WhatsApp Web conectado (${phone || 'OK'})`);
    });

    client.on('auth_failure', async (msg) => {
      clearStartupWatchdog();
      clearAuthReadyInterval();
      stateObj.isStarting = false;
      stateObj.status = 'DISCONNECTED';
      stateObj.qrDataUrl = null;
      stateObj.lastError = msg || 'Error de autenticación de WhatsApp Web';
      await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['DISCONNECTED', id]).catch(() => {});
      console.error(`[SaaS Bot #${id}] Error auth_failure:`, msg);
    });

    client.on('disconnected', async (reason) => {
      clearStartupWatchdog();
      clearAuthReadyInterval();
      stateObj.isStarting = false;
      stateObj.qrDataUrl = null;
      const loggedOut = String(reason || '').toUpperCase().includes('LOGOUT');
      if (stateObj.manualStop || loggedOut) {
        stateObj.status = 'DISCONNECTED';
        stateObj.phone = null;
        if (loggedOut) {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        }
        await pool.query('UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = NULL WHERE id = ?', ['DISCONNECTED', id]).catch(() => {});
        console.log(`[SaaS Bot #${id}] Sesión cerrada (${reason || 'manual'}).`);
      } else {
        stateObj.status = 'CONNECTING';
        stateObj.lastError = `Reconectando (${reason || 'desconexión'})...`;
        setTimeout(() => {
          const cur = sessions.get(id);
          if (cur && !cur.manualStop) {
            cur.status = 'DISCONNECTED';
            cur.isStarting = false;
            startTenantSession(id).catch(() => {});
          }
        }, 5000);
      }
    });

    client.on('message', (msg) => {
      handleIncomingTenantMessage(id, msg);
    });

    client.on('message_create', async (msg) => {
      try {
        if (!msg || !msg.fromMe) return;
        const msgId = msg.id?._serialized;
        if (msgId && botSentMessageIds.has(msgId)) return;

        const targetChat = msg.to || msg.from;
        if (!targetChat || targetChat.endsWith('@g.us') || targetChat === 'status@broadcast' || targetChat.includes('@newsletter')) {
          return;
        }

        const tenant = await getTenantById(id).catch(() => null);
        const pauseMins = tenant && tenant.human_pause_minutes !== undefined ? Number(tenant.human_pause_minutes) : 30;
        if (pauseMins > 0) {
          setChatPauseState(id, targetChat, pauseMins, 'human');
          console.log(`[SaaS Bot #${id}] 👤 Intervención humana detectada en ${targetChat} -> bot pausado ${pauseMins} min.`);
        }

        const manualBody = String(msg.body || '').trim() || (msg.hasMedia ? '[Archivo enviado manualmente]' : '[Mensaje manual]');
        await logTenantMessage(id, targetChat, 'out', 'human', manualBody);
      } catch (e) {
        console.warn(`[SaaS Bot #${id}] Error en listener message_create:`, e.message);
      }
    });

    await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['CONNECTING', id]).catch(() => {});
    clearStartupWatchdog();
    stateObj.startupWatchdog = setTimeout(async () => {
      stateObj.startupWatchdog = null;
      if (stateObj.manualStop || !stateObj.isStarting || stateObj.status !== 'CONNECTING') return;
      console.warn(`[SaaS Bot #${id}] ⏱️ Timeout iniciando WhatsApp Web (55s sin QR/ready, intento ${attempt}/3). Limpiando sesión y reintentando...`);
      try { await client.destroy(); } catch {}
      try {
        const [[tRow]] = await pool.query('SELECT last_connected_at FROM saas_bot_tenants WHERE id = ? LIMIT 1', [id]);
        if (!tRow?.last_connected_at || attempt >= 2) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } catch {}
      if (attempt < 3 && !stateObj.manualStop) {
        startTenantSession(id, { attempt: attempt + 1, forceRestart: true }).catch(() => {});
      } else {
        stateObj.isStarting = false;
        stateObj.status = 'DISCONNECTED';
        stateObj.lastError = 'No se pudo generar el QR a tiempo. Pulsa "Reiniciar conexión" e intenta de nuevo.';
        await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['DISCONNECTED', id]).catch(() => {});
      }
    }, 55000);

    client.initialize().catch(async (initErr) => {
      clearStartupWatchdog();
      clearAuthReadyInterval();
      const errMsg = initErr?.message || 'No se pudo iniciar WhatsApp Web';
      if (!stateObj.manualStop && attempt < 3 && /Minified invariant|Execution context was destroyed|Target closed|Protocol error/i.test(errMsg)) {
        console.warn(`[SaaS Bot #${id}] ⚠️ Error transitorio al iniciar (intento ${attempt}/3): ${errMsg}. Reintentando en 2.5s...`);
        stateObj.status = 'CONNECTING';
        stateObj.isStarting = true;
        stateObj.lastError = 'Reiniciando conexión con WhatsApp Web...';
        try { await client.destroy(); } catch {}
        await sleep(2500);
        if (!stateObj.manualStop) {
          startTenantSession(id, { attempt: attempt + 1, forceRestart: true }).catch(() => {});
        }
        return;
      }
      stateObj.isStarting = false;
      stateObj.status = 'DISCONNECTED';
      stateObj.lastError = errMsg;
      await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['DISCONNECTED', id]).catch(() => {});
      console.error(`[SaaS Bot #${id}] Error en client.initialize():`, errMsg);
    });
  } catch (err) {
    clearStartupWatchdog();
    clearAuthReadyInterval();
    stateObj.isStarting = false;
    stateObj.status = 'DISCONNECTED';
    stateObj.lastError = err.message;
    console.error(`[SaaS Bot #${id}] Error iniciando sesión whatsapp-web.js:`, err.message);
  }

  return getTenantSessionState(id);
}

async function disconnectTenantSession(tenantId) {
  const id = Number(tenantId);
  const mem = sessions.get(id);
  const sessionDir = getTenantSessionDir(id);
  const legacyDir = path.join(SESSIONS_ROOT, `tenant_${id}`);

  if (mem) {
    mem.manualStop = true;
    if (mem.startupWatchdog) {
      clearTimeout(mem.startupWatchdog);
      mem.startupWatchdog = null;
    }
    if (mem.authReadyInterval) {
      clearInterval(mem.authReadyInterval);
      mem.authReadyInterval = null;
    }
    mem.status = 'DISCONNECTED';
    mem.qrDataUrl = null;
    if (mem.client) {
      try { await mem.client.logout(); } catch {}
      try { await mem.client.destroy(); } catch {}
    }
    sessions.delete(id);
  }

  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  await ensureSaasBotTables();
  await pool.query('UPDATE saas_bot_tenants SET wa_status = ?, wa_phone = NULL WHERE id = ?', ['DISCONNECTED', id]);
  return { status: 'DISCONNECTED', qrDataUrl: null, pairingCode: null, qrUpdatedAt: null, phone: null };
}

async function requestTenantPairingCode(tenantId, rawPhone) {
  const id = Number(tenantId);
  let cleanPhone = String(rawPhone || '').replace(/\D/g, '');
  if (cleanPhone.length === 10 && cleanPhone.startsWith('3')) {
    cleanPhone = `57${cleanPhone}`;
  }
  if (cleanPhone.length < 10) {
    throw new Error('Ingresa un número de WhatsApp válido (mínimo 10 dígitos, ej. 3001234567 o 573001234567).');
  }

  let mem = sessions.get(id);
  if (!mem || mem.status === 'DISCONNECTED' || !mem.client) {
    await startTenantSession(id);
    mem = sessions.get(id);
  }

  if (mem && mem.status === 'CONNECTED') {
    throw new Error('Tu WhatsApp ya está conectado.');
  }

  // Esperar hasta 45s a que WhatsApp Web alcance la pantalla de autenticación (QR_READY / PAIRING_CODE_READY)
  // antes de invocar requestPairingCode, evitando condiciones de carrera con Store/MasterKey (#56367).
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    mem = sessions.get(id);
    if (mem && mem.status === 'CONNECTED') {
      throw new Error('Tu WhatsApp ya está conectado.');
    }
    if (mem && mem.client && (mem.status === 'QR_READY' || mem.status === 'PAIRING_CODE_READY')) {
      break;
    }
    if (mem && mem.status === 'DISCONNECTED' && !mem.isStarting) {
      break;
    }
    await sleep(500);
  }

  mem = sessions.get(id);
  if (!mem || !mem.client || (mem.status !== 'QR_READY' && mem.status !== 'PAIRING_CODE_READY')) {
    throw new Error(mem?.lastError || 'WhatsApp Web aún está terminando de cargar. Espera unos segundos e intenta nuevamente.');
  }

  try {
    let code;
    try {
      code = await mem.client.requestPairingCode(cleanPhone);
    } catch (firstErr) {
      const firstMsg = firstErr?.message || String(firstErr);
      if (/Minified invariant|56367|Cannot read properties of undefined/i.test(firstMsg)) {
        await sleep(2500);
        code = await mem.client.requestPairingCode(cleanPhone);
      } else {
        throw firstErr;
      }
    }
    if (!code) {
      throw new Error('WhatsApp no devolvió código numérico en este intento.');
    }
    mem.pairingCode = String(code).trim();
    mem.qrDataUrl = null;
    mem.qrUpdatedAt = Date.now();
    mem.status = 'PAIRING_CODE_READY';
    mem.isStarting = false;
    mem.lastError = null;
    await pool.query('UPDATE saas_bot_tenants SET wa_status = ? WHERE id = ?', ['PAIRING_CODE_READY', id]).catch(() => {});
    console.log(`[SaaS Bot #${id}] 🔢 Código de vinculación generado para ${cleanPhone}: ${mem.pairingCode}`);
    return { pairingCode: mem.pairingCode, session: getTenantSessionState(id) };
  } catch (err) {
    let msg = err?.message || String(err);
    let serialized = '';
    try { serialized = JSON.stringify(err); } catch {}
    if (/Minified invariant|56367/i.test(msg)) {
      msg = 'WhatsApp Web todavía estaba terminando de iniciar (error interno temporal). Espera 5 segundos e intenta de nuevo, o usa el código QR.';
    } else if (msg === 't' || serialized.includes('rate-overlimit') || serialized.includes('429') || err?.name === 'CompanionHelloError') {
      msg = 'WhatsApp limitó temporalmente las solicitudes para este número (429). Espera 3 a 5 minutos o intenta con el código QR.';
    }
    mem.lastError = msg;
    throw new Error(msg);
  }
}

async function sendTenantAudioOrText(tenantId, targetPhone, { text, oggBuffer, durationSec = 5 } = {}) {
  const id = Number(tenantId);
  const mem = sessions.get(id);
  if (!mem || !mem.client || mem.status !== 'CONNECTED') {
    throw new Error('Tu WhatsApp no está conectado. Escanea el código QR primero.');
  }

  const digits = String(targetPhone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error('Número de destino inválido (mínimo 10 dígitos).');
  }
  const normalized = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
  const numberId = await mem.client.getNumberId(normalized).catch(() => null);
  const chatId = numberId?._serialized || `${normalized}@c.us`;

  if (oggBuffer) {
    await sendHumanVoiceNote(mem.client, chatId, oggBuffer, durationSec);
    await logTenantMessage(id, chatId, 'out', 'audio', text || '[Nota de voz enviada]');
  } else if (text) {
    await sendHumanText(mem.client, chatId, text);
    await logTenantMessage(id, chatId, 'out', 'text', text);
  }
}

async function sendManualFlowToChat(tenantId, chatId, { audioIds = [], text = '' } = {}) {
  const id = Number(tenantId);
  const mem = sessions.get(id);
  if (!mem || !mem.client || mem.status !== 'CONNECTED') {
    throw new Error('Tu WhatsApp no está conectado. Vincula tu línea primero.');
  }

  const cleanIds = Array.isArray(audioIds) ? audioIds.map(Number).filter(n => n > 0) : [];
  const cleanText = String(text || '').trim();
  if (cleanIds.length === 0 && !cleanText) {
    throw new Error('Selecciona un audio/flujo o escribe un mensaje.');
  }

  let logSummary = '';
  let msgType = 'human';

  if (cleanIds.length > 0) {
    const [rows] = await pool.query(
      `SELECT id, title, file_path, image_path, image_filename, followup_text
       FROM saas_bot_audios
       WHERE tenant_id = ? AND id IN (${cleanIds.map(() => '?').join(',')})`,
      [id, ...cleanIds]
    );
    const byId = new Map(rows.map(r => [Number(r.id), r]));
    const ordered = cleanIds.map(aid => byId.get(aid)).filter(Boolean);
    if (ordered.length === 0) {
      throw new Error('Audio o flujo no encontrado.');
    }

    const built = await elevenLabsService.buildFreshWhatsAppVoiceNoteFromFiles(
      ordered.map(r => r.file_path),
      { pauseMs: 350 }
    );
    await sendHumanVoiceNote(mem.client, chatId, built.oggBuffer, built.durationSec);
    logSummary = `[Envío rápido: ${ordered.map(r => r.title).join(' + ')} (${built.durationSec}s)]`;
    msgType = 'manual_flow';

    const sentFollowups = new Set();
    for (const item of ordered) {
      const followup = item.followup_text ? String(item.followup_text).trim() : '';
      if (item.image_path && fs.existsSync(item.image_path)) {
        await sendHumanImage(mem.client, chatId, item.image_path, followup);
        logSummary += `\n[Imagen: ${item.image_filename || 'adjunta'}]`;
        if (followup) {
          logSummary += `\n${followup}`;
          sentFollowups.add(followup);
        }
      } else if (followup && !sentFollowups.has(followup)) {
        await sleep(randomBetween(900, 1700));
        await sendHumanText(mem.client, chatId, followup);
        logSummary += `\n${followup}`;
        sentFollowups.add(followup);
      }
    }
  }

  if (cleanText) {
    if (cleanIds.length > 0) await sleep(randomBetween(800, 1500));
    await sendHumanText(mem.client, chatId, cleanText);
    logSummary = logSummary ? `${logSummary}\n${cleanText}` : cleanText;
  }

  const tenant = await getTenantById(id).catch(() => null);
  const pauseMins = tenant && tenant.human_pause_minutes !== undefined ? Number(tenant.human_pause_minutes) : 30;
  if (pauseMins > 0) {
    setChatPauseState(id, chatId, pauseMins, 'manual');
  }

  await logTenantMessage(id, chatId, 'out', msgType, logSummary);
  return { sent: true, summary: logSummary, pauseState: getChatPauseState(id, chatId) };
}

async function autoRestoreSavedSessions() {
  try {
    await ensureSaasBotTables();
    const [rows] = await pool.query("SELECT id FROM saas_bot_tenants WHERE status = 'active' AND wa_status = 'CONNECTED'");
    for (const row of rows) {
      if (fs.existsSync(getTenantSessionDir(row.id))) {
        console.log(`[SaaS Bot] 🔄 Restaurando sesión WhatsApp Web guardada del cliente #${row.id}...`);
        startTenantSession(row.id).catch(err => {
          console.warn(`[SaaS Bot] No se pudo restaurar cliente #${row.id}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[SaaS Bot] Error restaurando sesiones guardadas:', err.message);
  }
}

/**
 * Analiza una duda o propuesta de ajuste de mejora usando la sesión oficial de Antigravity CLI (agy),
 * respondiendo al cliente en lenguaje cercano y práctico (sin tecnicismos) y clasificando internamente
 * si aplica solo a la capa del cliente o a la clase madre.
 */
async function analyzeTenantImprovement(tenant, { messageLog = null, previousInMsg = null, activeAudios = [], clientQuestion = '' } = {}) {
  const audioCatalog = activeAudios.length > 0
    ? activeAudios.map(a => `- ID ${a.id} | "${a.title}" (${a.duration_sec || 5}s) | Cuándo usarlo: ${a.trigger_description}`).join('\n')
    : '(El cliente aún no tiene audios pregrabados configurados)';

  const [lastConvRows] = await pool.query(
    "SELECT agy_conversation_id FROM saas_bot_improvements WHERE tenant_id = ? AND agy_conversation_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    [tenant.id]
  );
  const prevAgyConvId = lastConvRows.length > 0 ? lastConvRows[0].agy_conversation_id : null;

  const systemInstruction = 'Eres el asistente consultor de Sheerit Bot Studio conectado con el motor de mejora continua. Analizas comportamientos de bots de WhatsApp para explicar de forma amable y CERO técnica por qué el bot actuó así y qué ajuste práctico conviene hacer.';

  const prompt = `Analiza esta duda o solicitud de ajuste de mejora de un cliente de Sheerit Bot Studio.

DATOS DEL NEGOCIO:
- Negocio: ${tenant.business_name} (${tenant.owner_name})
- Descripción: ${tenant.business_description || 'No especificada'}
- Instrucciones actuales (system_prompt): ${tenant.system_prompt || '(vacío)'}
- Base de conocimiento: ${tenant.knowledge_base || '(vacía)'}

BIBLIOTECA DE AUDIOS DEL CLIENTE:
${audioCatalog}

CONVERSACIÓN ESPECÍFICA CONSULTADA:
- Mensaje del cliente final: ${previousInMsg?.body || '(consulta general sin mensaje específico)'}
- Respuesta enviada por el bot: ${messageLog?.body || '(no aplica)'}
- Motivo interno registrado: ${messageLog?.decision_meta ? JSON.stringify(messageLog.decision_meta) : 'sin traza previa'}

PREGUNTA O MEJORA QUE PIDE EL DUEÑO DEL BOT:
"${clientQuestion}"

REGLAS CRÍTICAS DE RESPUESTA:
1. "explanation_plain" y "practical_proposal" son PARA EL CLIENTE FINAL (dueño del negocio):
   - Tono positivo, cercano, práctico y **100% libre de palabras técnicas** (prohibido hablar de prompts, JSON, regex, tokens, Baileys, Puppeteer, API, backend, base de datos, etc.).
   - Si el cliente preguntó "¿por qué envió este audio o esta respuesta?", explica claramente qué frase o contexto del cliente activó ese audio/respuesta y cómo evitar confusiones si quiere cambiarlo.
2. Clasifica "scope":
   - "tenant_config": si se resuelve ajustando las reglas del negocio o cuándo usar un audio específico de su biblioteca.
   - "core_engine": solo si requiere cambiar el motor general del sistema para todos los clientes (por ejemplo: reproducir o transcribir notas de voz entrantes de clientes finales, manejo global de tiempos de espera, formato de archivos o fallos del motor).
3. Si "scope" es "tenant_config" y aplica un ajuste:
   - Pon en "proposed_prompt_addition" una regla breve y clara en español para agregar a las instrucciones de su bot (si es solo una pregunta explicativa sin cambios necesarios, déjalo vacío "").
   - Si conviene ajustar la descripción de cuándo usar uno de sus audios, indica "proposed_audio_id" (número exacto del ID de su lista, o null) y "proposed_audio_trigger" (la nueva descripción clara de cuándo usarlo).

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "explanation_plain": "...",
  "scope": "tenant_config",
  "practical_proposal": "...",
  "proposed_prompt_addition": "...",
  "proposed_audio_id": null,
  "proposed_audio_trigger": "",
  "technical_summary": "Resumen técnico breve para el equipo de Sheerit General."
}`;

  let parsed = null;
  let agyConvId = prevAgyConvId || null;

  try {
    const rawAgy = await callAgyCli(prompt, systemInstruction, prevAgyConvId, { timeoutMs: 45000 });
    if (rawAgy) {
      const extracted = extractJsonFromAgyOutput(rawAgy);
      if (extracted && (extracted.explanation_plain || extracted.practical_proposal)) {
        parsed = extracted;
        if (extracted.conversationId) agyConvId = extracted.conversationId;
      }
    }
  } catch (agyErr) {
    console.warn('[SaaS Improvement] Falló llamada a agy, usando fallback LLM:', agyErr.message);
  }

  if (!parsed) {
    const rawLlm = await callLlmCompletion(
      [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ],
      { temperature: 0.3, maxTokens: 900, jsonMode: true }
    );
    const cleaned = rawLlm.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  }

  const validAudioIds = new Set(activeAudios.map(a => Number(a.id)));
  const candidateAudioId = parsed.proposed_audio_id ? Number(parsed.proposed_audio_id) : null;
  const safeAudioId = candidateAudioId && validAudioIds.has(candidateAudioId) ? candidateAudioId : null;

  return {
    explanation_plain: String(parsed.explanation_plain || 'Revisamos tu consulta y analizamos cómo respondió tu bot según tus instrucciones actuales.').trim(),
    scope: parsed.scope === 'core_engine' ? 'core_engine' : 'tenant_config',
    practical_proposal: String(parsed.practical_proposal || 'Podemos reforzar esta indicación en la configuración de tu bot para mayor precisión.').trim(),
    proposed_prompt_addition: String(parsed.proposed_prompt_addition || '').trim(),
    proposed_audio_id: safeAudioId,
    proposed_audio_trigger: safeAudioId ? String(parsed.proposed_audio_trigger || '').trim() : '',
    technical_summary: String(parsed.technical_summary || '').trim(),
    agy_conversation_id: agyConvId
  };
}

async function acceptTenantImprovement(tenantId, improvementId) {
  await ensureSaasBotTables();
  const [rows] = await pool.query(
    'SELECT * FROM saas_bot_improvements WHERE id = ? AND tenant_id = ? LIMIT 1',
    [Number(improvementId), Number(tenantId)]
  );
  if (rows.length === 0) throw new Error('Ajuste de mejora no encontrado.');
  const imp = rows[0];

  if (imp.status === 'applied' || imp.status === 'queued_restart') {
    return { improvement: imp };
  }

  await pool.query(
    "UPDATE saas_bot_improvements SET status = 'accepted' WHERE id = ? AND tenant_id = ?",
    [imp.id, Number(tenantId)]
  );

  const [updatedRows] = await pool.query(
    `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
            explanation_plain, scope, practical_proposal, proposed_prompt_addition,
            proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
     FROM saas_bot_improvements WHERE id = ? LIMIT 1`,
    [imp.id]
  );
  return { improvement: updatedRows[0] };
}

async function applyTenantImprovement(tenantId, improvementId, { waClient = null } = {}) {
  await ensureSaasBotTables();
  const [rows] = await pool.query(
    'SELECT * FROM saas_bot_improvements WHERE id = ? AND tenant_id = ? LIMIT 1',
    [Number(improvementId), Number(tenantId)]
  );
  if (rows.length === 0) throw new Error('Ajuste de mejora no encontrado.');
  const imp = rows[0];

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error('Cuenta no encontrada.');

  if (imp.scope === 'core_engine' || imp.status === 'escalated_core') {
    if (imp.status !== 'queued_restart') {
      await pool.query(
        "UPDATE saas_bot_improvements SET status = 'queued_restart', applied_at = NOW() WHERE id = ? AND tenant_id = ?",
        [imp.id, tenant.id]
      );
      if (waClient && typeof waClient.sendMessage === 'function') {
        const queueMsg =
          `⏳ *[MEJORA EN FILA PARA REINICIO #${imp.id}]*\n\n` +
          `🏢 *Negocio:* ${tenant.business_name} (${tenant.owner_name})\n` +
          `💬 *Solicitud:* "${String(imp.client_question || '').slice(0, 220)}"\n` +
          `⚙️ *Estado:* Aceptada por el cliente y puesta en fila (NO se reinició el servidor global).\n` +
          `🔗 *Sesión agy:* ${imp.agy_conversation_id || 'sin sesión'}`;
        waClient.sendMessage('120363102144405222@g.us', queueMsg, { sendSeen: false }).catch(() => {});
      }
    }
    const [updatedQueuedRows] = await pool.query(
      `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
              explanation_plain, scope, practical_proposal, proposed_prompt_addition,
              proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
       FROM saas_bot_improvements WHERE id = ? LIMIT 1`,
      [imp.id]
    );
    return { improvement: updatedQueuedRows[0], tenant, queuedForRestart: true };
  }

  if (imp.status === 'applied') {
    throw new Error('Este ajuste ya está aplicado en tu bot.');
  }

  let prevAudioTrigger = null;
  if (imp.proposed_audio_id) {
    const [aRows] = await pool.query(
      'SELECT id, trigger_description FROM saas_bot_audios WHERE id = ? AND tenant_id = ? LIMIT 1',
      [imp.proposed_audio_id, tenant.id]
    );
    if (aRows.length > 0) prevAudioTrigger = aRows[0].trigger_description;
  }

  const snapshot = {
    system_prompt: tenant.system_prompt || '',
    audio_id: imp.proposed_audio_id || null,
    audio_trigger_description: prevAudioTrigger
  };

  if (imp.proposed_prompt_addition && String(imp.proposed_prompt_addition).trim()) {
    const addition = `[Ajuste #${imp.id}] ${String(imp.proposed_prompt_addition).trim()}`;
    const nextPrompt = tenant.system_prompt && tenant.system_prompt.trim()
      ? `${tenant.system_prompt.trim()}\n\n${addition}`
      : addition;
    await pool.query('UPDATE saas_bot_tenants SET system_prompt = ? WHERE id = ?', [nextPrompt, tenant.id]);
  }

  if (imp.proposed_audio_id && imp.proposed_audio_trigger && String(imp.proposed_audio_trigger).trim()) {
    await pool.query(
      'UPDATE saas_bot_audios SET trigger_description = ? WHERE id = ? AND tenant_id = ?',
      [String(imp.proposed_audio_trigger).trim(), imp.proposed_audio_id, tenant.id]
    );
  }

  // Recargar únicamente la instancia de chats en memoria de este cliente sin reiniciar el servidor global
  const tenantPrefix = `${tenant.id}:`;
  for (const key of chatHistories.keys()) {
    if (String(key).startsWith(tenantPrefix)) {
      chatHistories.delete(key);
    }
  }

  await pool.query(
    "UPDATE saas_bot_improvements SET status = 'applied', applied_at = NOW(), previous_snapshot = ? WHERE id = ?",
    [JSON.stringify(snapshot), imp.id]
  );

  const [updatedImpRows] = await pool.query(
    `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
            explanation_plain, scope, practical_proposal, proposed_prompt_addition,
            proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
     FROM saas_bot_improvements WHERE id = ? LIMIT 1`,
    [imp.id]
  );
  const updatedTenant = await getTenantById(tenant.id);
  return { improvement: updatedImpRows[0], tenant: updatedTenant, queuedForRestart: false };
}

async function revertTenantImprovement(tenantId, improvementId) {
  await ensureSaasBotTables();
  const [rows] = await pool.query(
    'SELECT * FROM saas_bot_improvements WHERE id = ? AND tenant_id = ? LIMIT 1',
    [Number(improvementId), Number(tenantId)]
  );
  if (rows.length === 0) throw new Error('Ajuste de mejora no encontrado.');
  const imp = rows[0];

  if (imp.status !== 'applied') {
    throw new Error('Solo puedes deshacer ajustes que estén actualmente aplicados.');
  }

  let snapshot = null;
  try {
    snapshot = imp.previous_snapshot ? JSON.parse(imp.previous_snapshot) : null;
  } catch {}

  if (!snapshot) {
    throw new Error('No se encontró el respaldo previo para deshacer este ajuste.');
  }

  if (typeof snapshot.system_prompt === 'string') {
    await pool.query('UPDATE saas_bot_tenants SET system_prompt = ? WHERE id = ?', [snapshot.system_prompt, tenantId]);
  }

  if (snapshot.audio_id && typeof snapshot.audio_trigger_description === 'string') {
    await pool.query(
      'UPDATE saas_bot_audios SET trigger_description = ? WHERE id = ? AND tenant_id = ?',
      [snapshot.audio_trigger_description, snapshot.audio_id, tenantId]
    );
  }

  await pool.query(
    "UPDATE saas_bot_improvements SET status = 'reverted', reverted_at = NOW() WHERE id = ?",
    [imp.id]
  );

  const [updatedImpRows] = await pool.query(
    `SELECT id, tenant_id, message_log_id, customer_jid, incoming_text, bot_reply, client_question,
            explanation_plain, scope, practical_proposal, proposed_prompt_addition,
            proposed_audio_id, proposed_audio_trigger, status, applied_at, reverted_at, created_at
     FROM saas_bot_improvements WHERE id = ? LIMIT 1`,
    [imp.id]
  );
  const updatedTenant = await getTenantById(tenantId);
  return { improvement: updatedImpRows[0], tenant: updatedTenant };
}

async function handleEscalateCoreCommand(improvementIdRaw, client, replyFn) {
  await ensureSaasBotTables();
  const improvementId = Number(improvementIdRaw);
  const [rows] = await pool.query(
    `SELECT i.*, t.business_name, t.owner_name, t.email
     FROM saas_bot_improvements i
     JOIN saas_bot_tenants t ON i.tenant_id = t.id
     WHERE i.id = ? LIMIT 1`,
    [improvementId]
  );

  if (rows.length === 0) {
    if (replyFn) await replyFn(`⚠️ No encontré el ajuste de mejora #${improvementId}.`).catch(() => {});
    return;
  }

  const imp = rows[0];
  await pool.query("UPDATE saas_bot_improvements SET status = 'escalated_core' WHERE id = ?", [imp.id]);

  const errorsGroupId = '120363427163636523@g.us';
  const msgForErrorsBot =
    `🧠 *[ESCALADO DESDE SHEERIT GENERAL — CLASE MADRE BOT SAAS #${imp.id}]*\n\n` +
    `🏢 *Negocio origen:* ${imp.business_name} (${imp.owner_name})\n` +
    `💬 *Solicitud del cliente:* "${imp.client_question}"\n` +
    (imp.incoming_text ? `📥 *Cliente final:* "${String(imp.incoming_text).slice(0, 220)}"\n` : '') +
    (imp.bot_reply ? `🤖 *Respuesta bot:* "${String(imp.bot_reply).slice(0, 220)}"\n` : '') +
    `⚙️ *Diagnóstico técnico (agy):* ${imp.technical_summary || imp.practical_proposal}\n` +
    (imp.agy_conversation_id ? `🔗 *Sesión agy:* ${imp.agy_conversation_id}\n` : '') +
    `\n📂 *Módulo objetivo:* \`services/saasBotManager.js\` / \`routes/saasBotRoutes.js\``;

  if (client && typeof client.sendMessage === 'function') {
    await client.sendMessage(errorsGroupId, msgForErrorsBot, { sendSeen: false }).catch(e => {
      console.error('[Escalate Core] Error enviando a Errors bot:', e.message);
    });
  }

  if (replyFn) {
    await replyFn(`✅ Ajuste *#${imp.id}* escalado a *Errors bot* para revisión e implementación en la clase madre.`).catch(() => {});
  }
}

/**
 * Simula un turno completo en el Modo Prueba usando el mismo decididor e instrucciones reales
 * sin requerir WhatsApp conectado, sin enviar mensajes reales ni consumir cuota mensual.
 */
async function simulateTenantChatTurn(tenantId, { messages = [], history = [], humanPaused = false } = {}) {
  await ensureSaasBotTables();
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error('Cuenta de bot no encontrada.');

  const cleanMessages = (Array.isArray(messages) ? messages : [messages])
    .map(m => String(m || '').trim())
    .filter(Boolean);
  if (cleanMessages.length === 0) {
    throw new Error('Escribe al menos un mensaje de prueba.');
  }
  const incomingText = cleanMessages.join('\n');

  if (humanPaused) {
    return {
      pausedByHuman: true,
      mode: 'paused',
      incomingText,
      pickedAudios: [],
      replyText: '',
      reason: `Chat en control manual (${tenant.human_pause_minutes ?? 30} min): el bot permanece en silencio mientras el asesor atiende.`,
      assistantHistorySummary: ''
    };
  }

  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && String(h.content || '').trim())
    .map(h => ({ role: h.role, content: String(h.content) }))
    .slice(-12);

  const [activeAudios] = await pool.query(
    'SELECT id, title, trigger_description, file_path, image_path, image_filename, followup_text, duration_sec FROM saas_bot_audios WHERE tenant_id = ? AND is_active = 1 ORDER BY id ASC',
    [tenant.id]
  );

  const liveDataContext = await buildLiveDataContextForMessage(tenant, incomingText).catch(() => '');

  if (activeAudios.length > 0) {
    const decision = await decideTenantReplyWithAudioLibrary(tenant, activeAudios, safeHistory, incomingText, liveDataContext);
    const pickedAudios = decision.pickedAudios.map(a => ({
      id: Number(a.id),
      title: a.title,
      duration_sec: Number(a.duration_sec || 5),
      hasImage: Boolean(a.image_path && fs.existsSync(a.image_path)),
      image_filename: a.image_filename || null,
      followup_text: a.followup_text ? String(a.followup_text).trim() : ''
    }));

    let assistantHistorySummary = '';
    if ((decision.mode === 'audio' || decision.mode === 'audio_and_text') && pickedAudios.length > 0) {
      const titles = pickedAudios.map(a => a.title).join(' + ');
      const totalDur = pickedAudios.reduce((acc, a) => acc + (Number(a.duration_sec) || 5), 0);
      assistantHistorySummary = `[Nota de voz: ${titles} (${totalDur}s)]`;
      const sentFollowups = new Set();
      for (const picked of pickedAudios) {
        if (picked.hasImage) {
          assistantHistorySummary += `\n[Imagen: ${picked.image_filename || 'adjunta'}]`;
          if (picked.followup_text) {
            assistantHistorySummary += `\n${picked.followup_text}`;
            sentFollowups.add(picked.followup_text);
          }
        } else if (picked.followup_text && !sentFollowups.has(picked.followup_text)) {
          assistantHistorySummary += `\n${picked.followup_text}`;
          sentFollowups.add(picked.followup_text);
        }
      }
      if (decision.mode === 'audio_and_text' && decision.replyText && !sentFollowups.has(decision.replyText.trim())) {
        assistantHistorySummary += `\n${decision.replyText}`;
      }
    } else if (decision.replyText) {
      assistantHistorySummary = decision.replyText;
    }

    return {
      pausedByHuman: false,
      mode: decision.mode,
      incomingText,
      pickedAudios,
      replyText: decision.replyText || '',
      reason: decision.reason || '',
      assistantHistorySummary
    };
  }

  const systemInstruction = [
    tenant.system_prompt || `Eres el asistente virtual oficial de ${tenant.business_name}.`,
    `Tono de atención: ${tenant.bot_tone || 'amigable'}.`,
    tenant.business_description ? `Descripción del negocio: ${tenant.business_description}` : '',
    tenant.knowledge_base ? `BASE DE CONOCIMIENTO:\n${tenant.knowledge_base}` : '',
    liveDataContext || '',
    'Regla de WhatsApp: responde claro, conciso y natural en español sin inventar datos no confirmados.'
  ].filter(Boolean).join('\n\n');

  const replyText = await callLlmCompletion(
    [
      { role: 'system', content: systemInstruction },
      ...safeHistory.slice(-8),
      { role: 'user', content: incomingText }
    ],
    { temperature: 0.5, maxTokens: 550 }
  );

  return {
    pausedByHuman: false,
    mode: 'text',
    incomingText,
    pickedAudios: [],
    replyText: String(replyText || '').trim(),
    reason: 'Respuesta en texto generada con tus instrucciones (sin audios activos).',
    assistantHistorySummary: String(replyText || '').trim()
  };
}

const saasBillingLastReminderDate = new Map();

function calculateTenantMonthlyTotal(tenant) {
  const plan = String(tenant?.plan_name || '').toLowerCase();
  let base = Number(tenant?.amount_paid || 0);
  if (!base || base <= 0) {
    if (plan.includes('scale') || plan.includes('60')) base = 60000;
    else if (plan.includes('starter') || plan.includes('10')) base = 10000;
    else base = 30000;
  }
  const modules = parseEnabledModules(tenant?.enabled_modules);
  let includedSlots = 0;
  if (plan.includes('scale') || plan.includes('60')) includedSlots = 3;
  else if (plan.includes('pro') || plan.includes('básico') || plan.includes('basico') || plan.includes('30') || plan.includes('retailer')) includedSlots = 1;

  const extraModules = Math.max(0, modules.length - includedSlots);
  const addonCost = extraModules * 25000;
  return base + addonCost;
}

function formatBotBillingMessage(tenant, daysLeft) {
  const totalMonthly = calculateTenantMonthlyTotal(tenant);
  const expStr = tenant.expires_at
    ? new Date(tenant.expires_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
    : 'hoy';
  const statusLine = daysLeft > 0
    ? `tu plan *${tenant.plan_name || 'Bot Studio'}* vence en *${daysLeft} día(s)* (${expStr}).`
    : daysLeft === 0
      ? `tu plan *${tenant.plan_name || 'Bot Studio'}* vence *hoy* (${expStr}).`
      : `tu plan *${tenant.plan_name || 'Bot Studio'}* venció el *${expStr}*.`;

  const modules = parseEnabledModules(tenant.enabled_modules);
  const modText = modules.length > 0 ? `\n🧩 *Módulos activos:* ${modules.join(', ')}` : '';

  return (
    `🤖 *Aviso de Renovación — Sheerit Bot Studio*\n\n` +
    `Hola ${tenant.owner_name || tenant.business_name}! 👋 Te recordamos que ${statusLine}${modText}\n\n` +
    `💰 *Total a transferir:* $${totalMonthly.toLocaleString('es-CO')} COP\n` +
    `🔑 *Llave Bre-V (Nequi / Daviplata / Bancos):* \`0087387259\`\n` +
    `🏦 *Bancolombia Ahorros:* \`46772753713\` (CC: \`1032936324\`)\n\n` +
    `Envíanos el comprobante por aquí para renovar tus 30 días de inmediato sin interrumpir tu bot de WhatsApp. 🙌`
  );
}

async function runSaasBillingCheck(waClient = null) {
  await ensureSaasBotTables();
  const [tenants] = await pool.query(
    "SELECT * FROM saas_bot_tenants WHERE status = 'active' AND expires_at IS NOT NULL"
  );
  const now = new Date();
  const bogotaTodayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now);
  const todayMidnight = new Date(`${bogotaTodayStr}T00:00:00-05:00`).getTime();

  let reminded = 0;
  let paused = 0;

  for (const t of tenants) {
    if (!t.expires_at) continue;
    const expDayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(t.expires_at));
    const expMidnight = new Date(`${expDayStr}T00:00:00-05:00`).getTime();
    const daysLeft = Math.round((expMidnight - todayMidnight) / 86400000);

    // Auto-pausar bot si lleva más de 3 días vencido
    if (daysLeft < -3 && Number(t.is_bot_active) === 1) {
      await pool.query('UPDATE saas_bot_tenants SET is_bot_active = 0 WHERE id = ?', [t.id]);
      paused++;
      console.log(`[SaaS Billing] ⏸️ Bot SaaS #${t.id} (${t.business_name}) pausado por mora (${Math.abs(daysLeft)} días vencido).`);
    }

    // Enviar aviso automático cuando falten exactamente 2 días o el día de corte (0)
    if ((daysLeft === 2 || daysLeft === 0) && waClient && typeof waClient.sendMessage === 'function') {
      const lastSent = saasBillingLastReminderDate.get(t.id);
      if (lastSent === bogotaTodayStr) continue;
      const rawPhone = String(t.wa_phone || '').replace(/\D/g, '');
      if (rawPhone.length < 10) continue;
      const targetJid = rawPhone.length === 10 && rawPhone.startsWith('3') ? `57${rawPhone}@c.us` : `${rawPhone}@c.us`;
      try {
        await waClient.sendMessage(targetJid, formatBotBillingMessage(t, daysLeft));
        saasBillingLastReminderDate.set(t.id, bogotaTodayStr);
        reminded++;
        console.log(`[SaaS Billing] 📩 Recordatorio enviado a Tenant #${t.id} (${targetJid}, daysLeft=${daysLeft}).`);
      } catch (err) {
        console.warn(`[SaaS Billing] Error enviando recordatorio a Tenant #${t.id}:`, err.message);
      }
    }
  }

  return { checked: tenants.length, reminded, paused };
}

module.exports = {
  ensureSaasBotTables,
  getTenantById,
  sanitizeTenant,
  parseDashboardPrefs,
  updateTenantDashboardPrefs,
  parseEnabledModules,
  setTenantEnabledModules,
  syncGoogleSheetSource,
  importUploadedTableSource,
  listTenantDataSources,
  deleteTenantDataSource,
  syncRetailerStoreToTenant,
  linkRetailerStoreToTenant,
  unlinkRetailerStoreFromTenant,
  getLinkedStoreForTenant,
  generateSaasBotConfig,
  startTenantSession,
  disconnectTenantSession,
  requestTenantPairingCode,
  getTenantSessionState,
  sendTenantAudioOrText,
  sendManualFlowToChat,
  simulateTenantChatTurn,
  getChatPauseState,
  setChatPauseState,
  autoRestoreSavedSessions,
  getCurrentMonthKey,
  parseDecisionMeta,
  analyzeTenantImprovement,
  acceptTenantImprovement,
  applyTenantImprovement,
  revertTenantImprovement,
  handleEscalateCoreCommand,
  calculateTenantMonthlyTotal,
  formatBotBillingMessage,
  runSaasBillingCheck
};
