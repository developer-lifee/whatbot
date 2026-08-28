const { getAccountsByPhone, fetchCustomersData, getJsDateFromExcel, getTodayInBogota } = require('./apiService');
const { normalizeStreamingName } = require('./availabilityService');
const { generateCredentialsResponse } = require('./aiService');
const { getPlatformKnowledge } = require('./apiService');
const path = require('path');
const fs = require('fs');

async function safeSend(message, text, userId = null, clientInstance = null) {
    const activeClient = clientInstance || (message && message._client) || (typeof global !== 'undefined' ? global.client : null);
    
    // Si el mensaje es en un grupo, responder DIRECTAMENTE al grupo
    if (message && message.from && message.from.includes('@g.us')) {
        if (activeClient) {
            const res = await activeClient.sendMessage(message.from, text).catch(() => null);
            if (res) return res;
        }
        if (typeof message.reply === 'function') {
            return await message.reply(text).catch(() => null);
        }
    }

    let realPhoneJid = null;
    let lidJid = null;

    if (userId && typeof userId === 'string' && userId.includes('@c.us')) {
        realPhoneJid = userId;
    } else if (userId && typeof userId === 'string' && userId.includes('@lid')) {
        lidJid = userId;
    }

    if (message && message.from && message.from !== 'status@broadcast') {
        if (message.from.includes('@c.us') && !realPhoneJid) {
            realPhoneJid = message.from;
        } else if (message.from.includes('@lid') && !lidJid) {
            lidJid = message.from;
        }
    }

    if (message && message.author && message.author !== 'status@broadcast') {
        if (message.author.includes('@c.us') && !realPhoneJid) {
            realPhoneJid = message.author;
        } else if (message.author.includes('@lid') && !lidJid) {
            lidJid = message.author;
        }
    }

    // Buscar en userStates si solo tenemos lidJid
    if (!realPhoneJid && lidJid && typeof userStates !== 'undefined' && userStates) {
        const st = userStates.get(lidJid);
        if (st && st.realPhone) {
            realPhoneJid = st.realPhone.replace(/\D/g, '') + '@c.us';
        }
    }

    // Buscar en Puppeteer window.Store si aún no tenemos realPhoneJid
    if (!realPhoneJid && lidJid && activeClient && activeClient.pupPage) {
        try {
            const phone = await activeClient.pupPage.evaluate((lid) => {
                try {
                    const c = window.Store.Contact.get(lid);
                    if (c && c.phoneNumber) return c.phoneNumber;
                    if (c && c.id && c.id.user && !c.id.user.includes('lid')) return c.id.user;
                    const chat = window.Store.Chat.get(lid);
                    if (chat && chat.phoneNumber) return chat.phoneNumber;
                } catch(e) {}
                return null;
            }, lidJid).catch(() => null);
            if (phone) realPhoneJid = phone.replace(/\D/g, '') + '@c.us';
        } catch(e) {}
    }

    // SIEMPRE colocar realPhoneJid (@c.us) PRIMERO para garantizar la entrega a la App del cliente
    const botNum = (activeClient && activeClient.info && activeClient.info.wid) ? activeClient.info.wid.user : '3118587974';
    const jidsToTry = [realPhoneJid, lidJid, (userId && userId.includes('@c.us')) ? userId : null]
        .filter((j, idx, self) => Boolean(j) && self.indexOf(j) === idx)
        .filter(j => !j.includes(botNum) && !j.includes('573118587974'));

    if (activeClient) {
        for (const jid of jidsToTry) {
            try {
                const res = await activeClient.sendMessage(jid, text).catch((err) => {
                    console.error(`[safeSend activeClient error] for ${jid}:`, err ? err.message : 'null');
                    return null;
                });
                if (res) return res;

                const chat = await activeClient.getChatById(jid).catch((err) => {
                    console.error(`[safeSend getChatById error] for ${jid}:`, err ? err.message : 'null');
                    return null;
                });
                if (chat && typeof chat.sendMessage === 'function') {
                    const resChat = await chat.sendMessage(text).catch((err) => {
                        console.error(`[safeSend chat.sendMessage error] for ${jid}:`, err ? err.message : 'null');
                        return null;
                    });
                    if (resChat) return resChat;
                }
            } catch (e) {
                console.warn(`[safeSend] activeClient attempt failed for ${jid}:`, e.message);
            }
        }
    }

    if (message && typeof message.reply === 'function') {
        try {
            return await message.reply(text);
        } catch (e) {
            console.error(`[safeSend] message.reply error:`, e.message);
        }
    }
}

function isNameMatch(strA, strB) {
    if (!strA || !strB) return false;
    const normalize = (s) => (typeof s === 'string' ? s : String(s || '')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ' ').trim();
    const cleanA = normalize(strA);
    const cleanB = normalize(strB);
    if (!cleanA || !cleanB || cleanA.length < 3 || cleanB.length < 3) return false;
    if (cleanA === cleanB) return true;

    const tokensA = cleanA.split(/\s+/).filter(w => w.length >= 3);
    const tokensB = cleanB.split(/\s+/).filter(w => w.length >= 3);
    if (tokensA.length === 0 || tokensB.length === 0) return false;

    // Si alguno solo tiene 1 token (ej: "Diego", "Carlos"), NO hacer match con nombres compuestos ("Diego Abril", "Diego Tn")
    if (tokensA.length === 1 || tokensB.length === 1) {
        return cleanA === cleanB;
    }

    const tokenMatch = (tA, tB) => {
        if (tA === tB) return true;
        if (tA.length >= 4 && tB.length >= 4 && (tA.startsWith(tB) || tB.startsWith(tA))) return true;
        if (Math.abs(tA.length - tB.length) <= 1 && tA.slice(0, 3) === tB.slice(0, 3) && tA.length >= 4) {
            let diff = 0;
            for (let i = 0; i < Math.min(tA.length, tB.length); i++) {
                if (tA[i] !== tB[i]) diff++;
            }
            if (diff <= 1) return true;
        }
        return false;
    };

    // Coincidencia de al menos 2 tokens correspondientes (ej: Nombre + Apellido)
    let matchingTokens = 0;
    for (const tA of tokensA) {
        if (tokensB.some(tB => tokenMatch(tA, tB))) {
            matchingTokens++;
        }
    }

    return matchingTokens >= 2;
}

