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

/**
 * =========================================================================
 * 5. TUTOR PEDAGÓGICO DE SQL PARA SHEERIT DATA STUDIO
 * =========================================================================
 */

/**
 * Desglosa y explica cualquier consulta SQL en español claro y didáctico
 */
async function explainSqlQuery(sql) {
    const rawSql = (sql || '').trim();
    if (!rawSql) {
        return {
            title: 'Consulta vacía',
            overview: 'Escribe o pega una consulta SQL para que el tutor te la explique paso a paso.',
            steps: [],
            tips: ['Prueba seleccionando una plantilla en el menú desplegable de arriba.']
        };
    }

    const upper = rawSql.toUpperCase();
    const steps = [];
    let overview = '';
    let operationType = 'Consulta de Lectura (SELECT)';
    const tips = [];

    if (/^SELECT\b/i.test(upper)) {
        operationType = 'Lectura de Datos (SELECT)';
        overview = 'Esta consulta le pide a la base de datos extraer y mostrar información existente sin modificar nada (es 100% segura de ejecutar).';
        tips.push('Las consultas SELECT son ideales para explorar datos, generar reportes y entender relaciones.');

        // Extraer qué columnas pide
        const selectMatch = rawSql.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
        if (selectMatch) {
            const colsRaw = selectMatch[1].trim();
            if (colsRaw === '*') {
                steps.push({
                    clause: 'SELECT *',
                    role: 'Selección de Columnas',
                    explanation: 'El asterisco (*) significa "tráeme TODAS las columnas de la tabla". Es muy útil para explorar, pero en sistemas grandes es mejor nombrar solo las que necesitas.',
                    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                });
            } else {
                steps.push({
                    clause: `SELECT ${colsRaw.length > 60 ? colsRaw.slice(0, 60) + '...' : colsRaw}`,
                    role: 'Columnas Específicas',
                    explanation: `Estás solicitando columnas puntuales (${colsRaw.split(',').length} campos). Esto hace la consulta más rápida y clara.`,
                    badge: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300'
                });
            }
        }

        // Extraer FROM
        const fromMatch = rawSql.match(/FROM\s+([`\w]+(?:\s+AS\s+[`\w]+|\s+[`\w]+)?)/i);
        if (fromMatch) {
            const mainTable = fromMatch[1].trim().split(/\s+/)[0].replace(/`/g, '');
            const tableDesc = TABLE_DOMAINS[mainTable] ? `(Dominio: ${TABLE_DOMAINS[mainTable]})` : '';
            steps.push({
                clause: `FROM ${mainTable}`,
                role: 'Tabla Principal',
                explanation: `Indica la tabla de origen de los datos: "${mainTable}" ${tableDesc}. Es como abrir una pestaña de Excel específica.`,
                badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
            });
        }

        // Extraer JOINs
        const joinMatches = rawSql.match(/(?:INNER|LEFT|RIGHT)?\s*JOIN\s+([`\w]+)[\s\S]+?ON\s+([^\n;]+)/gi);
        if (joinMatches && joinMatches.length > 0) {
            joinMatches.forEach(j => {
                const jMatch = j.match(/JOIN\s+([`\w]+)\s+(?:AS\s+[`\w]+\s+)?ON\s+(.+)/i);
                if (jMatch) {
                    const joinedTable = jMatch[1].replace(/`/g, '');
                    const onCondition = jMatch[2].trim();
                    const isLeft = /LEFT/i.test(j);
                    steps.push({
                        clause: j.trim(),
                        role: isLeft ? 'Cruce Opcional (LEFT JOIN)' : 'Cruce Exacto (INNER JOIN)',
                        explanation: isLeft
                            ? `Une con la tabla "${joinedTable}" mediante "${onCondition}". El LEFT JOIN asegura que ningún registro de la tabla izquierda se pierda aunque no tenga coincidencia en "${joinedTable}".`
                            : `Conecta con la tabla "${joinedTable}" exigiendo que la condición "${onCondition}" exista en ambas tablas. Es como un BUSCARV perfecto.`,
                        badge: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300'
                    });
                }
            });
            tips.push('Los JOINs son la superpotencia de las bases de datos relacionales: conectan datos dispersos usando un identificador común (ej. el teléfono o correo).');
        }

        // Extraer WHERE
        const whereMatch = rawSql.match(/WHERE\s+([\s\S]+?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|;|$)/i);
        if (whereMatch) {
            steps.push({
                clause: `WHERE ${whereMatch[1].trim()}`,
                role: 'Filtro / Condición',
                explanation: `Filtra las filas para procesar únicamente las que cumplan: "${whereMatch[1].trim()}". Es el colador que descarta los datos que no te interesan.`,
                badge: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
            });
        }

        // Extraer GROUP BY
        const groupMatch = rawSql.match(/GROUP\s+BY\s+([\s\S]+?)(?:\s+HAVING|\s+ORDER\s+BY|\s+LIMIT|;|$)/i);
        if (groupMatch) {
            steps.push({
                clause: `GROUP BY ${groupMatch[1].trim()}`,
                role: 'Agrupación / Resumen',
                explanation: `Agrupa las filas por "${groupMatch[1].trim()}". Es el equivalente a una tabla dinámica de Excel para calcular totales, promedios o conteos por categoría.`,
                badge: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
            });
        }

        // Extraer ORDER BY
        const orderMatch = rawSql.match(/ORDER\s+BY\s+([\s\S]+?)(?:\s+LIMIT|;|$)/i);
        if (orderMatch) {
            const isDesc = /DESC/i.test(orderMatch[1]);
            steps.push({
                clause: `ORDER BY ${orderMatch[1].trim()}`,
                role: 'Ordenamiento',
                explanation: `Ordena los resultados por "${orderMatch[1].trim()}" (${isDesc ? 'de mayor a menor / más reciente a más antiguo' : 'de menor a mayor / orden alfabético'}).`,
                badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
            });
        }

        // Extraer LIMIT
        const limitMatch = rawSql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) {
            steps.push({
                clause: `LIMIT ${limitMatch[1]}`,
                role: 'Límite de Seguridad',
                explanation: `Restringe el resultado a máximo ${limitMatch[1]} filas para proteger la memoria del navegador y responder al instante.`,
                badge: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
            });
        } else {
            tips.push('💡 Consejo del tutor: Siempre usa LIMIT cuando explores tablas con miles de filas para que tus consultas vuelen.');
        }

    } else if (/^UPDATE\b/i.test(upper)) {
        operationType = 'Modificación de Datos (UPDATE)';
        overview = '⚠️ Esta consulta va a MODIFICAR valores existentes en una tabla.';
        if (!upper.includes('WHERE')) {
            overview += ' 🚨 ¡ALERTA CRÍTICA! No tiene cláusula WHERE. Modificaría TODAS las filas de la tabla sin excepción.';
            tips.push('Regla de Oro en SQL: NUNCA ejecutes un UPDATE sin WHERE a menos que sea 100% deliberado.');
        }
    } else if (/^INSERT\b/i.test(upper)) {
        operationType = 'Creación de Datos (INSERT)';
        overview = 'Esta consulta CREA e inserta nuevas filas en una tabla.';
        tips.push('Si los campos no coinciden con las restricciones de tipo o longitud, la base de datos rechazará la inserción para proteger la integridad.');
    } else if (/^DELETE\b/i.test(upper)) {
        operationType = 'Eliminación de Datos (DELETE)';
        overview = '🚨 Esta consulta ELIMINA filas permanentemente.';
        if (!upper.includes('WHERE')) {
            overview += ' 🛑 ¡CUIDADO EXTREMO! Al no tener WHERE borraría TODO el contenido de la tabla.';
        }
    }

    return {
        title: operationType,
        overview,
        steps,
        tips
    };
}

