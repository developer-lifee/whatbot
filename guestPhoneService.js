const { pool } = require('./database');

let tableReady = false;

function normalizePhoneKey(rawPhone) {
    const clean = String(rawPhone || '').replace(/\D/g, '');
    if (!clean) return '';
    return (clean.length === 10 && clean.startsWith('3')) ? `57${clean}` : clean;
}

async function ensureGuestPhonesTable() {
    if (tableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS account_guest_phones (
            id INT AUTO_INCREMENT PRIMARY KEY,
            owner_phone VARCHAR(30) NOT NULL,
            guest_phone VARCHAR(30) NOT NULL,
            account_row_id INT NULL,
            platform VARCHAR(100) NOT NULL,
            account_email VARCHAR(150) NOT NULL DEFAULT '',
            profile_name VARCHAR(150) NOT NULL DEFAULT '',
            added_by ENUM('client', 'admin') DEFAULT 'client',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_guest_phone (guest_phone),
            INDEX idx_owner_phone (owner_phone)
        )
    `);
    tableReady = true;
}

function getRowPhoneDigits(row) {
    const raw = row.numero || row.Numero || row.whatsapp || row.WhatsApp || row.celular || row.Celular || '';
    return String(raw).replace(/\D/g, '');
}

function getRowProfileName(row) {
    return String(row.Nombre || row.nombre || row.Perfil || row.perfil || '').trim();
}

function matchesAccountRow(row, link) {
    if (!row || !link) return false;
    const rowDigits = getRowPhoneDigits(row);
    const ownerLast10 = String(link.owner_phone || '').replace(/\D/g, '').slice(-10);
    if (!ownerLast10 || rowDigits.slice(-10) !== ownerLast10) return false;

    const rowPlatform = String(row.Streaming || row.platform || '').trim().toUpperCase();
    const linkPlatform = String(link.platform || '').trim().toUpperCase();
    if (linkPlatform && rowPlatform !== linkPlatform) return false;

    const rowEmail = String(row.correo || row.Correo || '').trim().toLowerCase();
    const linkEmail = String(link.account_email || '').trim().toLowerCase();
    if (linkEmail && rowEmail !== linkEmail) return false;

    const rowId = row._rowNumber || row.rowNumber || row.id;
    if (link.account_row_id && rowId && Number(link.account_row_id) === Number(rowId)) {
        return true;
    }

    const rowProfile = getRowProfileName(row).toLowerCase();
    const linkProfile = String(link.profile_name || '').trim().toLowerCase();
    if (linkProfile && rowProfile) {
        return rowProfile === linkProfile;
    }

    return true;
}

async function getGuestLinksByGuestPhone(guestPhone) {
    const norm = normalizePhoneKey(guestPhone);
    if (!norm || norm.length < 10) return [];
    await ensureGuestPhonesTable();
    const last10 = norm.slice(-10);
    const [rows] = await pool.query(
        'SELECT * FROM account_guest_phones WHERE guest_phone = ? OR guest_phone = ? OR RIGHT(guest_phone, 10) = ?',
        [norm, last10, last10]
    );
    return rows || [];
}

async function getGuestsForOwner(ownerPhone) {
    const norm = normalizePhoneKey(ownerPhone);
    if (!norm || norm.length < 10) return [];
    await ensureGuestPhonesTable();
    const last10 = norm.slice(-10);
    const [rows] = await pool.query(
        'SELECT * FROM account_guest_phones WHERE owner_phone = ? OR owner_phone = ? OR RIGHT(owner_phone, 10) = ?',
        [norm, last10, last10]
    );
    return rows || [];
}

async function findExistingGuestRecord({ ownerPhone, accountRowId, platform, accountEmail, profileName }) {
    const ownerGuests = await getGuestsForOwner(ownerPhone);
    const normPlatform = String(platform || '').trim().toUpperCase();
    const normEmail = String(accountEmail || '').trim().toLowerCase();
    const normProfile = String(profileName || '').trim().toLowerCase();

    return ownerGuests.find(g => {
        if (accountRowId && g.account_row_id && Number(g.account_row_id) === Number(accountRowId)) {
            return true;
        }
        const samePlat = String(g.platform || '').trim().toUpperCase() === normPlatform;
        const sameEmail = !normEmail || String(g.account_email || '').trim().toLowerCase() === normEmail;
        const sameProfile = !normProfile || !g.profile_name || String(g.profile_name || '').trim().toLowerCase() === normProfile;
        return samePlat && sameEmail && sameProfile;
    }) || null;
}

async function upsertGuestPhone({ ownerPhone, guestPhone, accountRowId = null, platform = '', accountEmail = '', profileName = '', addedBy = 'client' }) {
    const normOwner = normalizePhoneKey(ownerPhone);
    const normGuest = normalizePhoneKey(guestPhone);
    if (!normOwner || normOwner.length < 10) {
        throw new Error('Número del titular inválido.');
    }
    if (!normGuest || normGuest.length < 10 || normGuest.length > 15) {
        throw new Error('Ingresa un número invitado válido (mínimo 10 dígitos).');
    }
    if (normOwner.slice(-10) === normGuest.slice(-10)) {
        throw new Error('El número invitado no puede ser igual al número del titular.');
    }

    await ensureGuestPhonesTable();
    const existing = await findExistingGuestRecord({ ownerPhone: normOwner, accountRowId, platform, accountEmail, profileName });

    if (existing) {
        await pool.query(
            `UPDATE account_guest_phones 
             SET guest_phone = ?, account_row_id = COALESCE(?, account_row_id), account_email = ?, profile_name = ?, added_by = ?
             WHERE id = ?`,
            [normGuest, accountRowId || null, String(accountEmail || '').trim(), String(profileName || '').trim(), addedBy, existing.id]
        );
        return { id: existing.id, ownerPhone: normOwner, guestPhone: normGuest };
    }

    const [result] = await pool.query(
        `INSERT INTO account_guest_phones (owner_phone, guest_phone, account_row_id, platform, account_email, profile_name, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            normOwner,
            normGuest,
            accountRowId || null,
            String(platform || '').trim().toUpperCase(),
            String(accountEmail || '').trim(),
            String(profileName || '').trim(),
            addedBy
        ]
    );
    return { id: result.insertId, ownerPhone: normOwner, guestPhone: normGuest };
}

async function removeGuestPhone({ ownerPhone, accountRowId = null, platform = '', accountEmail = '', profileName = '' }) {
    const existing = await findExistingGuestRecord({ ownerPhone, accountRowId, platform, accountEmail, profileName });
    if (!existing) return false;
    await pool.query('DELETE FROM account_guest_phones WHERE id = ?', [existing.id]);
    return true;
}

module.exports = {
    normalizePhoneKey,
    ensureGuestPhonesTable,
    matchesAccountRow,
    getGuestLinksByGuestPhone,
    getGuestsForOwner,
    findExistingGuestRecord,
    upsertGuestPhone,
    removeGuestPhone
};