async function resolveRealPhoneFromJid(jid, client = null, knownName = null) {
    if (!jid) return null;
    const clean = jid.replace(/\D/g, '');
    const isLid = jid.includes('@lid') || (jid.includes('@c.us') && !clean.startsWith('57') && clean.length > 10) || clean.length > 12;
    if (!isLid && jid.includes('@c.us') && clean.length <= 13) return clean;

    const activeClient = client || (typeof global !== 'undefined' ? global.client : null);
    if (activeClient && activeClient.pupPage) {
        try {
            const result = await activeClient.pupPage.evaluate((targetJid) => {
                try {
                    const cleanJid = targetJid.split('@')[0];
                    let wid = null;
                    if (window.Store && window.Store.WidFactory && typeof window.Store.WidFactory.createWid === 'function') {
                        try { wid = window.Store.WidFactory.createWid(targetJid); } catch(e) {}
                    }
                    
                    // 1. API nativa window.Store.Lid de WhatsApp Web
                    if (window.Store && window.Store.Lid) {
                        if (typeof window.Store.Lid.getPnForLid === 'function') {
                            const res = (wid && window.Store.Lid.getPnForLid(wid)) || window.Store.Lid.getPnForLid(targetJid) || window.Store.Lid.getPnForLid(cleanJid + '@lid');
                            if (res) {
                                const pStr = typeof res === 'string' ? res : (res.user || res._serialized || '');
                                if (pStr && pStr.replace(/\D/g, '').length <= 13 && pStr.replace(/\D/g, '').length >= 7) return { phone: pStr };
                            }
                        }
                        if (typeof window.Store.Lid.getLidForPn === 'function' && typeof window.Store.Lid.getPhoneNumber === 'function') {
                            const res = window.Store.Lid.getPhoneNumber(wid || targetJid);
                            if (res) {
                                const pStr = typeof res === 'string' ? res : (res.user || res._serialized || '');
                                if (pStr && pStr.replace(/\D/g, '').length <= 13 && pStr.replace(/\D/g, '').length >= 7) return { phone: pStr };
                            }
                        }
                    }

                    // 2. window.Store.Contact
                    let contactName = null;
                    if (window.Store && window.Store.Contact) {
                        const jidsToTry = [wid, targetJid, cleanJid + '@lid', cleanJid + '@c.us', cleanJid + '@s.whatsapp.net'].filter(Boolean);
                        for (const tryJid of jidsToTry) {
                            const c = window.Store.Contact.get(tryJid);
                            if (c) {
                                if (!contactName) contactName = c.name || c.pushname || c.shortName || c.formattedTitle;
                                if (c.phoneNumber) {
                                    const pNum = typeof c.phoneNumber === 'string' ? c.phoneNumber : (c.phoneNumber.user || c.phoneNumber._serialized);
                                    if (pNum && pNum.replace(/\D/g, '').length <= 13 && pNum.replace(/\D/g, '').length >= 7 && !pNum.includes('lid')) return { phone: pNum };
                                }
                                if (c.pn) {
                                    const pNum = typeof c.pn === 'string' ? c.pn : (c.pn.user || c.pn._serialized);
                                    if (pNum && pNum.replace(/\D/g, '').length <= 13 && pNum.replace(/\D/g, '').length >= 7 && !pNum.includes('lid')) return { phone: pNum };
                                }
                                if (c.number && !String(c.number).includes('lid') && String(c.number).replace(/\D/g, '').length <= 13 && String(c.number).replace(/\D/g, '').length >= 7) return { phone: c.number };
                                if (c.id && c.id.user && !c.id._serialized.includes('@lid') && c.id.user.replace(/\D/g, '').length <= 13 && c.id.user.replace(/\D/g, '').length >= 7) return { phone: c.id.user };
                            }
                        }

                        // 3. Recorrer array de contactos en memoria
                        const allContacts = window.Store.Contact._models || (window.Store.Contact.getModelsArray ? window.Store.Contact.getModelsArray() : (window.Store.Contact.models || []));
                        const match = allContacts.find(c => {
                            if (!c) return false;
                            const cLid = (c.lid && c.lid._serialized) || c.lid || (c.id && c.id._serialized) || '';
                            return String(cLid).includes(cleanJid) || (c.id && c.id.user === cleanJid);
                        });
                        if (match) {
                            if (!contactName) contactName = match.name || match.pushname || match.shortName || match.formattedTitle;
                            if (match.phoneNumber) {
                                const pNum = typeof match.phoneNumber === 'string' ? match.phoneNumber : (match.phoneNumber.user || match.phoneNumber._serialized);
                                if (pNum && pNum.replace(/\D/g, '').length <= 13 && pNum.replace(/\D/g, '').length >= 7 && !pNum.includes('lid')) return { phone: pNum };
                            }
                            if (match.pn) {
                                const pNum = typeof match.pn === 'string' ? match.pn : (match.pn.user || match.pn._serialized);
                                if (pNum && pNum.replace(/\D/g, '').length <= 13 && pNum.replace(/\D/g, '').length >= 7 && !pNum.includes('lid')) return { phone: pNum };
                            }
                            if (match.id && match.id.user && !match.id._serialized.includes('@lid') && match.id.user.replace(/\D/g, '').length <= 13 && match.id.user.replace(/\D/g, '').length >= 7) return { phone: match.id.user };
                        }
                    }

                    // 4. window.Store.Chat
                    if (window.Store && window.Store.Chat) {
                        const chat = (wid && window.Store.Chat.get(wid)) || window.Store.Chat.get(targetJid) || window.Store.Chat.get(cleanJid + '@c.us');
                        if (chat) {
                            if (chat.phoneNumber && chat.phoneNumber.replace(/\D/g, '').length <= 13 && chat.phoneNumber.replace(/\D/g, '').length >= 7) return { phone: chat.phoneNumber };
                            if (chat.contact && chat.contact.phoneNumber) {
                                const pNum = typeof chat.contact.phoneNumber === 'string' ? chat.contact.phoneNumber : (chat.contact.phoneNumber.user || chat.contact.phoneNumber._serialized);
                                if (pNum && pNum.replace(/\D/g, '').length <= 13 && pNum.replace(/\D/g, '').length >= 7 && !pNum.includes('lid')) return { phone: pNum };
                            }
                            if (chat.id && chat.id.user && !chat.id._serialized.includes('@lid') && chat.id.user.replace(/\D/g, '').length <= 13 && chat.id.user.replace(/\D/g, '').length >= 7) return { phone: chat.id.user };
                        }
                    }

                    return { name: contactName };
                } catch(e) {}
                return null;
            }, jid).catch(() => null);

            if (result && result.phone) {
                const cleanPhone = result.phone.replace(/\D/g, '');
                if (cleanPhone.length >= 7 && cleanPhone.length <= 13) {
                    return cleanPhone;
                }
            }
            if (result && result.name && !knownName) {
                knownName = result.name;
            }
        } catch(e) {}
    }

    // 5. Fallback por nombre conocido en Excel y Base de Datos (con coincidencia flexible de nombres y apellidos)
    if (knownName && typeof knownName === 'string' && knownName.trim().length >= 3 && knownName !== 'Cliente WhatsApp' && knownName !== 'Cliente') {
        try {
            const { fetchRawData } = require('./apiService');
            const allRows = await fetchRawData().catch(() => []);
            const matchRow = allRows.find(r => {
                const rowName = `${r.Nombre || r.nombre || ''} ${r.apellido || r.Apellido || ''}`.trim();
                const rowWhatsapp = (r.whatsapp || r.WhatsApp || '').toString().trim();
                const rowEmail = (r['customer mail'] || r.correo || '').toString().trim();
                return isNameMatch(knownName, rowName) || isNameMatch(knownName, rowWhatsapp) || (knownName.startsWith('@') && rowEmail.toLowerCase().includes(knownName.replace('@', '').toLowerCase()));
            });
            if (matchRow) {
                const rawNum = (matchRow.numero || matchRow.Numero || matchRow.whatsapp || '').toString().replace(/\D/g, '');
                if (rawNum && rawNum.length >= 7 && rawNum.length <= 13) {
                    return rawNum;
                }
            }
        } catch (e) {}
    }

    // 6. Extraer número de teléfono de 10 dígitos (ej: 3227922392) directamente del texto de mensajes en MariaDB
    try {
        const { pool } = require('./database');
        const [msgs] = await pool.query(
            "SELECT body FROM messages WHERE (chat_id = ? OR sender_id = ?) AND body REGEXP '3[0-9]{9}' ORDER BY created_at DESC LIMIT 10",
            [jid, jid]
        );
        if (msgs && msgs.length > 0) {
            for (const m of msgs) {
                const phoneMatch = (m.body || '').match(/3\d{9}/);
                if (phoneMatch) {
                    const extracted = '57' + phoneMatch[0];
                    console.log(`[LID Resolver] 📱 Número +${extracted} extraído del texto de los mensajes en BD para LID ${jid}`);
                    return extracted;
                }
            }
        }
    } catch (dbErr) {}

    if (clean.length >= 7 && clean.length <= 13 && !isLid) return clean;

    return null;
}

function calculateInternationalPrice(basePriceCOP, trm = 4000) {
    if (!basePriceCOP || isNaN(basePriceCOP)) return { grossCOP: 0, priceUSD: 0 };
    // Gross COP to guarantee merchant receives 100% net basePriceCOP after Bold fees (3.49% + $900 + 19% IVA)
    const grossCOP = Math.ceil(((Number(basePriceCOP) + 1100) / 0.945) / 100) * 100;
    const priceUSD = Number((grossCOP / trm).toFixed(2));
    return { grossCOP, priceUSD };
}