/**
 * Biblioteca de preguntas comunes en lenguaje natural con SQL educativo
 */
const TUTOR_KNOWLEDGE_QUESTIONS = [
    {
        keywords: ['venc', 'expir', 'proxim', 'dias', 'renov'],
        title: 'Suscripciones por vencer en los próximos 7 días',
        question: '¿Cuáles cuentas o suscripciones están por vencer esta semana?',
        sql: `SELECT s.id, c.fullname, s.customer_phone, s.streaming_platform, s.account_email, s.expiration_date, s.status\nFROM subscriptions s\nJOIN customers c ON s.customer_phone = c.phone\nWHERE s.expiration_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)\nORDER BY s.expiration_date ASC;`,
        explanation: 'Une la tabla de suscripciones con la tabla de clientes por medio del teléfono de WhatsApp y filtra únicamente las fechas entre hoy (CURDATE()) y los próximos 7 días.',
        concept: 'Uso de CURDATE(), DATE_ADD() y JOIN para cruzar clientes y fechas de vencimiento.',
        tables: ['subscriptions', 'customers']
    },
    {
        keywords: ['top', 'clientes', 'mas', 'cuentas', 'servicios', 'compras'],
        title: 'Top 10 clientes con más suscripciones activas',
        question: '¿Quiénes son los clientes que más servicios tienen contratados?',
        sql: `SELECT c.phone, c.fullname, COUNT(s.id) as total_servicios, GROUP_CONCAT(DISTINCT s.streaming_platform SEPARATOR ', ') as plataformas\nFROM customers c\nJOIN subscriptions s ON c.phone = s.customer_phone\nWHERE s.status = 'active'\nGROUP BY c.phone, c.fullname\nORDER BY total_servicios DESC\nLIMIT 10;`,
        explanation: 'Agrupa todas las suscripciones activas por cliente usando COUNT() y muestra en una sola columna qué plataformas tiene cada uno con GROUP_CONCAT().',
        concept: 'Agrupación (GROUP BY) y conteo (COUNT) para rankings comerciales.',
        tables: ['customers', 'subscriptions']
    },
    {
        keywords: ['cupo', 'capacidad', 'libre', 'disponib', 'ocupad', 'perfil'],
        title: 'Cuentas madre de proveedores y su ocupación de perfiles',
        question: '¿Cuántos perfiles tiene asignados cada cuenta de streaming vs su capacidad?',
        sql: `SELECT sa.streaming_platform, sa.account_email, sa.status, COUNT(s.id) as perfiles_ocupados\nFROM stream_accounts sa\nLEFT JOIN subscriptions s ON sa.account_email = s.account_email AND s.status = 'active'\nGROUP BY sa.streaming_platform, sa.account_email, sa.status\nORDER BY perfiles_ocupados DESC;`,
        explanation: 'Usa LEFT JOIN para ver todas las cuentas proveedor aunque no tengan ningún perfil vendido todavía, calculando cuántos clientes activos hay en cada una.',
        concept: 'LEFT JOIN para evitar omitir cuentas vacías o sin ventas.',
        tables: ['stream_accounts', 'subscriptions']
    },
    {
        keywords: ['asesor', 'tickets', 'resuelt', 'hoy', 'desempeño', 'productiv'],
        title: 'Tickets resueltos hoy por cada asesor de soporte',
        question: '¿Cuántos tickets ha resuelto cada asesor el día de hoy?',
        sql: `SELECT agent as asesor, COUNT(*) as tickets_resueltos, SEC_TO_TIME(ROUND(AVG(durationSeconds))) as tiempo_promedio\nFROM resolved_tickets_log\nWHERE DATE(resolvedAt) = CURDATE()\nGROUP BY agent\nORDER BY tickets_resueltos DESC;`,
        explanation: 'Filtra los registros de soporte de hoy y calcula el total de tickets y el promedio de tiempo que tardó cada asesor en resolverlos.',
        concept: 'Métricas de equipo con AVG() y filtros de fecha en tiempo real.',
        tables: ['resolved_tickets_log']
    },
    {
        keywords: ['mensaje', 'chat', 'whatsapp', 'recient', 'conversac'],
        title: 'Últimos 50 mensajes de WhatsApp registrados',
        question: '¿Cuáles son los últimos mensajes que han llegado al bot?',
        sql: `SELECT m.id, m.chat_id, m.sender_name, m.body, m.is_from_me, m.created_at\nFROM messages m\nORDER BY m.created_at DESC\nLIMIT 50;`,
        explanation: 'Extrae los mensajes ordenados del más nuevo al más antiguo (DESC) con un límite de 50 para inspección rápida.',
        concept: 'Paginación básica y auditoría de mensajes en orden cronológico inverso.',
        tables: ['messages']
    },
    {
        keywords: ['ventas', 'aprob', 'web', 'plataforma', 'ingres'],
        title: 'Ventas web aprobadas agrupadas por plataforma',
        question: '¿Cuánto se ha vendido por la página web desglosado por plataforma?',
        sql: `SELECT platformName as plataforma, COUNT(*) as total_pedidos, SUM(amount) as total_ingresos_cop\nFROM web_sales_approved\nGROUP BY platformName\nORDER BY total_ingresos_cop DESC;`,
        explanation: 'Calcula cuántos pedidos y cuánto dinero en pesos colombianos ha generado cada servicio en la página web usando SUM() y COUNT().',
        concept: 'Cálculo de ingresos agregados con SUM() y clasificación por producto.',
        tables: ['web_sales_approved']
    }
];

