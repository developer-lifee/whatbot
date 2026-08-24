const { pool } = require('../database');
const { fetchRawData } = require('../apiService');
const { resolveRealPhoneFromJid } = require('../billingService');

async function main() {
    console.log('--- RESOLVIENDO TODOS LOS LIDS EN BASE DE DATOS ---');
    const [rows] = await pool.query("SELECT chat_id, customer_phone FROM chats WHERE chat_id LIKE '%@lid' OR customer_phone IS NULL");
    console.log(`Total chats a revisar: ${rows.length}`);

    const excelData = await fetchRawData().catch(() => []);
    console.log(`Filas de Excel cargadas: ${excelData.length}`);

    let updated = 0;
    for (const r of rows) {
        const jid = r.chat_id;
        try {
            // 1. Obtener mensajes o contacto si es posible
            const [msgRows] = await pool.query("SELECT body FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 5", [jid]).catch(() => [[]]);
            
            // 2. Resolver con algoritmo flexible
            const resolved = await resolveRealPhoneFromJid(jid, null, null);
            if (resolved) {
                await pool.query("INSERT IGNORE INTO customers (phone, fullname) VALUES (?, ?)", [resolved, 'Cliente WhatsApp']).catch(() => {});
                await pool.query("UPDATE chats SET customer_phone = ? WHERE chat_id = ?", [resolved, jid]);
                console.log(`✅ Chat ${jid} resuelto a teléfono: ${resolved}`);
                updated++;
            }
        } catch (e) {
            console.error(`Error en ${jid}:`, e.message);
        }
    }
    console.log(`--- PROCESO COMPLETADO: ${updated} chats actualizados ---`);
    process.exit(0);
}

main().catch(err => {
    console.error('Error fatal:', err);
    process.exit(1);
});