function getPlatformPriceFromExcel(accountOrStreaming, platforms = []) {
    if (!accountOrStreaming) return 0;
    let streamingName = "";
    let isPersonal = false;
    let fallbackExcelPrice = 0;

    if (typeof accountOrStreaming === 'object' && accountOrStreaming !== null) {
        const rawP = accountOrStreaming['Ingreso Mensual2'] || accountOrStreaming['ingreso mensual'] || accountOrStreaming.precio || accountOrStreaming.Precio || accountOrStreaming['precio cobrado'];
        if (rawP && !isNaN(Number(rawP)) && Number(rawP) >= 4000) {
            fallbackExcelPrice = Number(rawP);
        }
        const cMail = (accountOrStreaming['customer mail'] || accountOrStreaming['Customer Mail'] || '').toString().trim();
        const pinText = (accountOrStreaming['pin perfil'] || accountOrStreaming.pin || '').toString().toLowerCase();
        if (cMail || pinText.includes('invite') || pinText.includes('spotify.com') || pinText.includes('join')) {
            isPersonal = true;
        }
        streamingName = accountOrStreaming.Streaming || accountOrStreaming.Plataforma || accountOrStreaming.name || "";
    } else {
        streamingName = String(accountOrStreaming || "");
    }

    if (!streamingName) return fallbackExcelPrice;
    const cleanName = streamingName.toString().trim().toUpperCase();
    if (cleanName.includes('PERSONAL') || cleanName.includes('TU CORREO')) {
        isPersonal = true;
    }
    
    // High-priority alias detection (Specific names before generic)
    let targetName = cleanName;
    if (cleanName.includes('APPLE ONE') || cleanName.includes('APPLE_ONE') || (cleanName.includes('APPLE') && cleanName.includes('ONE'))) {
        targetName = 'APPLE ONE';
    } else if (cleanName.includes('APPLE TV') || cleanName === 'APPLE') {
        targetName = 'APPLE TV+';
    } else if (cleanName.includes('NETFLIX EXTRA') || cleanName.includes('EXTRA')) {
        targetName = 'NETFLIX EXTRA';
    } else if (cleanName.includes('AMAZON') || cleanName.includes('PRIME')) {
        targetName = 'PRIME VIDEO';
    } else if (cleanName.includes('HBO PLATINO') || cleanName.includes('MAX PLATINO')) {
        targetName = 'MAX PLATINO';
    } else if (cleanName.includes('HBO') || cleanName.includes('MAX')) {
        targetName = 'HBOMAX';
    } else if (cleanName.includes('DISNEY') || cleanName.includes('STAR')) {
        targetName = 'DISNEY+ PREMIUM';
    } else if (cleanName.includes('YOUTUBE')) {
        targetName = 'YOUTUBE PREMIUM';
    } else if (cleanName.includes('MICROSOFT')) {
        targetName = 'MICROSOFT 365';
    }

    if (Array.isArray(platforms) && platforms.length > 0) {
        // 1. Buscar coincidencia exacta en el nombre de la plataforma y seleccionar plan según tipo (Personal vs Compartida)
        for (const p of platforms) {
            const pName = (p.name || '').toUpperCase();
            if (pName === targetName || pName.includes(targetName) || targetName.includes(pName)) {
                if (Array.isArray(p.plans) && p.plans.length > 0) {
                    if (targetName === 'APPLE ONE') {
                        const appleOnePlan = p.plans.find(pl => (pl.name || '').toUpperCase().includes('ONE'));
                        if (appleOnePlan && appleOnePlan.price) return appleOnePlan.price;
                    }
                    if (isPersonal) {
                        const persPlan = p.plans.find(pl => pl.isPersonalEmail || (pl.name && (pl.name.toLowerCase().includes('personal') || pl.name.toLowerCase().includes('tu correo'))));
                        if (persPlan && persPlan.price) return persPlan.price;
                    } else {
                        const sharedPlan = p.plans.find(pl => !pl.isPersonalEmail && (pl.name && (pl.name.toLowerCase().includes('compartida') || pl.name.toLowerCase().includes('cuenta nueva') || pl.name.toLowerCase().includes('apple one'))));
                        if (sharedPlan && sharedPlan.price) return sharedPlan.price;
                    }
                }
                if (p.price) return p.price;
            }
        }

        // 2. Buscar coincidencia en planes de todas las plataformas
        for (const p of platforms) {
            if (Array.isArray(p.plans)) {
                for (const pl of p.plans) {
                    const plName = (pl.name || '').toUpperCase();
                    if (plName === targetName || plName.includes(targetName) || targetName.includes(plName)) {
                        if (pl.price) return pl.price;
                    }
                }
            }
        }
    }

    if (fallbackExcelPrice > 0) {
        return fallbackExcelPrice;
    }

    // 3. Diccionario de respaldo por si platforms no cargó o hay variantes
    const fallbackPrices = {
        'crunchyroll': 7000,
        'spotify': 8000,
        'amazon': 10000,
        'netflix': 13000,
        'netflix_extra': 17000,
        'disney': 14000,
        'hbo': 8000,
        'hbo_platino': 11000,
        'youtube': 12000,
        'gpt': 20000,
        'canva': 7000,
        'vix': 7000,
        'appletv': 8000,
        'appleone': 22000,
        'apple_one': 22000,
        'apple': 8000,
        'apple tv': 8000,
        'apple one': 22000,
        'microsoft': 13000,
        'microsoft_compartida': 5000,
        'claude_pro': 20000,
        'claude': 20000,
        'gemini': 22000,
        'gemini_compartida': 10000,
        'platzi': 150000,
        'platzi_compartida': 20000,
        'iptv': 10000,
        'paramount': 8000
    };

    const targetNorm = normalizeStreamingName(streamingName);
    if (targetNorm && fallbackPrices[targetNorm]) {
        return fallbackPrices[targetNorm];
    }

    return 0;
}

function extractPlatformFromText(text) {
    if (!text) return null;
    const txt = text.toLowerCase().trim();
    if (txt === "2") return null; // Ignorar si es solo la opción del menú
    if (txt.includes('netflix')) return 'NETFLIX';
    if (txt.includes('spotify')) return 'SPOTIFY';
    if (txt.includes('disney')) return 'DISNEY';
    if (txt.includes('prime') || txt.includes('amazon')) return 'AMAZON PRIME';
    if (txt.includes('hbo') || txt.includes('max')) return 'MAX';
    if (txt.includes('paramount')) return 'PARAMOUNT';
    if (txt.includes('youtube')) return 'YOUTUBE';
    if (txt.includes('plex')) return 'PLEX';
    if (txt.includes('crunchyroll') || txt.includes('crunchy')) return 'CRUNCHYROLL';
    if (txt.includes('apple') || txt.includes('one')) return 'APPLE ONE';
    return null;
}

