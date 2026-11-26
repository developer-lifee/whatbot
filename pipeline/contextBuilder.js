const { getAccountsByPhone, fetchRawData } = require('../apiService');

/**
 * Construye un resumen seguro de los perfiles ocupados en las mismas cuentas matrices
 * del cliente (SOLO nombres de perfil y cupos libres; NUNCA teléfonos ni datos privados).
 */
function buildSiblingProfilesSummary(userAccounts = [], allRows = []) {
    if (!Array.isArray(userAccounts) || userAccounts.length === 0 || !Array.isArray(allRows) || allRows.length === 0) {
        return { siblingProfilesText: '', siblingAccountsCount: 0 };
    }

    const seenPairs = new Set();
    const sections = [];

    for (const acc of userAccounts) {
        const emailNorm = String(acc.correo || acc.Correo || acc.email || '').trim().toLowerCase();
        const platNorm = String(acc.Streaming || acc.streaming_platform || acc.platform || '').trim().toUpperCase();
        if (!emailNorm || !platNorm) continue;

        const pairKey = `${platNorm}:::${emailNorm}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const ownProfile = String(acc.Nombre || acc.nombre || acc.Perfil || acc.perfil || '').trim();
        const matchingRows = allRows.filter(r => {
            const rEmail = String(r.correo || r.Correo || '').trim().toLowerCase();
            const rPlat = String(r.Streaming || r.Plataforma || '').trim().toUpperCase();
            return rEmail === emailNorm && (rPlat === platNorm || rPlat.includes(platNorm) || platNorm.includes(rPlat));
        });

        const occupiedNames = [];
        let freeCount = 0;

        for (const r of matchingRows) {
            const nombre = String(r.Nombre || r.nombre || '').trim();
            const whatsapp = String(r.whatsapp || '').trim();
            const numero = String(r.numero || r.Numero || r.celular || '').replace(/\D/g, '');
            const isFree = !whatsapp && !numero && (!nombre || /^(libre|disponible)$/i.test(nombre));
            if (isFree) {
                freeCount++;
            } else if (nombre) {
                if (!ownProfile || nombre.toLowerCase() !== ownProfile.toLowerCase()) {
                    occupiedNames.push(nombre);
                }
            }
        }

        if (occupiedNames.length > 0 || freeCount > 0) {
            const uniqueOccupied = Array.from(new Set(occupiedNames));
            sections.push(
                `- ${platNorm} (${emailNorm}): Perfil del cliente="${ownProfile || 'N/A'}" | ` +
                `Perfiles ACTIVOS de otros usuarios: [${uniqueOccupied.join(', ') || 'Ninguno'}] | ` +
                `Cupos libres en Excel: ${freeCount} — PROHIBIDO recomendar entrar a perfiles de otros usuarios activos aunque no tengan candado.`
            );
        }
    }

    if (sections.length === 0) {
        return { siblingProfilesText: '', siblingAccountsCount: 0 };
    }

    return {
        siblingProfilesText: `🔒 MAPA DE PERFILES EN CUENTAS COMPARTIDAS (SOLO NOMBRES — USO INTERNO):\n${sections.join('\n')}`,
        siblingAccountsCount: sections.length
    };
}

/**
 * CAPA 1: Recolector Único de Contexto del turno.
 */
async function buildTurnContext({
    userId,
    realPhone,
    foundName = null,
    message,
    validMessages = null,
    isMedia = false,
    mediaData = null,
    userStates = null,
    getChatHistoryText = null,
    existingAccounts = null,
    existingHistory = null
}) {
    const startedAt = Date.now();
    const combinedBody = String(
        (message && message.combinedBody) ||
        (Array.isArray(validMessages) ? validMessages.map(m => m.body || '').filter(Boolean).join('\n') : '') ||
        (message && message.body) ||
        ''
    ).trim();

    const mediaList = Array.isArray(mediaData) ? mediaData.filter(Boolean) : (mediaData ? [mediaData] : []);
    const hasMedia = Boolean(isMedia || (message && message.hasMedia) || mediaList.length > 0);

    const cleanPhone = String(realPhone || userId || '').replace(/@.*/, '').replace(/\D/g, '');
    let accounts = Array.isArray(existingAccounts) ? existingAccounts : null;
    if (!accounts) {
        try {
            accounts = await getAccountsByPhone(cleanPhone, foundName);
        } catch (_) {
            accounts = [];
        }
    }

    let siblingProfilesText = '';
    let siblingAccountsCount = 0;
    if (accounts.length > 0) {
        try {
            const allRows = await fetchRawData(1, 500, false);
            const sib = buildSiblingProfilesSummary(accounts, allRows);
            siblingProfilesText = sib.siblingProfilesText;
            siblingAccountsCount = sib.siblingAccountsCount;
        } catch (_) {}
    }

    let chatHistory = existingHistory || '';
    if (!chatHistory && typeof getChatHistoryText === 'function' && message) {
        try {
            chatHistory = await getChatHistoryText(message, 20);
        } catch (_) {
            chatHistory = '';
        }
    }

    const stateObj = userStates ? userStates.get(userId) : null;
    const previousState = stateObj ? (stateObj.state || null) : null;

    return {
        startedAt,
        userId,
        realPhone: cleanPhone,
        foundName,
        combinedBody,
        hasMedia,
        mediaList,
        accounts,
        siblingProfilesText,
        siblingAccountsCount,
        chatHistory,
        previousState
    };
}

module.exports = {
    buildSiblingProfilesSummary,
    buildTurnContext
};
