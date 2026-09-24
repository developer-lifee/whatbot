const { pool } = require('./database');

/**
 * Servicio y Controladores para el módulo Data Studio (DBeaver + ER + Ingesta)
 */

// Clasificación de tablas por dominio para el ER
const TABLE_DOMAINS = {
    customers: 'Clientes & Ventas',
    subscriptions: 'Clientes & Ventas',
    stream_accounts: 'Streaming & Proveedores',
    platforms: 'Streaming & Proveedores',
    platform_plans: 'Streaming & Proveedores',
    provider_credentials: 'Streaming & Proveedores',
    streaming_prices: 'Streaming & Proveedores',
    streaming_costs: 'Finanzas & Costos',
    cash_flow_entries: 'Finanzas & Costos',
    monthly_payroll: 'Agentes & Nómina',
    agent_bonuses: 'Agentes & Nómina',
    agent_schedules: 'Agentes & Nómina',
    agent_contract_history: 'Agentes & Nómina',
    agents: 'Agentes & Nómina',
    chats: 'Mensajería & Tickets',
    messages: 'Mensajería & Tickets',
    tickets: 'Mensajería & Tickets',
    tasks: 'Mensajería & Tickets',
    heavy_tickets: 'Mensajería & Tickets',
    heavy_ticket_comments: 'Mensajería & Tickets',
    resolved_tickets_log: 'Mensajería & Tickets',
    user_states: 'Mensajería & Tickets',
    rpa_recipes: 'Automatización & RPA',
    excel_historical_records: 'Histórico & Migración',
    web_sales_approved: 'Clientes & Ventas',
    web_sales_pending: 'Clientes & Ventas',
    page_visits: 'Métricas Web',
    page_clicks: 'Métricas Web',
    system_activity_logs: 'Sistema & Logs',
    system_configs: 'Sistema & Logs',
    drive_backups: 'Sistema & Logs'
};

/**
 * 1. Obtener lista de tablas, conteo de filas y columnas
 */
async function getTablesOverview() {
    const [tables] = await pool.query(`
        SELECT 
            TABLE_NAME as name,
            TABLE_ROWS as estimatedRows,
            DATA_LENGTH as dataLength,
            UPDATE_TIME as updateTime,
            TABLE_COMMENT as comment
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME ASC
    `);

    // Obtener conteo exacto y columnas por tabla
    const detailedTables = await Promise.all(tables.map(async (t) => {
        try {
            const [[{ count }]] = await pool.query(`SELECT COUNT(*) as count FROM \`${t.name}\``);
            const [cols] = await pool.query(`
                SELECT 
                    COLUMN_NAME as name, 
                    DATA_TYPE as dataType, 
                    COLUMN_TYPE as fullType,
                    COLUMN_KEY as colKey, 
                    IS_NULLABLE as isNullable,
                    COLUMN_DEFAULT as defaultValue
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION ASC
            `, [t.name]);

            return {
                name: t.name,
                domain: TABLE_DOMAINS[t.name] || 'General',
                exactRows: count,
                estimatedRows: t.estimatedRows,
                columns: cols.map(c => ({
                    name: c.name,
                    dataType: c.dataType,
                    fullType: c.fullType,
                    isPk: c.colKey === 'PRI',
                    isFk: c.colKey === 'MUL',
                    isNullable: c.isNullable === 'YES',
                    defaultValue: c.defaultValue
                }))
            };
        } catch (e) {
            return {
                name: t.name,
                domain: TABLE_DOMAINS[t.name] || 'General',
                exactRows: t.estimatedRows || 0,
                columns: []
            };
        }
    }));

    return detailedTables;
}

/**
 * 2. Ejecutar consulta SQL de forma controlada y segura
 */