async function checkPendingWebSaleForPhone(phone, name = '') {
    if (!phone && !name) return null;
    const clean = (phone || '').replace(/\D/g, '');
    const last10 = clean.length >= 10 ? clean.slice(-10) : clean;
    const { pool } = require('./database');
    try {
        if (last10 && last10.length === 10) {
            const [rows] = await pool.query(
                "SELECT * FROM web_sales_pending WHERE whatsapp LIKE ? OR whatsapp = ?",
                [`%${last10}`, clean]
            );
            if (rows.length > 0) return rows[0];
        }
        if (name && name.trim().length > 2) {
            const cleanName = name.trim().toLowerCase().split(' ')[0];
            if (cleanName.length > 2 && !['hola', 'buenas', 'user', 'cliente', 'nuevo'].includes(cleanName)) {
                const [rowsByName] = await pool.query(
                    "SELECT * FROM web_sales_pending WHERE LOWER(firstName) LIKE ? OR LOWER(lastName) LIKE ?",
                    [`%${cleanName}%`, `%${cleanName}%`]
                );
                if (rowsByName.length > 0) return rowsByName[0];
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * Procesa la solicitud de credenciales de un usuario.
 */
async function processCheckCredentials(userId, client, triggerMessage = "", history = "", userStates = null) {
    try {
        if (!userId || userId.endsWith('@newsletter')) return;
        let phoneNumber = await resolveRealPhoneFromJid(userId, client);
        let contactName = null;
        if (userId.includes('@lid')) {
            try {
                const { pool } = require('./database');
                const [chatRows] = await pool.query('SELECT customer_phone FROM chats WHERE chat_id = ? AND customer_phone IS NOT NULL LIMIT 1', [userId]);
                if (chatRows.length > 0 && chatRows[0].customer_phone) {
                    phoneNumber = chatRows[0].customer_phone.replace(/\D/g, '');
                }
            } catch (e) { }

            try {
                const contact = await Promise.race([
                    client.getContactById(userId),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout getContactById")), 1500))
                ]).catch(() => null);

                if (contact) {
                    contactName = contact.name || contact.pushname;
                }
            } catch (e) { }
        }

        // Validar si tiene un pago en proceso de validación humana
        let isPendingValidation = false;
        if (userStates) {
            const stateData = userStates.get(userId);
            if (stateData && (stateData.state === 'waiting_admin_confirmation' || stateData.state === 'awaiting_payment_confirmation')) {
                isPendingValidation = true;
            }
        }

        if (!isPendingValidation) {
            try {
                const { pool } = require('./database');
                const [pendingSales] = await pool.query(
                    "SELECT * FROM web_sales_pending WHERE whatsapp LIKE ? OR whatsapp = ?",
                    [`%${phoneNumber}%`, phoneNumber]
                );
                if (pendingSales && pendingSales.length > 0) {
                    isPendingValidation = true;
                }
            } catch (dbErr) {
                console.error('[Billing Service] Error buscando ventas pendientes:', dbErr.message);
            }
        }

        if (isPendingValidation) {
            const pendingSale = await checkPendingWebSaleForPhone(phoneNumber);
            if (pendingSale) {
                const amountFmt = pendingSale.amount ? `$${Number(pendingSale.amount).toLocaleString('es-CO')} COP` : '';
                await safeSend(null, `🤖 ¡Hola ${pendingSale.firstName || ''}! 👋 Veo que tu pedido de *${pendingSale.platformName}* (${amountFmt}) está registrado en nuestro sistema (Orden \`${pendingSale.order_id}\`). 🎉\n\nEstamos monitoreando la confirmación de tu banco (Nequi/PSE) en tiempo real. Tan pronto como el banco confirme la transacción, te entregaremos tus claves automáticamente por aquí. 😊`, userId, client);
            } else {
                await safeSend(null, "🤖 Tu pago está registrado en nuestro sistema y está en proceso de validación. En breve te entregaremos tus accesos automáticamente. ¡Gracias por tu paciencia! 😊", userId, client);
            }
            return;
        }

        const existingState = userStates ? userStates.get(userId) : null;
        const hasRecentPayment = existingState && (
            (existingState.lastPaymentValidated && Date.now() - existingState.lastPaymentValidated < 1000 * 60 * 30) ||
            existingState.state === 'awaiting_payment_confirmation' ||
            existingState.state === 'waiting_admin_confirmation'
        );

        if (hasRecentPayment) {
            await safeSend(null, "🤖 ¡Hola! Tu pago ha sido recibido y registrado con éxito. 🎉 En este momento nuestro equipo está procesando la asignación de tu servicio. Te enviaremos tus credenciales de acceso directamente por aquí a la mayor brevedad. ¡Muchas gracias por tu compra! 😊", userId, client);
            return;
        }

        let userAccounts = await getAccountsByPhone(phoneNumber, contactName);

        if (userAccounts.length === 0) {
            await safeSend(null, "🤖 No encontré servicios activos vinculados a este número. Si compraste desde otro número, por favor dímelo para ayudarte a buscar o contacta a un asesor.", userId, client);
            return;
        }

        // --- VALIDACIÓN DE PLATAFORMA ESPECÍFICA ---
        const requestedPlatform = extractPlatformFromText(triggerMessage);
        if (requestedPlatform) {
            const hasPlatform = userAccounts.some(acc => {
                const streaming = (acc.Streaming || acc.streaming || "").toUpperCase();
                return streaming.includes(requestedPlatform) || requestedPlatform.includes(streaming);
            });

            if (!hasPlatform) {
                await safeSend(null, `🤖 Veo que actualmente no tienes una suscripción activa de *${requestedPlatform}* con nosotros.\n\n¿Te gustaría adquirir un plan? Escribe *1* para ver nuestro catálogo y comprar. 🛒\n\nSi crees que esto es un error, no te preocupes, en un momento un asesor humano revisará este chat para ayudarte. 🧑‍💻`, userId, client);
                // Activar modo humano para que el asesor pueda revisar el error si el cliente responde
                if (userStates) {
                    const existing = userStates.get(userId);
                    userStates.set(userId, {
                        ...(existing || {}),
                        state: 'waiting_human',
                        waiting_human_mode: 'advisor',
                        advisorReason: `Solicitó credenciales de ${requestedPlatform} pero no la tiene adquirida`,
                        waitingTimestamp: Date.now()
                    });
                }
                const { applyLabelToChat } = require('./adminService');
                try {
                    await applyLabelToChat(userId, client, ['revisión', 'manual']);
                } catch (e) {}
                return;
            } else {
                // Filtrar las cuentas de usuario para enviar únicamente las de la plataforma solicitada
                userAccounts = userAccounts.filter(acc => {
                    const streaming = (acc.Streaming || acc.streaming || "").toUpperCase();
                    return streaming.includes(requestedPlatform) || requestedPlatform.includes(streaming);
                });
            }
        }

        // Detectar si alguna de las cuentas no tiene credenciales asignadas aún
        const pendingAccounts = userAccounts.filter(acc => {
            const correoOriginal = (acc.correo || acc.Correo || acc["E-mail"] || "").toString().trim().toLowerCase();
            const claveOriginal = (acc["contraseña"] || acc["Clave"] || acc["clave"] || acc["password"] || acc["Password"] || "").toString().trim().toLowerCase();
            
            return !correoOriginal || !claveOriginal || 
                   correoOriginal === "n/a" || claveOriginal === "n/a" ||
                   correoOriginal.includes("pendiente") || claveOriginal.includes("pendiente") ||
                   correoOriginal.includes("por asignar") || claveOriginal.includes("por asignar") ||
                   correoOriginal.includes("por_asignar") || claveOriginal.includes("por_asignar");
        });

        const assignedAccounts = userAccounts.filter(acc => !pendingAccounts.includes(acc));

        let waitingTimeText = "";
        if (existingState && existingState.waitingTimestamp) {
            const diffMs = Date.now() - existingState.waitingTimestamp;
            const diffMins = Math.floor(diffMs / (1000 * 60));
            if (diffMins < 60) {
                waitingTimeText = ` por más de ${diffMins} minutos`;
            } else {
                const diffHours = Math.floor(diffMins / 60);
                const remainingMins = diffMins % 60;
                waitingTimeText = ` por más de ${diffHours} horas y ${remainingMins} minutos`;
            }
        }

        if (assignedAccounts.length === 0) {
            // Todas las cuentas están pendientes de asignar
            const platformsStr = userAccounts.map(a => (a.Streaming || "Servicio").toUpperCase()).join(", ");
            await safeSend(null, `🤖 Veo que tus credenciales de *${platformsStr}* aún no se han asignado. Ya le recordé a un asesor humano que has estado esperando${waitingTimeText} para que te las entregue lo antes posible. ¡Gracias por tu paciencia! 😊`, userId, client);
            return;
        }

        let aiResponse = await generateCredentialsResponse(assignedAccounts, triggerMessage, history);
        if (aiResponse && !aiResponse.includes('🤖')) {
            aiResponse += '\n\n🤖';
        }

        // Si además tiene cuentas pendientes, le agregamos una aclaración al final de la respuesta
        if (pendingAccounts.length > 0) {
            const pendingPlatformsStr = pendingAccounts.map(a => (a.Streaming || "Servicio").toUpperCase()).join(", ");
            aiResponse += `\n\n⚠️ *Nota:* Tus credenciales de *${pendingPlatformsStr}* aún no se han asignado. Ya le recordé a un asesor que has estado esperando${waitingTimeText} para que te las entregue.`;
        }

        await safeSend(null, aiResponse, userId, client);

    } catch (error) {
        console.error('[Billing Service] Error al procesar credenciales:', error);
        await safeSend(null, "🤖 Hubo un error al recuperar tus credenciales. Por favor, inténtalo de nuevo en un momento o contacta a un asesor.", userId, client);
    }
}

/**
 * Intenta ajustar la duración y el total de la renovación en stateData si el monto pagado coincide con múltiples meses o cuentas.
 */
async function adjustDurationToMatchAmount(stateData, paidAmount, userId) {
    if (!stateData || !paidAmount) return;
    try {
        // 0. Si el usuario YA seleccionó ítems específicos en el contexto de la conversación (stateData.items)
        // y el monto pagado coincide con el total esperado de esa selección:
        if (stateData.items && Array.isArray(stateData.items) && stateData.items.length > 0) {
            const currentTotal = stateData.total || stateData.items.reduce((sum, item) => sum + (item.price || item.precio || 0), 0);
            if (currentTotal > 0 && Math.abs(currentTotal - paidAmount) < 500) {
                console.log(`[Duration Adjuster] 🎯 Respetando selección previa del contexto del chat: ${stateData.items.map(i => i.Streaming || i.name).join(', ')} ($${paidAmount}).`);
                stateData.total = paidAmount;
                stateData.leftoverAmount = 0;
                return;
            }
        }

        const phoneNumber = await resolveRealPhoneFromJid(userId);
        const userAccounts = await getAccountsByPhone(phoneNumber);
        if (!userAccounts || userAccounts.length === 0) return;

        const platforms = await getPlatformKnowledge();

        // 1. Probar si paidAmount coincide con la suma de todas las cuentas del usuario (para 1 a 12 meses)
        for (let m = 1; m <= 12; m++) {
            let totalWithDiscount = 0;
            let totalWithoutDiscount = 0;

            userAccounts.forEach(acc => {
                const price = getPlatformPriceFromExcel(acc, platforms);
                totalWithDiscount += price * m;
                totalWithoutDiscount += price * m;
            });

            if (userAccounts.length > 1) {
                totalWithDiscount = Math.max(0, totalWithDiscount - ((userAccounts.length - 1) * 1000 * m));
            }

            if (Math.abs(totalWithDiscount - paidAmount) < 500 || Math.abs(totalWithoutDiscount - paidAmount) < 500) {
                console.log(`[Duration Adjuster] ✅ Monto pagado $${paidAmount} coincide con renovación de ${m} mes(es) para ${userAccounts.length} cuenta(s).`);
                stateData.durationMonths = m;
                stateData.total = paidAmount;
                stateData.items = userAccounts;
                stateData.isRenewal = true;
                stateData.leftoverAmount = 0;
                return;
            }
        }

        // 2. Probar si paidAmount coincide con la renovación de 1 sola cuenta del usuario por M meses
        for (const acc of userAccounts) {
            const price = getPlatformPriceFromExcel(acc, platforms);

            for (let m = 1; m <= 12; m++) {
                if (price > 0 && Math.abs((price * m) - paidAmount) < 500) {
                    console.log(`[Duration Adjuster] ✅ Monto pagado $${paidAmount} coincide con renovación individual de ${acc.Streaming} por ${m} mes(es).`);
                    stateData.durationMonths = m;
                    stateData.total = paidAmount;
                    stateData.items = [acc];
                    stateData.isRenewal = true;
                    stateData.leftoverAmount = 0;
                    return;
                }
            }
        }

        // 3. Probar si paidAmount es $4.000 (NETFLIX EXTRA / Miembro Extra)
        if (Math.abs(paidAmount - 4000) < 500) {
            console.log(`[Duration Adjuster] 🎯 Monto pagado $${paidAmount} es $4.000 (NETFLIX EXTRA).`);
            stateData.items = [{ Streaming: 'NETFLIX EXTRA', price: 4000, name: 'NETFLIX EXTRA' }];
            stateData.total = paidAmount;
            stateData.isRenewal = false;
            stateData.leftoverAmount = 0;
            return;
        }

        // 4. Si el monto NO coincide con ninguna renovación ni extra, NO marcar arbitrariamente como renovación.
        console.log(`[Duration Adjuster] ⚠️ Monto pagado $${paidAmount} no coincide con renovación exacta del usuario.`);
    } catch (e) {
        console.error('[Duration Adjuster] Error en ajuste de duración:', e.message);
    }
}

/**
 * Procesa la solicitud de precios/deudas de un usuario (Opción 3 del menú).
 */
async function processCheckPrices(message, userId, userStates, inputToUse = "", detectedPlatform = null, durationMonths = 1) {
    try {
        const client = (message && message._client) || (typeof global !== 'undefined' ? global.client : null);
        let phoneNumber = await resolveRealPhoneFromJid(userId, client);
        let contactName = null;
        try {
            if (message && typeof message.getContact === 'function') {
                const contact = await message.getContact();
                if (contact) {
                    contactName = contact.name || contact.pushname;
                }
            }
        } catch (contactErr) {
            console.warn("[processCheckPrices] No se pudo obtener contacto del mensaje:", contactErr.message);
        }

        const userAccounts = await getAccountsByPhone(phoneNumber, contactName);

        if (userAccounts.length === 0) {
            await safeSend(message, "🤖 No encontré servicios activos vinculados a este número para renovar. Si deseas comprar algo nuevo, escribe *1*.", userId);
            return;
        }

        const platforms = await getPlatformKnowledge();
        const today = getTodayInBogota();
        
        let response = `💰 *TU RESUMEN DE PAGO${durationMonths > 1 ? ` (${durationMonths} MESES)` : ''}*\n\n`;
        let total = 0;
        let itemsForRenewal = [];

        let hasZeroPrice = false;
        
        // 0. Filtrar filas de Excel malformadas o inválidas (como 'gmail.com', dominios o vacías)
        let validUserAccounts = userAccounts.filter(acc => {
            const str = (acc.Streaming || "").toString().trim().toLowerCase();
            if (!str) return false;
            if (str === 'gmail.com' || str === 'hotmail.com' || str === 'outlook.com' || str.includes('@') || str.endsWith('.com') || str.endsWith('.net')) return false;
            return true;
        });

        if (validUserAccounts.length === 0) {
            validUserAccounts = userAccounts;
        }

        let accountsToProcess = validUserAccounts;

        // Detección de múltiples plataformas en la entrada del usuario (ej: "disney y spotify")
        const platformKeywords = ['netflix', 'disney', 'max', 'hbo', 'prime', 'amazon', 'spotify', 'youtube', 'apple', 'crunchyroll', 'vix', 'paramount', 'canva', 'chatgpt', 'gpt', 'claude', 'gemini', 'microsoft'];
        const inputLower = (inputToUse || "").toLowerCase();
        const matchedKeywords = platformKeywords.filter(p => inputLower.includes(p) || (detectedPlatform && detectedPlatform.toLowerCase().includes(p)));

        if (matchedKeywords.length > 0) {
            const filtered = validUserAccounts.filter(acc => {
                const current = (acc.Streaming || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                return matchedKeywords.some(p => current.includes(p) || p.includes(current));
            });
            if (filtered.length > 0) {
                accountsToProcess = filtered;
            }
        } else {
            // Si no hay plataforma específica, filtramos para renovar solo servicios vencidos o por vencer pronto (próximos 5 días)
            const expiredOrExpiring = validUserAccounts.filter(acc => {
                const vencimientoRaw = acc.deben || acc.vencimiento;
                const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
                if (!vencimientoDate) return false;
                
                const isExpired = vencimientoDate < today;
                const diffTime = vencimientoDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
                
                return isExpired || diffDays <= 5;
            });
            
            if (expiredOrExpiring.length > 0) {
                accountsToProcess = expiredOrExpiring;
            }
        }

        accountsToProcess.forEach(acc => {
            const streaming = (acc.Streaming || "").toUpperCase();
            const vencimientoRaw = acc.deben || acc.vencimiento;
            const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
            
            // Buscar precio priorizando el precio del cliente en Excel y luego catálogo de la página
            let price = getPlatformPriceFromExcel(acc, platforms);
            if (price === 0) hasZeroPrice = true;
            
            const isExpired = vencimientoDate && vencimientoDate < today;
            const isToday = vencimientoDate && vencimientoDate.getTime() === today.getTime();
            
            let status = "✅ Vigente";
            if (isExpired) status = "⚠️ VENCIDO";
            else if (isToday) status = "⚠️ VENCE HOY";

            const dateStr = vencimientoDate ? vencimientoDate.toLocaleDateString('es-CO') : 'N/A';

            const customerMail = (acc["customer mail"] || acc["Customer Mail"] || "").toString().trim();
            let emailToShow = customerMail;
            if (!emailToShow) {
                const adminMail = (acc.correo || 'Sin correo').toString().trim();
                emailToShow = acc.correo ? `${adminMail} *(Administrador)*` : adminMail;
            }
            response += `📺 *${streaming}*\n`;
            response += `📧 ${emailToShow}\n`;
            response += `📅 Vence: ${dateStr} (${status})\n`;
            if (durationMonths > 1) {
                const multiPrice = price * durationMonths;
                response += `💵 Valor: $${price}/mes x ${durationMonths} meses = *$${multiPrice}*\n\n`;
                total += multiPrice;
                itemsForRenewal.push({ ...acc, price: multiPrice, platform: { name: (acc.Streaming || 'Servicio') } });
            } else {
                response += `💵 Valor: $${price}\n\n`;
                total += price;
                itemsForRenewal.push({ ...acc, price, platform: { name: (acc.Streaming || 'Servicio') } });
            }
        });

        // FALLBACK: Si algún precio es cero o el total es cero, no enviar resumen automático
        if (hasZeroPrice || total === 0) {
            console.log(`[Billing Service] Fallback activado: Precio cero detectado para el usuario ${userId}`);
            await safeSend(message, "🤖 No pude calcular automáticamente el valor total de tu renovación debido a una discrepancia en los nombres de los servicios registrados. \n\nPor favor, espera un momento a que un asesor humano revise tu caso y te envíe el valor correcto manualmente. ¡Gracias por tu paciencia! 😊", userId);
            return;
        }

        // Lógica de descuento por combo: solo aplica si las plataformas a renovar tienen la misma fecha de vencimiento (fecha idéntica)
        const vencimientoStrings = itemsForRenewal.map(item => {
            const rawDate = item.deben || item.vencimiento;
            if (!rawDate) return null;
            const jsDate = getJsDateFromExcel(rawDate);
            if (!jsDate || isNaN(jsDate.getTime())) return null;
            return jsDate.toISOString().split('T')[0];
        }).filter(Boolean);

        const uniqueDates = [...new Set(vencimientoStrings)];
        const allDatesIdentical = uniqueDates.length === 1 && vencimientoStrings.length === itemsForRenewal.length;

        if (total > 0 && itemsForRenewal.length > 1 && allDatesIdentical) {
            const discount = (itemsForRenewal.length - 1) * 1000 * durationMonths;
            total -= discount;
            response += `✨ *Descuento por combo:* -$${discount.toLocaleString('es-CO')}\n`;
        }

        // Detección automática de Churn (si renueva una plataforma pero deja vencer otras)
        const churnPlatforms = [];
        let churnText = "";
        if (detectedPlatform) {
            const notRenewed = userAccounts.filter(acc => !accountsToProcess.includes(acc));
            const expiredOrExpiringSoon = notRenewed.filter(acc => {
                const venc = acc.deben || acc.vencimiento;
                const vencDate = getJsDateFromExcel(venc);
                if (!vencDate) return false;
                const isExpired = vencDate < today;
                const diffTime = vencDate.getTime() - today.getTime();
                const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
                return isExpired || diffDays <= 3;
            });
            
            if (expiredOrExpiringSoon.length > 0) {
                const { updateExcelData } = require('./apiService');
                const dateStr = new Date().toLocaleDateString('es-CO');
                for (const acc of expiredOrExpiringSoon) {
                    const rowNum = acc._rowNumber || acc.index;
                    if (rowNum) {
                        churnPlatforms.push(rowNum);
                        await updateExcelData(rowNum, { "observaciones": `cortar (bot ${dateStr})` }).catch(e => {});
                    }
                }
                const platformNames = expiredOrExpiringSoon.map(acc => (acc.Streaming || "Servicio").toUpperCase()).join(', ');
                churnText = `\n\n😔 *Nota:* Veo que decidiste no continuar con tu servicio de *${platformNames}*. Nos encantaría seguir mejorando: ¿podrías contarnos brevemente la razón de tu decisión? Tu opinión nos ayuda mucho.`;
            }
        }

        response += `*TOTAL A PAGAR: $${total}*\n\n`;

        const currentState = userStates.get(userId) || {};
        const isPaymentAlreadyReceived = currentState.state === 'awaiting_payment_confirmation' || currentState.state === 'waiting_human' || (currentState.lastPaymentValidated && Date.now() - currentState.lastPaymentValidated < 1000 * 60 * 20);

        if (isPaymentAlreadyReceived) {
            response += `✅ *Comprobante Registrado:* He asociado estos servicios (*${itemsForRenewal.map(i => i.platform?.name || 'Servicio').join(', ')}*) a tu pago realizado. Un asesor o el sistema automático actualizará las fechas de vencimiento de tus pantallas de inmediato. ¡Gracias! 😊`;
            await safeSend(message, response, userId);
            return;
        }

        response += "🤖 ¿Por cuál medio deseas realizar la transferencia?\n\n⭐ *QR Negocios (RECOMENDADO - ENTREGA INMEDIATA ⚡)*\n⭐ *Llave Bre-V (AUTOMÁTICA ⚡)*:\n   • Celular: *0087387259*\n⭐ *Bancolombia (Abono Directo - VALIDACIÓN AUTOMÁTICA ⚡)*:\n   • Ahorros: *46772753713* (CC: 1032936324)\n\n💡 *Tip de Renovación:* Si pagas por un medio automático (QR, Llave Bre-V o Bancolombia), tu servicio se renovará al instante. **¡Así no se te volverá a repetir este recordatorio de cobro ya que tu fecha de vencimiento se actualiza de inmediato!** ⚡🤖";
        
        if (churnText) {
            response += churnText;
        }

        await safeSend(message, response, userId);
        
        // Actualizar estado para esperar comprobante y registrar ticket de trabajo humano
        userStates.set(userId, { 
            state: 'awaiting_payment_method', 
            total: total, 
            items: itemsForRenewal, 
            isRenewal: true,
            category: churnPlatforms.length > 0 ? 'Corte / Churn' : 'Aviso de Cobro / Renovación',
            durationMonths: durationMonths,
            churnPlatforms: churnPlatforms.length > 0 ? churnPlatforms : null
        });

    } catch (error) {
        console.error('[Billing Service] Error en processCheckPrices:', error);
        await safeSend(message, "🤖 Tuve un problema al calcular tus precios. Por favor espera a que un asesor revise tu caso.", userId);
    }
}

/**
 * Maneja el proceso automático de cobros (Aviso de Cobro).
 */
/**
 * Función auxiliar para enviar mensajes de cobro de forma masiva con delay anti-spam.
 */
async function sendBulkCharges(client, records, requesterId = null, userStates = null) {
  const file = path.join(__dirname, 'pending_charges.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch (e) { }
  const entry = { requester: requesterId || 'SYSTEM_AUTO', records, timestamp: new Date().toISOString() };
  existing.push(entry);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));

  // Load platform pricing definitions once to save DB/filesystem operations in the loop
  let platforms = [];
  try {
    platforms = await getPlatformKnowledge();
  } catch (err) {
    console.error("[Billing Auto] Error loading platform pricing for billing reminders:", err.message);
  }

  let exitosos = 0;
  for (const r of records) {
    const dest = r.phone + '@c.us';
    
    let vencimientoTxt = "tu suscripción está próxima a renovarse o ya venció";
    if (r.date || r.dateStr) {
        const d = r.date || r.dateStr;
        if (d === "MAÑANA") {
           vencimientoTxt = "el día de mañana se vence tu cuenta";
        } else {
           vencimientoTxt = `el día ${d} se venció tu cuenta`;
        }
    }
    
    const serviceName = r.textToShow || r.services?.join(', ') || r.service || 'tus servicios';
    let servicesToPrint = serviceName;
    
    // Dynamic total calculator for the initial reminder
    let totalText = "";
    let totalSum = 0;
    let targetAccounts = [];

    try {
      const userAccounts = await getAccountsByPhone(r.phone);
      if (userAccounts && userAccounts.length > 0) {
        const billedServicesList = [];
        
        // Match only services that are expiring or expired
        const today = getTodayInBogota();
        const expiredOrExpiring = userAccounts.filter(acc => {
            const vencimientoRaw = acc.deben || acc.vencimiento;
            const vencimientoDate = getJsDateFromExcel(vencimientoRaw);
            if (!vencimientoDate) return false;
            
            const isExpired = vencimientoDate < today;
            const diffTime = vencimientoDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));
            
            return isExpired || diffDays <= 5;
        });

        targetAccounts = expiredOrExpiring.length > 0 ? expiredOrExpiring : userAccounts;

        targetAccounts.forEach(acc => {
          const streaming = (acc.Streaming || "").toUpperCase();
          if (streaming) billedServicesList.push(streaming);
          const price = getPlatformPriceFromExcel(acc, platforms);
          totalSum += price;
        });

        // Apply combo discount in automatic charging notice
        const imminentRenewals = targetAccounts.filter(acc => {
            const expDate = getJsDateFromExcel(acc.deben || acc.vencimiento);
            if (!expDate) return false;
            const diffDays = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
            return diffDays <= 1;
        });
        if (totalSum > 0 && imminentRenewals.length > 1) {
            const discount = (imminentRenewals.length - 1) * 1000;
            totalSum -= discount;
        }

        if (totalSum > 0) {
          totalText = `\n\n*Total a transferir:* $${totalSum.toLocaleString('es-CO')} COP 💰\n*Medio de Pago:* Llave Bre-V: \`0087387259\` 🔑 (Entrega inmediata ⚡)`;
          if (billedServicesList.length > 0) {
              const uniqueBilled = Array.from(new Set(billedServicesList));
              servicesToPrint = uniqueBilled.join(', ');
          }
        }
      }
    } catch (calcErr) {
      console.error("[Billing Auto] Error calculating total for initial message:", calcErr.message);
    }

    try {
        const customMessage = `🤖 *Aviso de Cobro*\nHola ${r.name}, esperamos te encuentres muy bien.\nTe escribimos de Sheerit para recordarte que ${vencimientoTxt}.\n\nServicio(s): ${servicesToPrint}${totalText}\n\nEscribe *3* en este chat para conocer el desglose detallado (precios, combos y correos) o ver otros medios. ¡Gracias por preferirnos!`;
        await safeSend(null, customMessage, dest, client);
        
        if (userStates) {
            const st = userStates.get(dest);
            const stateStr = (typeof st === 'object') ? st.state : st;
            if (stateStr === 'waiting_human') {
                userStates.delete(dest);
                console.log(`[Auto-Billing] Cleared waiting_human state for ${dest} to allow automated interactions.`);
            }

            userStates.set(dest, {
                state: 'awaiting_payment_confirmation',
                total: totalSum || 0,
                isRenewal: true,
                items: targetAccounts || [],
                timestamp: Date.now()
            });
            console.log(`[Auto-Billing] Persisted cobro total $${totalSum} for ${dest} in userStates.`);
        }
        exitosos++;
    } catch(e) {
        console.error(`[Billing] Error enviando cobro a ${dest}:`, e.message);
    }
    
    // Pausa de seguridad (3s anti-spam)
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return exitosos;
}

async function handleCobrosParser(message, userId, userStates, pendingConfirmations) {
  // Obtener todo el texto que va después de la llamada al bot
  const bodyText = message.body || '';
  let payload = '';
  
  if (bodyText.includes(':')) {
    payload = bodyText.substring(bodyText.indexOf(':') + 1);
  } else {
    const commandRegex = /^@bot\s+(cobra\s+estos|porfa\s+haz\s+los\s+cobros\s+para\s+hoy\s+de|haz\s+los\s+cobros\s+de)\s*/i;
    payload = bodyText.replace(commandRegex, '');
  }

  const lines = payload.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const parsedLines = [];
  
  for (let line of lines) {
    line = line.replace(/\t/g, ' ').trim();
    line = line.replace(/^[\*\-\•]\s*/, '').trim();
    
    let name = '';
    let phone = '';

    const telIndicatorRegex = /(?:tel|celular|telefono|teléfono):\s*(\d+)/i;
    const telMatch = line.match(telIndicatorRegex);
    
    if (telMatch) {
      phone = telMatch[1].trim();
      const namePart = line.split(telIndicatorRegex)[0].replace(/[\-,\s]+$/, '').trim();
      name = namePart;
    } else {
      const parts = line.includes(',') ? line.split(',') : line.split('-');
      name = (parts[0] || '').trim();
      const rest = (parts.slice(1).join(',') || '').trim();
      phone = (rest.match(/\d+/g) || []).join('');
    }

    if (name && phone) {
      if (!phone.startsWith('57') && !phone.startsWith('52')) {
        if (phone.length === 10) phone = '57' + phone;
      }
      parsedLines.push({ name, phone });
    }
  }

  if (parsedLines.length === 0) {
    await safeSend(message, '🤖 No pude parsear ninguna línea de números de la lista. Verifica el formato e intenta nuevamente.', userId);
    return;
  }

  // Si no hay parámetro de ejecución o es análisis
  const finalRecords = [];
  const skippedList = [];

  for (const { name, phone } of parsedLines) {
    const destId = phone + '@c.us';
    const currentState = userStates ? userStates.get(destId) : null;
    const stateStr = (typeof currentState === 'object') ? currentState.state : currentState;

    if (stateStr === 'waiting_admin_confirmation') {
      skippedList.push({ name, phone, reason: `Actividad o pago en proceso (${stateStr})` });
      continue;
    }

    const { getAccountsByPhone } = require('./apiService');
    const userAccounts = await getAccountsByPhone(phone, name);

    if (!userAccounts || userAccounts.length === 0) {
      skippedList.push({ name, phone, reason: 'Sin servicios registrados en la base de datos' });
      continue;
    }

    finalRecords.push({
      name: userAccounts[0].Nombre || name,
      phone,
      services: userAccounts.map(a => a.Streaming || a.streaming || 'Servicio')
    });
  }

  let report = `📋 *REPORTE DE COBROS MANUALES DETECTADOS*\n\n`;
  report += `✅ *Cuentas a cobrar (${finalRecords.length}):*\n`;
  finalRecords.forEach(r => {
    report += `• ${r.name} - Tel: ${r.phone} (${r.services.join(', ')})\n`;
  });

  if (skippedList.length > 0) {
    report += `\n⚠️ *Omitidos de seguridad (${skippedList.length}):*\n`;
    skippedList.forEach(s => {
      report += `• ${s.name} - Tel: ${s.phone} (${s.reason})\n`;
    });
  }

  report += `\n¿Deseas enviar los cobros a estas cuentas ahora mismo?\nResponde *@bot confirmar cobros* para proceder o *@bot cancelar cobros* para anular.`;

  pendingConfirmations.set(userId, {
    timestamp: Date.now(),
    records: finalRecords
  });

  await safeSend(message, report, userId);
}

async function handleAwaitingCobrosConfirmation(message, userId, userStates, pendingConfirmations) {
  const text = (message.body || '').toLowerCase().trim();
  const pendingData = pendingConfirmations.get(userId);

  if (!pendingData) {
    await safeSend(message, '🤖 No hay cobros pendientes para confirmar.', userId);
    return;
  }

  if (text.includes('confirmar') || text === 'si' || text === 'sí') {
    const { records } = pendingData;
    pendingConfirmations.delete(userId);

    await safeSend(message, `🚀 *Iniciando envío de ${records.length} cobros confirmados...*`, userId);

    const exitosos = await sendBulkCharges(message._client, records, userId, userStates);

    await safeSend(message, `🤖 He finalizado el proceso.\n- Total: ${records.length}\n- Enviados con éxito: ${exitosos}\n- Fallidos: ${records.length - exitosos}`, userId);
  } else if (text.includes('cancelar') || text === 'no') {
    pendingConfirmations.delete(userId);
    await safeSend(message, '🤖 Operación cancelada. No se enviaron cobros.', userId);
  } else {
    await safeSend(message, '🤖 Por favor responde *@bot confirmar cobros* para proceder o *@bot cancelar cobros* para anular.', userId);
  }
}

async function handleAutoCobros(message, userId, userStates, pendingConfirmations, client) {
  try {
    const { fetchCustomersData } = require('./apiService');
    const clientes = await fetchCustomersData();
    
    const today = getTodayInBogota();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    let records = [];
    const { updateExcelData } = require('./apiService');
    
    for (const account of clientes) {
      let isTargetDate = false;
      let accountDate = null;
      let diffDays = 0;
      
      accountDate = getJsDateFromExcel(account.deben);
      if (accountDate) {
        if (accountDate.getTime() <= tomorrow.getTime()) {
           isTargetDate = true;
        }
        const diffTime = today.getTime() - accountDate.getTime();
        diffDays = Math.floor(diffTime / (1000 * 3600 * 24));
      }
      
      if (isTargetDate && account.numero) {
        let phone = account.numero.toString().replace(/\D/g, '');
        if (!phone.startsWith('57')) {
          if (phone.length === 10) phone = '57' + phone;
        }
        
        const destId = phone + '@c.us';
        const currentState = userStates.get(destId);
        const stateStr = (typeof currentState === 'object') ? currentState.state : currentState;

        let observacion = (account.observaciones || '').toString().trim();
        let dateStr = accountDate ? accountDate.toLocaleDateString('es-ES') : '';
        if (accountDate && accountDate.getTime() === tomorrow.getTime()) {
            dateStr = "MAÑANA";
        }

        // LÓGICA DE SUSPENSIÓN (CORTAR)
        let wasSuspendedNow = false;
        if (diffDays >= 3 && !observacion.toLowerCase().includes('cortar')) {
            observacion = observacion ? observacion + " - cortar" : "cortar";
            if (account.rowNumber) {
                updateExcelData(account.rowNumber, { "observaciones": observacion })
                    .then(() => console.log(`[SUSPENSIÓN] Se agregó 'cortar' a fila ${account.rowNumber} (${account.Nombre}) por >3 días de mora.`))
                    .catch(err => console.error(`Error auto-suspendiendo fila ${account.rowNumber}:`, err.message));
                wasSuspendedNow = true;
            }
        }

        // --- FILTRO DE SEGURIDAD ---
        if (stateStr === 'waiting_admin_confirmation') {
          records.push({ 
            name: account.Nombre || 'Cliente', 
            phone, 
            service: account.Streaming || 'Servicio',
            dateStr,
            observacion: `Ya hay actividad o pago en este chat (${stateStr}).`,
            isSkip: true
          });
          continue;
        }
        
        records.push({ 
          name: account.Nombre || 'Cliente', 
          phone, 
          service: account.Streaming || 'Servicio',
          dateStr,
          observacion,
          wasSuspendedNow // Bandera para enviar mensaje de corte hoy
        });
      }
    }

    if (records.length === 0) {
      await safeSend(message, '🤖 Revisé la base de datos y no encontré cobros pendientes para hoy o fechas anteriores en la columna "deben".', userId, client);
      return;
    }

    const toChargeUsers = new Map();
    const toReviewUsers = new Map();
    const toNotifyAdminUsers = new Map();
    const toSuspendUsers = new Map();
    
    records.forEach(r => {
      if (r.isSkip) {
        if (!toNotifyAdminUsers.has(r.phone)) {
            toNotifyAdminUsers.set(r.phone, { name: r.name, phone: r.phone, services: [], reason: r.observacion });
        }
        toNotifyAdminUsers.get(r.phone).services.push(r.service);
        return;
      }

      if (r.wasSuspendedNow) {
          if (!toSuspendUsers.has(r.phone)) {
              toSuspendUsers.set(r.phone, { name: r.name, phone: r.phone, services: [] });
          }
          toSuspendUsers.get(r.phone).services.push(r.service);
          return;
      }

      const lowerObs = r.observacion ? r.observacion.toLowerCase() : '';
      const hasCorte = lowerObs.includes('cortar') || lowerObs.includes('corte');
      
      if (r.observacion && hasCorte) {
         // Va a revisión manual, SÓLO este servicio específico
         if (!toReviewUsers.has(r.phone)) {
           toReviewUsers.set(r.phone, { name: r.name, phone: r.phone, services: [] });
         }
         toReviewUsers.get(r.phone).services.push(`${r.service} (Nota: ${r.observacion})`);
      } else {
         // Va a cobrar (incluso si hay notas, si no son de corte, se adjuntan)
         if (!toChargeUsers.has(r.phone)) {
           toChargeUsers.set(r.phone, { name: r.name, phone: r.phone, services: [], date: r.dateStr });
         }
         let serviceDisplay = r.service;
         if (r.observacion) {
           serviceDisplay += ` (Nota del asesor: ${r.observacion})`;
         }
         toChargeUsers.get(r.phone).services.push(serviceDisplay);
      }
    });

    const toCharge = Array.from(toChargeUsers.values());
    const toReview = Array.from(toReviewUsers.values());
    const toNotify = Array.from(toNotifyAdminUsers.values());
    const toSuspend = Array.from(toSuspendUsers.values());

    if (toCharge.length === 0 && toReview.length === 0 && toNotify.length === 0 && toSuspend.length === 0) {
      await safeSend(message, '🤖 No se encontraron cobros, revisiones ni pagos pendientes para procesar.', userId, client);
      return;
    }

    // AVISAR QUE INICIAMOS
    await safeSend(message, `🤖 *PROCESO AUTOMÁTICO DE COBROS INICIADO*\n\nHe encontrado ${toCharge.length} para cobrar, ${toSuspend.length} para corte inminente, ${toReview.length} para revisión y ${toNotify.length} con pagos/actividad pendiente. Procedo con el envío...`, userId, client);

    // EJECUCIÓN DIRECTA
    let exitosos = 0;
    if (toCharge.length > 0) {
        exitosos = await sendBulkCharges(client || message._client, toCharge, userId, userStates);
    }
    
    // ENVIAR AVISO DE CORTE
    let exitososCorte = 0;
    for (const r of toSuspend) {
        try {
            const destId = r.phone + '@c.us';
            const suspendMsg = `⚠️ *AVISO DE CORTE INMINENTE* ⚠️\n\nHola ${r.name}, te informamos que por falta de respuesta, tus cuentas de *${r.services.join(', ')}* serán suspendidas el día de hoy a menos de que envíes el comprobante de pago en el transcurso del día.\n\nPor favor envíanos tu comprobante lo antes posible para evitar la interrupción del servicio.`;
            await safeSend(null, suspendMsg, destId, client || message._client);
            if (userStates && userStates.has(destId)) {
                const st = userStates.get(destId);
                const stateStr = (typeof st === 'object') ? st.state : st;
                if (stateStr === 'waiting_human') {
                    userStates.delete(destId);
                    console.log(`[Auto-Billing] Cleared waiting_human state for ${destId} during suspension notice.`);
                }
            }
            exitososCorte++;
            await new Promise(res => setTimeout(res, 1000));
        } catch (e) {
            console.error(`Error enviando aviso de corte a ${r.phone}:`, e);
        }
    }

    // CREAR TICKETS EN MARIADB ÚNICAMENTE PARA LOS QUE YA TIENEN EL AVISO DE CORTE PREVIO
    if (toReview.length > 0) {
        try {
            const { pool } = require('./database');
            for (const r of toReview) {
                const destId = r.phone + '@c.us';
                await pool.query(
                    'INSERT IGNORE INTO chats (chat_id, customer_phone, last_message_text, last_message_time) VALUES (?, ?, ?, NOW())',
                    [destId, r.phone, `Corte de Servicio: ${r.name}`]
                );
                await pool.query(
                    `INSERT INTO tickets (chat_id, title, description, status, priority) 
                     VALUES (?, ?, ?, 'open', 'high')
                     ON DUPLICATE KEY UPDATE status = 'open', priority = 'high'`,
                    [
                        destId,
                        `Corte de Servicio: ${r.name}`,
                        `Corte requerido por mora persistente tras aviso de corte previo. Servicios: ${r.services.join(' | ')}`
                    ]
                );
                if (userStates) {
                    const st = userStates.get(destId) || {};
                    userStates.set(destId, { ...st, state: 'waiting_human', category: 'Corte / Churn', churnPlatforms: r.services });
                }
            }
        } catch (ticketErr) {
            console.error('Error creando tickets de corte en MariaDB:', ticketErr.message);
        }
    }

    let finalReport = `✅ *REPORTE DE EJECUCIÓN FINALIZADO*\n\n`;
    finalReport += `- Cobros enviados: ${exitosos}/${toCharge.length}\n`;
    finalReport += `- Avisos de corte enviados: ${exitososCorte}/${toSuspend.length}\n`;
    
    if (toSuspend.length > 0) {
      finalReport += `\n🚨 *CUENTAS MARCADAS PARA CORTE HOY:*\n`;
      toSuspend.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone}\n  Servicios: ${r.services.join(', ')}\n`;
      });
    }

    if (toReview.length > 0) {
      finalReport += `\n⚠️ *PENDIENTES PARA REVISIÓN MANUAL (Cortes antiguos):*\n`;
      toReview.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone}\n  Notas: ${r.services.join(' | ')}\n`;
      });
    }

    if (toNotify.length > 0) {
      finalReport += `\n📥 *PAGOS/CHATS POR VALIDAR (Bot saltó el cobro):*\n`;
      toNotify.forEach(r => {
        finalReport += `• ${r.name} - Tel: ${r.phone} (${r.services.join(', ')}) - Motivo: ${r.reason || 'Sin especificar'}\n`;
      });
    }

    finalReport += `\n_El bot ha terminado su tarea programada de la mañana._`;
    await safeSend(message, finalReport, userId, client);

  } catch (err) {
    console.error('Error calculando cobros automáticos:', err);
    await safeSend(message, 'Ocurrió un error al procesar los cobros automáticos. Intenta nuevamente.', userId, client);
  }
}

module.exports = {
  safeSend,
  getPlatformPriceFromExcel,
  calculateInternationalPrice,
  processCheckCredentials,
  processCheckPrices,
  handleAutoCobros,
  handleCobrosParser,
  handleAwaitingCobrosConfirmation,
  adjustDurationToMatchAmount,
  checkPendingWebSaleForPhone,
  resolveRealPhoneFromJid,
  isNameMatch
};