/**
 * Responde preguntas en lenguaje natural y genera la consulta SQL comentada
 */
async function askTutor(question) {
    const qClean = (question || '').toLowerCase().trim();
    if (!qClean) {
        return {
            title: '¿En qué te puedo ayudar hoy?',
            sql: `SELECT * FROM customers LIMIT 10;`,
            explanation: 'Selecciona una de las preguntas sugeridas o escribe lo que necesitas en tus propias palabras.',
            concept: 'Exploración inicial',
            tables: ['customers']
        };
    }

    // 1. Intentar matching con la base de conocimiento pedagógica
    for (const item of TUTOR_KNOWLEDGE_QUESTIONS) {
        const matches = item.keywords.some(k => qClean.includes(k));
        if (matches) {
            return {
                title: item.title,
                question: item.question,
                sql: item.sql,
                explanation: item.explanation,
                concept: item.concept,
                tables: item.tables,
                tips: [
                    'Puedes modificar cualquier valor (ej. cambiar 7 días a 15 días o cambiar el LIMIT).',
                    'Haz clic en "Probar Consulta" para ver los datos reales al instante.'
                ]
            };
        }
    }

    // 2. Si no hubo match directo, generar dinámicamente con Antigravity CLI si está disponible
    try {
        const { callAgyCli } = require('./cliAgentService');
        const prompt = `Eres el Tutor SQL de Sheerit Data Studio.
El usuario pregunta en español: "${question}".
El esquema de la base de datos MariaDB cuenta con las tablas:
- customers (phone, fullname, saldo, created_at)
- subscriptions (id, customer_phone, streaming_platform, account_email, expiration_date, status)
- stream_accounts (streaming_platform, account_email, status, max_profiles)
- platforms (name, price, is_active)
- chats (chat_id, customer_phone, status, last_message_text)
- messages (id, chat_id, sender_name, body, is_from_me, created_at)
- tickets (chat_id, title, description, status, priority)
- resolved_tickets_log (phone, customerName, agent, category, durationSeconds, resolvedAt)
- web_sales_approved (orderId, whatsapp, amount, platformName, createdAt)

Responde EXCLUSIVAMENTE con un JSON estrictamente estructurado así:
{
  "title": "Título corto y claro de la consulta",
  "sql": "Consulta SQL formateada y segura (solo SELECT)",
  "explanation": "Explicación en español amigable de cómo funciona paso a paso",
  "concept": "Concepto de SQL clave que el usuario aprende aquí",
  "tables": ["tabla1", "tabla2"]
}`;

        const raw = await callAgyCli(prompt, "Eres el Tutor SQL. Responde únicamente el JSON.");
        if (raw) {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.sql) {
                    return parsed;
                }
            }
        }
    } catch (e) {
        console.warn('[DataStudio Tutor] Fallback a respuesta estándar:', e.message);
    }

    // Fallback general educativo si no hubo match ni CLI
    return {
        title: 'Búsqueda general de datos',
        question,
        sql: `SELECT c.phone, c.fullname, s.streaming_platform, s.expiration_date, s.status\nFROM customers c\nLEFT JOIN subscriptions s ON c.phone = s.customer_phone\nWHERE c.fullname LIKE '%${qClean.replace(/[^a-zA-Z0-9]/g, '')}%' OR s.streaming_platform LIKE '%${qClean.replace(/[^a-zA-Z0-9]/g, '')}%'\nLIMIT 50;`,
        explanation: 'Esta consulta busca el término que mencionaste en los nombres de clientes y en las plataformas de suscripción usando el operador LIKE con comodines (%).',
        concept: 'Búsqueda de texto parcial con LIKE y comodines (%).',
        tables: ['customers', 'subscriptions'],
        tips: ['El símbolo % antes y después del texto permite encontrar coincidencias en cualquier posición de la palabra.']
    };
}