async function executeStudioQuery(sql, options = {}) {
    const trimmed = (sql || '').trim();
    if (!trimmed) throw new Error('La consulta SQL no puede estar vacía.');

    // Validar sentencias peligrosas para evitar destrucciones accidentales
    const upper = trimmed.toUpperCase();
    const isDangerous = /^(DROP|TRUNCATE|ALTER|RENAME)\b/i.test(upper);
    if (isDangerous) {
        throw new Error('Las operaciones DDL estructurales (DROP, TRUNCATE, ALTER) están restringidas en este módulo por seguridad operativa.');
    }

    const isWrite = /^(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(upper);
    if (isWrite && !options.allowWrite) {
        throw new Error('Operación de escritura detectada. Debes habilitar la casilla "Permitir Modificaciones" antes de ejecutar esta consulta.');
    }

    // Si es SELECT y no tiene LIMIT, agregar un límite de seguridad
    let finalSql = trimmed;
    if (/^SELECT\b/i.test(upper) && !/\bLIMIT\b/i.test(upper)) {
        const defaultLimit = Math.min(options.limit || 100, 500);
        finalSql += ` LIMIT ${defaultLimit}`;
    }

    const startTime = Date.now();
    const [result, fields] = await pool.query(finalSql);
    const executionTimeMs = Date.now() - startTime;

    if (Array.isArray(result)) {
        const columns = (fields || []).map(f => ({
            name: f.name,
            type: f.type
        }));
        return {
            success: true,
            isResultSet: true,
            columns,
            rows: result,
            rowCount: result.length,
            executionTimeMs
        };
    } else {
        // Resultado de INSERT, UPDATE o DELETE
        return {
            success: true,
            isResultSet: false,
            affectedRows: result.affectedRows,
            insertId: result.insertId,
            changedRows: result.changedRows,
            executionTimeMs
        };
    }
}

/**
 * 3. Obtener el Grafo de Modelo Entidad-Relación (ER)
 */
async function getSchemaGraph() {
    const tablesOverview = await getTablesOverview();

    // 1. Relaciones físicas con Foreign Key
    const [fkRows] = await pool.query(`
        SELECT 
            TABLE_NAME as fromTable,
            COLUMN_NAME as fromColumn,
            CONSTRAINT_NAME as constraintName,
            REFERENCED_TABLE_NAME as toTable,
            REFERENCED_COLUMN_NAME as toColumn
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
    `);

    // 2. Relaciones lógicas reconocidas en el dominio
    const logicalRelations = [
        { fromTable: 'subscriptions', fromColumn: 'streaming_platform', toTable: 'platforms', toColumn: 'name', type: 'logical' },
        { fromTable: 'subscriptions', fromColumn: 'account_email', toTable: 'stream_accounts', toColumn: 'account_email', type: 'logical' },
        { fromTable: 'stream_accounts', fromColumn: 'streaming_platform', toTable: 'platforms', toColumn: 'name', type: 'logical' },
        { fromTable: 'stream_accounts', fromColumn: 'rpa_recipe_id', toTable: 'rpa_recipes', toColumn: 'id', type: 'logical' },
        { fromTable: 'excel_historical_records', fromColumn: 'customer_phone', toTable: 'customers', toColumn: 'phone', type: 'logical' },
        { fromTable: 'messages', fromColumn: 'chat_id', toTable: 'chats', toColumn: 'chat_id', type: 'logical' },
        { fromTable: 'user_states', fromColumn: 'chat_id', toTable: 'chats', toColumn: 'chat_id', type: 'logical' },
        { fromTable: 'web_sales_approved', fromColumn: 'whatsapp', toTable: 'customers', toColumn: 'phone', type: 'logical' },
        { fromTable: 'web_sales_approved', fromColumn: 'platformName', toTable: 'platforms', toColumn: 'name', type: 'logical' },
        { fromTable: 'web_sales_pending', fromColumn: 'whatsapp', toTable: 'customers', toColumn: 'phone', type: 'logical' },
        { fromTable: 'web_sales_pending', fromColumn: 'platformName', toTable: 'platforms', toColumn: 'name', type: 'logical' }
    ];

    const allEdges = [
        ...fkRows.map(r => ({ ...r, type: 'foreign_key' })),
        ...logicalRelations
    ];

    // Deduplicar aristas
    const edgeSet = new Set();
    const edges = allEdges.filter(e => {
        const key = `${e.fromTable}.${e.fromColumn}->${e.toTable}.${e.toColumn}`;
        if (edgeSet.has(key)) return false;
        edgeSet.add(key);
        return true;
    });

    return {
        nodes: tablesOverview,
        edges
    };
}

/**
 * 4. Analizar y Previsualizar Archivo para Importación Multi-Tenant
 */
function previewDataImport(headers, rawRows, targetEntity = 'subscriptions') {
    if (!headers || !headers.length) throw new Error('El archivo no contiene encabezados.');
    if (!rawRows || !rawRows.length) throw new Error('El archivo no contiene filas con datos.');

    const cleanHeaders = headers.map(h => String(h || '').trim());

    // Sugerencias automáticas según el target
    const suggestedMapping = {};
    const fieldSynonyms = {
        // customers
        phone: ['phone', 'telefono', 'teléfono', 'celular', 'whatsapp', 'numero', 'número', 'movil', 'móvil'],
        fullname: ['fullname', 'nombre', 'nombre completo', 'cliente', 'usuario', 'name'],
        email: ['email', 'correo', 'e-mail', 'mail'],
        // stream_accounts / subscriptions
        streaming_platform: ['streaming', 'plataforma', 'servicio', 'platform', 'app'],
        account_email: ['correo cuenta', 'correo de la cuenta', 'cuenta', 'email cuenta', 'account_email', 'correo'],
        account_password: ['contraseña', 'password', 'clave', 'pass'],
        profile_pin: ['pin', 'pin perfil', 'perfil pin', 'pin_perfil', 'clave perfil'],
        expiration_date: ['vencimiento', 'fecha vencimiento', 'vence', 'fecha de corte', 'corte', 'deben', 'columna4'],
        payment_method: ['metodo de pago', 'método de pago', 'forma de pago', 'pago', 'medio de pago'],
        notes: ['observaciones', 'notas', 'comentarios', 'detalles']
    };

    cleanHeaders.forEach((header) => {
        const hLower = header.toLowerCase().replace(/[^a-z0-9áéíóú]/gi, ' ').trim();
        for (const [field, synonyms] of Object.entries(fieldSynonyms)) {
            if (synonyms.some(s => hLower === s || (s.length >= 4 && hLower.includes(s)))) {
                if (!suggestedMapping[field]) {
                    suggestedMapping[field] = header;
                }
            }
        }
    });

    // Muestra de primeras 5 filas procesadas
    const previewRows = rawRows.slice(0, 5).map((row, rowIdx) => {
        const mappedRow = {};
        for (const [field, headerName] of Object.entries(suggestedMapping)) {
            mappedRow[field] = row[headerName] !== undefined ? row[headerName] : null;
        }
        return mappedRow;
    });

    return {
        totalRows: rawRows.length,
        availableHeaders: cleanHeaders,
        suggestedMapping,
        previewRows
    };
}

/**
 * 5. Ejecutar Ingesta / Transformación Multi-Tenant hacia MySQL
 */
async function executeDataImport({ targetEntity, mapping, rows, tenantId, options = {} }) {
    if (!rows || !rows.length) throw new Error('No hay filas para importar.');
    if (!mapping || !Object.keys(mapping).length) throw new Error('No se definió ningún mapeo de columnas.');

    const cleanPhone = (val) => {
        if (!val) return null;
        let digits = String(val).replace(/\D/g, '');
        if (digits.length === 10 && digits.startsWith('3')) {
            digits = '57' + digits;
        }
        return digits.length >= 10 ? digits : null;
    };

    const parseDate = (val) => {
        if (!val) return null;
        if (val instanceof Date && !isNaN(val)) {
            return val.toISOString().split('T')[0];
        }
        const str = String(val).trim();
        // Casos YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        // Casos DD/MM/YYYY
        const parts = str.split(/[/ -]/);
        if (parts.length === 3) {
            if (parts[0].length === 4) {
                return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
            }
            if (parts[2].length === 4) {
                return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
        }
        // Número de serie Excel
        const num = Number(str);
        if (!isNaN(num) && num > 20000 && num < 60000) {
            const excelEpoch = new Date(1899, 11, 30);
            const date = new Date(excelEpoch.getTime() + num * 86400000);
            return date.toISOString().split('T')[0];
        }
        return null;
    };

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const errors = [];

    // Usar conexión de transacción
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        for (let i = 0; i < rows.length; i++) {
            const raw = rows[i];
            const getVal = (field) => {
                const headerName = mapping[field];
                return headerName ? raw[headerName] : null;
            };

            try {
                if (targetEntity === 'customers') {
                    const phone = cleanPhone(getVal('phone'));
                    const fullname = String(getVal('fullname') || '').trim() || 'Cliente Sin Nombre';
                    const email = getVal('email') ? String(getVal('email')).trim() : null;
                    const notes = getVal('notes') ? String(getVal('notes')).trim() : null;

                    if (!phone) {
                        skippedCount++;
                        errors.push(`Fila ${i + 1}: Teléfono inválido (${getVal('phone')})`);
                        continue;
                    }

                    const [res] = await conn.query(`
                        INSERT INTO customers (phone, fullname, email, notes)
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                            fullname = COALESCE(VALUES(fullname), fullname),
                            email = COALESCE(VALUES(email), email),
                            notes = COALESCE(VALUES(notes), notes)
                    `, [phone, fullname, email, notes]);

                    if (res.affectedRows === 1) insertedCount++;
                    else updatedCount++;

                } else if (targetEntity === 'stream_accounts') {
                    const accountEmail = String(getVal('account_email') || '').trim();
                    const platform = String(getVal('streaming_platform') || '').trim().toUpperCase();
                    const password = getVal('account_password') ? String(getVal('account_password')).trim() : null;
                    const providerName = tenantId || (getVal('provider_name') ? String(getVal('provider_name')).trim() : 'General');
                    const notes = getVal('notes') ? String(getVal('notes')).trim() : null;

                    if (!accountEmail || !platform) {
                        skippedCount++;
                        errors.push(`Fila ${i + 1}: Correo o plataforma vacíos.`);
                        continue;
                    }

                    const [res] = await conn.query(`
                        INSERT INTO stream_accounts 
                            (account_email, streaming_platform, account_password, provider_name, notes, is_provider, status)
                        VALUES (?, ?, ?, ?, ?, 1, 'active')
                        ON DUPLICATE KEY UPDATE 
                            account_password = COALESCE(VALUES(account_password), account_password),
                            provider_name = COALESCE(VALUES(provider_name), provider_name),
                            notes = COALESCE(VALUES(notes), notes)
                    `, [accountEmail, platform, password, providerName, notes]);

                    if (res.affectedRows === 1) insertedCount++;
                    else updatedCount++;

                } else if (targetEntity === 'subscriptions' || targetEntity === 'full_excel_migration') {
                    const phone = cleanPhone(getVal('phone'));
                    const fullname = String(getVal('fullname') || '').trim() || 'Cliente Sin Nombre';
                    const platform = String(getVal('streaming_platform') || 'STREAMING').trim().toUpperCase();
                    const accountEmail = String(getVal('account_email') || '').trim();
                    const password = getVal('account_password') ? String(getVal('account_password')).trim() : null;
                    const profilePin = getVal('profile_pin') ? String(getVal('profile_pin')).trim() : null;
                    const expirationDate = parseDate(getVal('expiration_date'));
                    const paymentMethod = getVal('payment_method') ? String(getVal('payment_method')).trim() : null;
                    const notes = tenantId ? `Tenant: ${tenantId} | ${getVal('notes') || ''}` : (getVal('notes') || null);

                    if (!phone || !accountEmail) {
                        skippedCount++;
                        errors.push(`Fila ${i + 1}: Requiere teléfono (${phone}) y correo de cuenta (${accountEmail})`);
                        continue;
                    }

                    // 1. Asegurar que el cliente existe para respetar Foreign Key
                    await conn.query(`
                        INSERT INTO customers (phone, fullname)
                        VALUES (?, ?)
                        ON DUPLICATE KEY UPDATE fullname = IF(fullname = 'Cliente Sin Nombre', VALUES(fullname), fullname)
                    `, [phone, fullname]);

                    // 2. Insertar suscripción
                    const [res] = await conn.query(`
                        INSERT INTO subscriptions 
                            (customer_phone, streaming_platform, account_email, account_password, profile_pin, expiration_date, payment_method, notes, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
                        ON DUPLICATE KEY UPDATE
                            expiration_date = COALESCE(VALUES(expiration_date), expiration_date),
                            profile_pin = COALESCE(VALUES(profile_pin), profile_pin),
                            payment_method = COALESCE(VALUES(payment_method), payment_method),
                            notes = COALESCE(VALUES(notes), notes)
                    `, [phone, platform, accountEmail, password, profilePin, expirationDate, paymentMethod, notes]);

                    if (res.affectedRows === 1) insertedCount++;
                    else updatedCount++;
                }
            } catch (rowErr) {
                skippedCount++;
                errors.push(`Fila ${i + 1}: Error al insertar: ${rowErr.message}`);
            }
        }

        await conn.commit();
    } catch (txErr) {
        await conn.rollback();
        throw txErr;
    } finally {
        conn.release();
    }

    return {
        success: true,
        targetEntity,
        totalProcessed: rows.length,
        insertedCount,
        updatedCount,
        skippedCount,
        errors: errors.slice(0, 50) // Máximo 50 advertencias
    };
}

module.exports = {
    getTablesOverview,
    executeStudioQuery,
    getSchemaGraph,
    previewDataImport,
    executeDataImport
};
