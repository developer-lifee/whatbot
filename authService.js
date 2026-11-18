const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'sheerit-admin-session-secret-2026';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const RESET_CODE_TTL_MINUTES = 15;
const ADMIN_FALLBACK_WA = '573118587974@c.us';

/**
 * Hashea una contraseña usando bcryptjs.
 */
async function hashPassword(plainPassword) {
  return bcrypt.hash(String(plainPassword), 10);
}

/**
 * Verifica una contraseña contra el hash almacenado.
 * Si el agente aún no tiene password_hash (migración gradual), acepta 'admin123'.
 */
async function verifyAgentPassword(plainPassword, storedHash) {
  const candidate = String(plainPassword || '').trim();
  if (!candidate) {
    return { valid: false, needsPasswordSetup: false };
  }

  if (!storedHash || !String(storedHash).trim()) {
    const isDefault = candidate.toLowerCase() === 'admin123';
    return { valid: isDefault, needsPasswordSetup: isDefault };
  }

  const hashStr = String(storedHash).trim();
  if (hashStr.startsWith('$2a$') || hashStr.startsWith('$2b$') || hashStr.startsWith('$2y$')) {
    const match = await bcrypt.compare(candidate, hashStr);
    return { valid: match, needsPasswordSetup: false };
  }

  // Fallback legacy sha256
  const sha = crypto.createHash('sha256').update(candidate).digest('hex');
  const match = sha === hashStr;
  return { valid: match, needsPasswordSetup: false };
}

/**
 * Firma un token de sesión HMAC-SHA256 sin dependencias externas.
 */
function signSessionToken(payload) {
  const data = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS
  };
  const encoded = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verifica y decodifica un token de sesión HMAC-SHA256.
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Genera un código numérico de 6 dígitos y su hash SHA-256 para almacenamiento seguro.
 */
function generateResetCode() {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  return { code, codeHash };
}

function hashResetCode(code) {
  return crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
}

/**
 * Normaliza un número colombiano o internacional a formato WhatsApp JID (@c.us).
 */
function toWhatsAppJid(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  const normalized = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
  return `${normalized}@c.us`;
}

function maskTarget(target) {
  if (!target) return 'WhatsApp autorizado';
  const digits = String(target).replace(/\D/g, '');
  if (digits.length >= 4) {
    return `WhatsApp terminado en ${digits.slice(-4)}`;
  }
  return 'Grupo de Administración (WhatsApp)';
}

/**
 * Envía el código de recuperación por WhatsApp al agente (o fallback al admin/grupo).
 */
async function sendRecoveryCodeViaWhatsApp(client, agent, code, groupId) {
  if (!client) {
    throw new Error('El cliente de WhatsApp no está conectado en este momento.');
  }

  const directJid = toWhatsAppJid(agent.phone);
  const isAdmin = agent.role === 'admin' || (agent.email || '').toLowerCase() === 'estebanavila182@outlook.com';
  const targetJid = directJid || (isAdmin ? ADMIN_FALLBACK_WA : groupId);

  if (!targetJid) {
    throw new Error('No hay un número de WhatsApp o grupo configurado para entregar el código.');
  }

  const messageText =
    `🔐 *Recuperación de Contraseña - Panel Sheerit*\n\n` +
    `👤 *Usuario:* ${agent.fullname} (${agent.email})\n` +
    `🔑 *Código de verificación:* *${code}*\n\n` +
    `⏳ Este código es válido por *${RESET_CODE_TTL_MINUTES} minutos*.\n` +
    `⚠️ Si no solicitaste este cambio, ignora este mensaje.`;

  await client.sendMessage(targetJid, messageText);

  const deliveryChannel = directJid || isAdmin ? 'whatsapp_direct' : 'whatsapp_group';
  return {
    deliveryChannel,
    maskedTarget: deliveryChannel === 'whatsapp_group'
      ? 'Grupo de Administración en WhatsApp'
      : maskTarget(targetJid)
  };
}

module.exports = {
  RESET_CODE_TTL_MINUTES,
  hashPassword,
  verifyAgentPassword,
  signSessionToken,
  verifySessionToken,
  generateResetCode,
  hashResetCode,
  sendRecoveryCodeViaWhatsApp
};