/**
 * Lecciones del Mini-Curso Interactivo de SQL
 */
function getSqlTutorials() {
    return [
        {
            id: 'leccion-1',
            level: 'Básico',
            title: '1. ¿Qué es SELECT y cómo pedir datos?',
            icon: 'FileCode',
            summary: 'Aprende a consultar columnas específicas y a explorar tablas sin miedo.',
            analogy: 'Piensa en una tabla como una hoja de cálculo de Excel. SELECT es elegir qué columnas quieres ver, y FROM es elegir en qué hoja mirar.',
            sql: `SELECT phone, fullname FROM customers LIMIT 10;`,
            keyTakeaways: [
                'SELECT especifica las columnas que deseas mostrar.',
                'FROM indica la tabla donde viven los datos.',
                'LIMIT 10 te trae solo las primeras 10 filas para que sea ultra rápido.'
            ]
        },
        {
            id: 'leccion-2',
            level: 'Básico',
            title: '2. WHERE: El colador de información',
            icon: 'Filter',
            summary: 'Cómo traer exactamente los registros que necesitas mediante filtros y condiciones.',
            analogy: 'Es como aplicar un filtro en Excel por columna: solo ves las filas que cumplen tu condición.',
            sql: `SELECT streaming_platform, account_email, expiration_date\nFROM subscriptions\nWHERE status = 'active' AND expiration_date > CURDATE()\nLIMIT 20;`,
            keyTakeaways: [
                'WHERE evalúa cada fila: si la condición es verdadera, la muestra.',
                'Puedes combinar varias condiciones usando AND (ambas deben cumplirse) u OR (cualquiera de las dos).',
                'CURDATE() es una función especial que te da la fecha de hoy automáticamente.'
            ]
        },
        {
            id: 'leccion-3',
            level: 'Intermedio',
            title: '3. El Superpoder de los JOINs (Cruzar Tablas)',
            icon: 'Link2',
            summary: 'Cómo conectar clientes con sus cuentas sin duplicar datos en una sola tabla.',
            analogy: 'Es exactamente como un BUSCARV (VLOOKUP) de Excel. Tienes la tabla de clientes con sus teléfonos y la tabla de suscripciones con el mismo teléfono. El JOIN las une en una sola vista.',
            sql: `SELECT c.fullname, c.phone, s.streaming_platform, s.account_email\nFROM customers c\nJOIN subscriptions s ON c.phone = s.customer_phone\nLIMIT 25;`,
            keyTakeaways: [
                'JOIN conecta dos tablas mediante una columna común (ej: c.phone = s.customer_phone).',
                'Usamos alias cortos (c para customers, s para subscriptions) para no escribir el nombre largo todo el tiempo.',
                'INNER JOIN solo muestra clientes que tengan al menos una suscripción.'
            ]
        },
        {
            id: 'leccion-4',
            level: 'Intermedio',
            title: '4. Totales, Conteos y GROUP BY',
            icon: 'Layers',
            summary: 'Cómo transformar miles de filas en resúmenes ejecutivos con números claros.',
            analogy: 'Es como crear una Tabla Dinámica en Excel: pones la columna que quieres clasificar y pides la suma o el conteo.',
            sql: `SELECT streaming_platform, COUNT(*) as total_cuentas, MIN(expiration_date) as proximo_vencimiento\nFROM subscriptions\nGROUP BY streaming_platform\nORDER BY total_cuentas DESC;`,
            keyTakeaways: [
                'COUNT(*) cuenta cuántas filas hay en cada grupo.',
                'GROUP BY indica por qué columna se van a juntar los datos.',
                'ORDER BY DESC pone los números más grandes primero.'
            ]
        },
        {
            id: 'leccion-5',
            level: 'Avanzado',
            title: '5. LEFT JOIN vs INNER JOIN',
            icon: 'Split',
            summary: 'Aprende la diferencia crucial para no perder datos invisibles.',
            analogy: 'Si tienes 100 clientes y solo 60 tienen compras, un INNER JOIN solo te muestra 60. Un LEFT JOIN te muestra los 100, rellenando con NULL los que no han comprado.',
            sql: `SELECT c.fullname, c.phone, s.id as id_suscripcion\nFROM customers c\nLEFT JOIN subscriptions s ON c.phone = s.customer_phone\nWHERE s.id IS NULL\nLIMIT 20;`,
            keyTakeaways: [
                'LEFT JOIN mantiene todas las filas de la tabla izquierda aunque no tengan pareja.',
                'Filtrar con WHERE s.id IS NULL te da los clientes que NO tienen servicios (clientes inactivos o potenciales).'
            ]
        },
        {
            id: 'leccion-6',
            level: 'Seguridad',
            title: '6. Modificar Datos con Seguridad (UPDATE y DELETE)',
            icon: 'ShieldCheck',
            summary: 'La regla número 1 que todo administrador de base de datos debe memorizar.',
            analogy: 'Imagina que vas a pintar una pared de una casa. Si no dices cuál pared (WHERE), el pintor te pintará toda la casa.',
            sql: `SELECT * FROM subscriptions WHERE id = 1234; -- Primero verificas con SELECT antes de modificar`,
            keyTakeaways: [
                'Paso 1: Siempre ejecuta primero un SELECT con el mismo WHERE para ver qué filas vas a afectar.',
                'Paso 2: Activa la casilla de seguridad antes de ejecutar UPDATE o DELETE.',
                'Paso 3: Verifica el número de filas afectadas reportado por la consola.'
            ]
        }
    ];
}

module.exports = {
    getTablesOverview,
    executeStudioQuery,
    getSchemaGraph,
    previewDataImport,
    executeDataImport,
    explainSqlQuery,
    askTutor,
    getSqlTutorials
};

