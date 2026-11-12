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

async function shortenUrl(originalUrl) {
    if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
    const trimmed = originalUrl.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed;
    if (trimmed.includes('/l/')) return trimmed;

    // Verificar si la URL ya existe en el almacén
    for (const [code, item] of Object.entries(urlStore)) {
        if (item && item.targetUrl === trimmed) {
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
        createdAt: new Date().toISOString()
    };
    saveStore();

    return `${BASE_DOMAIN}/l/${code}`;
}

function getTargetUrl(code) {
    if (!code) return null;
    if (urlStore[code]) {
        return urlStore[code].targetUrl;
    }
    loadStore();
    if (urlStore[code]) {
        return urlStore[code].targetUrl;
    }
    return null;
}

module.exports = {
    shortenUrl,
    getTargetUrl,
    generateSlug
};