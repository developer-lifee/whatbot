// Middleware de seguridad HTTP y Rate Limiting en memoria para Express (sin dependencias externas)

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (first) return first;
    }
    const xRealIp = req.headers['x-real-ip'];
    if (xRealIp && typeof xRealIp === 'string' && xRealIp.trim()) {
        return xRealIp.trim();
    }
    return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
}

/**
 * Crea un rate limiter por IP (ventana deslizante) con respuesta HTTP 429 y header Retry-After.
 * Adjunta req.resetRateLimit() para limpiar el contador en caso de autenticación exitosa.
 */
function createRateLimiter({
    name = 'default',
    windowMs = 15 * 60 * 1000,
    maxAttempts = 5,
    message = 'Demasiados intentos. Por favor espera unos minutos antes de volver a intentarlo.'
} = {}) {
    const buckets = new Map();

    // Limpieza periódica de IPs inactivas para evitar crecimiento de memoria
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, timestamps] of buckets.entries()) {
            const recent = timestamps.filter(ts => now - ts < windowMs);
            if (recent.length === 0) {
                buckets.delete(key);
            } else {
                buckets.set(key, recent);
            }
        }
    }, Math.min(windowMs, 10 * 60 * 1000));
    if (cleanupInterval.unref) cleanupInterval.unref();

    return function rateLimitMiddleware(req, res, next) {
        const ip = getClientIp(req);
        const now = Date.now();
        const existing = buckets.get(ip) || [];
        const recent = existing.filter(ts => now - ts < windowMs);

        if (recent.length >= maxAttempts) {
            const oldest = recent[0];
            const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
            buckets.set(ip, recent);
            res.setHeader('Retry-After', String(retryAfterSeconds));
            console.warn(`[SECURITY RATE-LIMIT:${name}] 🚫 IP ${ip} bloqueada (${recent.length}/${maxAttempts} intentos). Retry-After: ${retryAfterSeconds}s`);
            return res.status(429).json({
                success: false,
                message: `${message} (Intenta de nuevo en ${Math.ceil(retryAfterSeconds / 60)} min).`,
                retryAfterSeconds
            });
        }

        recent.push(now);
        buckets.set(ip, recent);

        req.resetRateLimit = () => {
            buckets.delete(ip);
        };

        next();
    };
}

module.exports = {
    getClientIp,
    securityHeadersMiddleware,
    createRateLimiter
};
