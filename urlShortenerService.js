const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHORT_URLS_FILE = path.join(__dirname, 'short_urls.json');
const BASE_DOMAIN = process.env.BASE_URL || 'https://sheerit.co';

let urlStore = {};

function loadStore() {
    try {
        if (fs.existsSync(SHORT_URLS_FILE)) {
            const data = fs.readFileSync(SHORT_URLS_FILE, 'utf8');
            urlStore = JSON.parse(data);
        }
    } catch (e) {
        console.error('[urlShortener] Error cargando short_urls.json:', e.message);
        urlStore = {};
    }
}

function saveStore() {
    try {
        fs.writeFileSync(SHORT_URLS_FILE, JSON.stringify(urlStore, null, 2), 'utf8');
    } catch (e) {
        console.error('[urlShortener] Error guardando short_urls.json:', e.message);
    }
}

loadStore();

function generateSlug(length = 6) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let slug = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        slug += chars[bytes[i] % chars.length];
    }
    return slug;
}

async function shortenUrl(originalUrl, meta = null) {
    if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
    const trimmed = originalUrl.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed;
    if (trimmed.includes('/l/')) return trimmed;

    // Verificar si la URL ya existe en el almacén
    for (const [code, item] of Object.entries(urlStore)) {
        if (item && item.targetUrl === trimmed) {
            if (meta && !item.meta) {
                item.meta = meta;
                saveStore();
            }
            return `${BASE_DOMAIN}/l/${code}`;
        }
    }

    let code = generateSlug(6);
    while (urlStore[code]) {
        code = generateSlug(6);
    }

    urlStore[code] = {
        code,
        targetUrl: trimmed,
        createdAt: new Date().toISOString(),
        ...(meta ? { meta } : {}),
        hits: []
    };
    saveStore();

    return `${BASE_DOMAIN}/l/${code}`;
}

function getUrlRecord(code) {
    if (!code) return null;
    if (urlStore[code]) return urlStore[code];
    loadStore();
    return urlStore[code] || null;
}

function getTargetUrl(code) {
    const rec = getUrlRecord(code);
    return rec ? rec.targetUrl : null;
}

function recordShortUrlHit(code, hitInfo = {}) {
    const rec = getUrlRecord(code);
    if (!rec) return null;
    if (!Array.isArray(rec.hits)) rec.hits = [];
    rec.hits.push({
        at: new Date().toISOString(),
        ip: hitInfo.ip || 'unknown',
        deviceLabel: hitInfo.deviceLabel || 'Desconocido'
    });
    if (rec.hits.length > 10) {
        rec.hits = rec.hits.slice(-10);
    }
    saveStore();
    return rec;
}

module.exports = {
    shortenUrl,
    getTargetUrl,
    getUrlRecord,
    recordShortUrlHit,
    generateSlug
};