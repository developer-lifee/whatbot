/**
 * sync_excel_to_db.js
 * Sincroniza las suscripciones del Excel (Azure) hacia la tabla `subscriptions` en MySQL.
 * Clasifica automáticamente is_provider según managed_emails.json y tokens/
 *
 * Uso standalone: node scripts/sync_excel_to_db.js
 * O desde API:    POST /api/admin/subscriptions/sync-excel
 */

const path = require('path');
const fs = require('fs');
const { pool } = require('../database');
const { fetchCustomersData, getJsDateFromExcel } = require('../apiService');

async function syncExcelToDb() {
    console.log('[Sync] Iniciando sincronización Excel → BD...');

    // 1. Cargar lista de correos propios (managed)
    const managedEmails = new Set();

    const managedPath = path.join(__dirname, '..', 'managed_emails.json');
    if (fs.existsSync(managedPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(managedPath, 'utf8'));
            if (Array.isArray(data)) data.forEach(e => managedEmails.add(e.toLowerCase().trim()));
        } catch (e) { console.warn('[Sync] No se pudo leer managed_emails.json:', e.message); }
    }

    const tokensDir = path.join(__dirname, '..', 'tokens');
    if (fs.existsSync(tokensDir)) {
        fs.readdirSync(tokensDir)
            .filter(f => f.startsWith('token_') && f.endsWith('.json'))
            .map(f => f.replace('token_', '').replace('.json', '').toLowerCase().trim())
            .filter(e => e.includes('@') && e !== 'contacts')
            .forEach(e => managedEmails.add(e));
    }
    console.log(`[Sync] Correos propios (managed): ${managedEmails.size}`);

    // 2. Cargar provider_emails.json para heredar rpaRecipeId existente
    const providerEmailsMap = new Map();
    const providerEmailsPath = path.join(__dirname, '..', 'provider_emails.json');
    if (fs.existsSync(providerEmailsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(providerEmailsPath, 'utf8'));
            if (Array.isArray(data)) {
                data.forEach(item => {
                    const e = (item.email || '').toLowerCase().trim();
                    if (e) providerEmailsMap.set(e, {
                        rpaRecipeId: item.rpaRecipeId || null,
                        providerName: item.notes || null
                    });
                });
            }
        } catch (e) { console.warn('[Sync] No se pudo leer provider_emails.json:', e.message); }
    }
    console.log(`[Sync] Proveedores en JSON legado: ${providerEmailsMap.size}`);

    // 3. Traer datos del Excel via Azure
    let customers;
    try {
        customers = await fetchCustomersData();
    } catch (e) {
        console.error('[Sync] Error al obtener datos del Excel:', e.message);
        throw e;
    }
    console.log(`[Sync] Filas del Excel obtenidas: ${customers.length}`);

    // 4. Insertar/actualizar en BD (modelo: stream_accounts + account_assignments)
    let insertedAccounts = 0, updatedAccounts = 0, insertedAssignments = 0, updatedAssignments = 0, skipped = 0;

    for (const c of customers) {
        const phone = (c.numero || c.Numero || '').toString().replace(/\D/g, '');
        const email = (c.correo || '').toString().toLowerCase().trim();
        const platform = (c.Streaming || c.streaming || '').toString().toLowerCase().trim();
        const firstName = (c.Nombre || c.nombre || '').toString().trim();
        const lastName = (c.Apellido || c.apellido || '').toString().trim();
        const name = [firstName, lastName].filter(Boolean).join(' ').trim();
        const expDate = getJsDateFromExcel(c.vencimiento || c.Vencimiento);
        const payMethod = (c['metodo pago'] || c['Metodo Pago'] || c['metodopago'] || c['Método Pago'] || '').toString().trim().slice(0, 255);
        const profilePin = (c['pin perfil'] || c['Pin Perfil'] || c.pin || '').toString().trim().slice(0, 500);
        const password = (c.contraseña || c.password || c.clave || c.Contraseña || '').toString().trim();

        if (!phone || !email || !platform) { skipped++; continue; }

        const isProvider = managedEmails.has(email) ? 0 : 1;
        const providerInfo = providerEmailsMap.get(email);
        const rpaRecipeId = isProvider ? (providerInfo?.rpaRecipeId || null) : null;
        const providerName = isProvider ? (providerInfo?.providerName || null) : null;
        const expirationStr = expDate ? expDate.toISOString().slice(0, 10) : null;
        const statusVal = (expirationStr && new Date(expirationStr) < new Date()) ? 'expired' : 'active';

        // A. Upsert customer
        await pool.query(
            `INSERT INTO customers (phone, fullname, email) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE fullname = VALUES(fullname), email = VALUES(email)`,
            [phone, name || 'Sin nombre', email]
        );

        // B. Upsert stream_account (único por email+platform)
        const [existingAccount] = await pool.query(
            'SELECT id FROM stream_accounts WHERE account_email = ? AND streaming_platform = ?',
            [email, platform]
        );

        let accountId;
        if (existingAccount.length > 0) {
            accountId = existingAccount[0].id;
            // Solo actualizar password y clasificación; NO tocar rpa_recipe_id si ya fue asignado manualmente
            await pool.query(
                `UPDATE stream_accounts SET
                    account_password = ?,
                    is_provider = ?,
                    provider_name = COALESCE(provider_name, ?),
                    rpa_recipe_id = COALESCE(rpa_recipe_id, ?)
                 WHERE id = ?`,
                [password || null, isProvider, providerName, rpaRecipeId, accountId]
            );
            updatedAccounts++;
        } else {
            const [res] = await pool.query(
                `INSERT INTO stream_accounts
                    (account_email, streaming_platform, account_password, is_provider, provider_name, rpa_recipe_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`,
                [email, platform, password || null, isProvider, providerName, rpaRecipeId]
            );
            accountId = res.insertId;
            insertedAccounts++;
        }

        // C. Upsert account_assignment (cliente → cuenta)
        const [existingAssign] = await pool.query(
            'SELECT id FROM account_assignments WHERE account_id = ? AND customer_phone = ?',
            [accountId, phone]
        );

        if (existingAssign.length > 0) {
            await pool.query(
                `UPDATE account_assignments SET
                    profile_pin = ?, expiration_date = ?, status = ?, payment_method = ?
                 WHERE id = ?`,
                [profilePin || null, expirationStr, statusVal, payMethod || null, existingAssign[0].id]
            );
            updatedAssignments++;
        } else {
            await pool.query(
                `INSERT INTO account_assignments
                    (account_id, customer_phone, profile_pin, expiration_date, status, payment_method)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [accountId, phone, profilePin || null, expirationStr, statusVal, payMethod || null]
            );
            insertedAssignments++;
        }
    }

    const summary = {
        accounts: { inserted: insertedAccounts, updated: updatedAccounts },
        assignments: { inserted: insertedAssignments, updated: updatedAssignments },
        skipped,
        total: customers.length,
        managed: managedEmails.size
    };
    console.log(`[Sync] ✅ Cuentas: ${insertedAccounts} nuevas / ${updatedAccounts} actualizadas | Asignaciones: ${insertedAssignments} nuevas / ${updatedAssignments} actualizadas | ${skipped} omitidas de ${customers.length} filas`);
    return summary;
}

// Ejecutar directamente si se llama como script
if (require.main === module) {
    syncExcelToDb()
        .then(r => { console.log('[Sync] Resultado:', r); process.exit(0); })
        .catch(e => { console.error('[Sync] Error fatal:', e); process.exit(1); });
}

module.exports = { syncExcelToDb };
