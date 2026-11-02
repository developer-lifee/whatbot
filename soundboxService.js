const express = require('express');
const router = express.Router();
const { pool } = require('./database');

// GET /api/soundbox/:imei/status
router.get('/:imei/status', async (req, res) => {
    const imei = String(req.params.imei || '').trim();
    if (!imei) {
        return res.status(400).json({ error: 'IMEI requerido' });
    }

    try {
        const [rows] = await pool.query(
            'SELECT imei, serial_number, business_name, phone_key, configured, last_seen FROM soundbox_terminals WHERE imei = ?',
            [imei]
        );

        if (rows.length === 0) {
            // Auto-registrar terminal nuevo
            await pool.query(
                'INSERT INTO soundbox_terminals (imei, configured) VALUES (?, FALSE) ON DUPLICATE KEY UPDATE last_seen=NOW()',
                [imei]
            );
            return res.json({
                imei,
                configured: false,
                business_name: 'SIN VINCULAR',
                phone_key: ''
            });
        }

        const terminal = rows[0];
        // Actualizar ping
        await pool.query('UPDATE soundbox_terminals SET last_seen=NOW() WHERE imei = ?', [imei]);

        return res.json({
            imei: terminal.imei,
            serial_number: terminal.serial_number,
            configured: Boolean(terminal.configured),
            business_name: terminal.business_name || 'SIN VINCULAR',
            phone_key: terminal.phone_key || ''
        });
    } catch (err) {
        console.error('[Soundbox API Error]:', err);
        return res.status(500).json({ error: 'Error interno del servidor', details: err.message });
    }
});

// POST /api/soundbox/:imei/activate
router.post('/:imei/activate', express.json(), async (req, res) => {
    const imei = String(req.params.imei || '').trim();
    const { business_name, phone_key } = req.body || {};

    if (!imei) {
        return res.status(400).json({ error: 'IMEI requerido' });
    }
    if (!business_name || !phone_key) {
        return res.status(400).json({ error: 'Nombre de negocio y llave celular requeridos' });
    }

    try {
        await pool.query(
            `INSERT INTO soundbox_terminals (imei, business_name, phone_key, configured, last_seen)
             VALUES (?, ?, ?, TRUE, NOW())
             ON DUPLICATE KEY UPDATE 
                business_name = VALUES(business_name),
                phone_key = VALUES(phone_key),
                configured = TRUE,
                last_seen = NOW()`,
            [imei, String(business_name).trim().toUpperCase(), String(phone_key).trim()]
        );

        return res.json({
            success: true,
            message: 'Soundbox activado exitosamente',
            imei,
            business_name: String(business_name).trim().toUpperCase(),
            phone_key: String(phone_key).trim()
        });
    } catch (err) {
        console.error('[Soundbox Activate Error]:', err);
        return res.status(500).json({ error: 'Error al activar terminal', details: err.message });
    }
});

// POST /api/soundbox/:imei/reset
router.post('/:imei/reset', async (req, res) => {
    const imei = String(req.params.imei || '').trim();
    try {
        await pool.query(
            'UPDATE soundbox_terminals SET business_name="SIN VINCULAR", phone_key="", configured=FALSE WHERE imei = ?',
            [imei]
        );
        return res.json({ success: true, message: 'Terminal reseteado a modo fabrica' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;

