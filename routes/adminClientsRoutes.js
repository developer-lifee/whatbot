const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../database');
const { getAccountsByPhone } = require('../apiService');
const { recordNewSale } = require('../salesRegistryService');

const ROOT_DIR = path.resolve(__dirname, '..');

function registerAdminClientsRoutes(app, ctx) {
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { fetchCustomersData, getJsDateFromExcel, fetchHistoricoData } = require('../apiService');
        const { pool } = require('../database');
        const { timeframe } = req.query; // 'last_30_days', 'last_6_months', 'this_month', 'all_time'

        const clients = await fetchCustomersData();
        const now = new Date();
        now.setHours(0, 0, 0, 0);

        const stats = {
            totalClients: clients.length,
            byPlatform: {},
            byStatus: { active: 0, expired: 0, warning: 0 },
            expirations: { next7Days: 0, next15Days: 0, next30Days: 0 },
            revenueEstimate: 0,
            historyTrend: [],
            newsCount: 0,
            renewalsCount: 0,
            churnedCount: 0,
            financials: { totalIncome: 0, totalExpense: 0, netProfit: 0, trend: [] },
            loyalty: { topPurchasers: [], topRenewals: [], topSpenders: [] }
        };

        let historico = {};
        try {
            historico = await fetchHistoricoData();
        } catch (hErr) {
            console.error("[Stats API] Failed to fetch historico for calculations:", hErr.message);
        }

        const activePhones = new Set(clients.map(c => {
            const num = (c.numero || c.Numero || "").toString().replace(/\D/g, "");
            return num.slice(-10);
        }).filter(Boolean));

        clients.forEach(c => {
            const plat = (c.Streaming || 'Otros').split(' ')[0] || 'Otros';
            stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;

            const dateVal = c.deben || c.vencimiento;
            if (dateVal) {
                const venc = getJsDateFromExcel(dateVal);
                if (venc && !isNaN(venc.getTime())) {
                    venc.setHours(0, 0, 0, 0);
                    const diffTime = venc.getTime() - now.getTime();
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    if (diffDays < 0) {
                        stats.byStatus.expired++;
                    } else if (diffDays <= 5) {
                        stats.byStatus.warning++;
                        stats.byStatus.active++;
                    } else {
                        stats.byStatus.active++;
                    }

                    if (diffDays >= 0 && diffDays <= 7) stats.expirations.next7Days++;
                    if (diffDays >= 0 && diffDays <= 15) stats.expirations.next15Days++;
                    if (diffDays >= 0 && diffDays <= 30) stats.expirations.next30Days++;
                }
            }

            // Calculate New vs Renewal
            const cleanPhone = (c.numero || c.Numero || "").toString().replace(/\D/g, "");
            const targetTail = cleanPhone.slice(-10);
            const histKey = Object.keys(historico).find(k => k.endsWith(targetTail));
            const histRecord = histKey ? historico[histKey] : null;

            if (histRecord && histRecord.historial && histRecord.historial.length > 0) {
                const currentPlat = (c.Streaming || "").toLowerCase().trim();
                const hasPriorPurchase = histRecord.historial.some(h => {
                    const prevPlat = (h.streaming || "").toLowerCase().trim();
                    return prevPlat.includes(currentPlat) || currentPlat.includes(prevPlat);
                });
                if (hasPriorPurchase) {
                    stats.renewalsCount++;
                } else {
                    stats.newsCount++;
                }
            } else {
                stats.newsCount++;
            }
        });

        // Calculate Churn (Desistidos) - Active in the last 45 days of history but not in current list
        const fortyFiveDaysAgo = new Date();
        fortyFiveDaysAgo.setDate(now.getDate() - 45);

        for (const phone in historico) {
            const tail = phone.slice(-10);
            if (!activePhones.has(tail)) {
                const clientObj = historico[phone];
                if (clientObj && Array.isArray(clientObj.historial) && clientObj.historial.length > 0) {
                    let latestDate = null;
                    clientObj.historial.forEach(h => {
                        const d = getJsDateFromExcel(h.vencimiento || h.fecha_corte);
                        if (d && !isNaN(d.getTime())) {
                            if (!latestDate || d > latestDate) {
                                latestDate = d;
                            }
                        }
                    });

                    if (latestDate && latestDate >= fortyFiveDaysAgo && latestDate <= now) {
                        stats.churnedCount++;
                    }
                }
            }
        }

        // Cargar tendencia histórica de ventas
        try {
            const monthCounts = {};

            for (const phone in historico) {
                const clientObj = historico[phone];
                if (clientObj && Array.isArray(clientObj.historial)) {
                    clientObj.historial.forEach(h => {
                        const dateVal = h.deben || h.vencimiento || h.fecha_corte;
                        if (dateVal) {
                            const date = getJsDateFromExcel(dateVal);
                            if (date && !isNaN(date.getTime())) {
                                const monthName = date.toLocaleDateString('es-ES', { month: 'short' });
                                const year = date.getFullYear();
                                const key = `${monthName} ${year}`;
                                monthCounts[key] = (monthCounts[key] || 0) + 1;
                            }
                        }
                    });
                }
            }

            const trend = Object.entries(monthCounts).map(([name, ventas]) => {
                const parts = name.split(' ');
                const months = {
                    ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
                    jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
                };
                const m = months[parts[0].toLowerCase().substring(0, 3)] || 0;
                const y = parseInt(parts[1]) || 2026;
                const sortKey = y * 12 + m;
                return { name, ventas, sortKey };
            })
                .sort((a, b) => a.sortKey - b.sortKey)
                .slice(-8)
                .map(({ name, ventas }) => ({ name, ventas }));

            stats.historyTrend = trend;
        } catch (histErr) {
            console.error("[Stats API] Error computing history trend:", histErr.message);
        }

        // ---- NUEVOS CÁLCULOS FINANCIEROS Y FIDELIZACIÓN ----
        let dateFilterCashFlow = "";
        let dateFilterExcel = "";

        if (timeframe === 'last_30_days') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
            dateFilterExcel = "WHERE vencimiento >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        } else if (timeframe === 'last_6_months') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)";
            dateFilterExcel = "WHERE vencimiento >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)";
        } else if (timeframe === 'this_month') {
            dateFilterCashFlow = "WHERE entry_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
            dateFilterExcel = "WHERE vencimiento >= DATE_FORMAT(CURDATE(), '%Y-%m-01')";
        }

        // Finanzas
        try {
            const [flowSummary] = await pool.query(`
                SELECT 
                    SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
                    SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense
                FROM cash_flow_entries
                ${dateFilterCashFlow}
            `);
            if (flowSummary.length > 0) {
                stats.financials.totalIncome = Math.round(flowSummary[0].total_income || 0);
                stats.financials.totalExpense = Math.round(flowSummary[0].total_expense || 0);
                stats.financials.netProfit = stats.financials.totalIncome - stats.financials.totalExpense;
            }

            const [flowTrend] = await pool.query(`
                SELECT 
                    DATE_FORMAT(entry_date, '%b %Y') as month_year,
                    SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
                    SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
                    YEAR(entry_date) as y, MONTH(entry_date) as m
                FROM cash_flow_entries
                ${dateFilterCashFlow}
                GROUP BY month_year, y, m
                ORDER BY y ASC, m ASC
                LIMIT 12
            `);
            stats.financials.trend = flowTrend.map(f => ({
                name: f.month_year,
                ingresos: Math.round(f.income || 0),
                egresos: Math.round(f.expense || 0),
                ganancias: Math.round((f.income || 0) - (f.expense || 0))
            }));
        } catch (fErr) {
            console.error("[Stats API] Error calculating financials:", fErr.message);
        }

        // Fidelización / Mejores Clientes
        const getCustomerNameMap = async () => {
            const [rows] = await pool.query('SELECT phone, fullname FROM customers');
            const map = {};
            rows.forEach(r => { map[r.phone] = r.fullname; });
            return map;
        };

        try {
            const nameMap = await getCustomerNameMap();

            // 1. Clientes con más plataformas
            const [purchRows] = await pool.query(`
                SELECT customer_phone, COUNT(DISTINCT streaming_platform) as count 
                FROM excel_historical_records 
                ${dateFilterExcel}
                GROUP BY customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topPurchasers = await Promise.all(purchRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: r.count };
            }));

            // 2. Clientes con más renovaciones
            const [renewRows] = await pool.query(`
                SELECT customer_phone, COUNT(*) as count 
                FROM excel_historical_records 
                ${dateFilterExcel}
                GROUP BY customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topRenewals = await Promise.all(renewRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: r.count };
            }));

            // 3. Clientes con mayor inversión
            // Se usa el precio real de la plataforma (o amount_paid si es un valor de precio real <= 35000)
            // Se previene la corrupción por fechas de Excel en la columna 'deben' (ej: 29042026 o seriales 46202)
            const [spentRows] = await pool.query(`
                SELECT 
                    h.customer_phone, 
                    SUM(
                        CASE 
                            WHEN h.amount_paid > 0 AND h.amount_paid <= 35000 THEN h.amount_paid
                            WHEN sp.normal_price IS NOT NULL THEN sp.normal_price
                            ELSE 13000
                        END
                    ) as count 
                FROM excel_historical_records h
                LEFT JOIN streaming_prices sp ON UPPER(TRIM(h.streaming_platform)) = UPPER(TRIM(sp.platform))
                ${dateFilterExcel ? dateFilterExcel.replace(/customer_phone/g, 'h.customer_phone') : ''}
                GROUP BY h.customer_phone 
                ORDER BY count DESC 
                LIMIT 5
            `);
            stats.loyalty.topSpenders = await Promise.all(spentRows.map(async r => {
                let name = nameMap[r.customer_phone];
                if (!name) {
                    const [profRows] = await pool.query('SELECT profile_name FROM excel_historical_records WHERE customer_phone = ? AND profile_name IS NOT NULL LIMIT 1', [r.customer_phone]);
                    name = profRows.length > 0 ? profRows[0].profile_name : `Cliente (${r.customer_phone.slice(-4)})`;
                }
                return { phone: r.customer_phone, name, count: Math.round(r.count || 0) };
            }));
        } catch (lErr) {
            console.error("[Stats API] Error calculating loyalty stats:", lErr.message);
        }

        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint: Dinámica de perfiles libres y ocupados por plataforma y cuenta maestra
app.get('/api/admin/analytics/free-profiles', async (req, res) => {
    try {
        const { fetchCustomersData } = require('../apiService');
        const rows = await fetchCustomersData(1, 500, false);

        const isLibre = (r) => {
            const whatsapp = (r.whatsapp || r.numero || "").toString().trim();
            const nombre = (r.Nombre || "").toString().trim().toLowerCase();
            return (!whatsapp || whatsapp === "" || whatsapp === "0") && (!nombre || nombre === "" || nombre === "libre" || nombre === "disponible" || nombre === "vacio");
        };

        let totalCupos = 0;
        let totalOcupados = 0;
        let totalLibres = 0;

        const platformsMap = {};

        rows.forEach((r, idx) => {
            const streaming = (r.Streaming || "OTRO").toString().toUpperCase().trim();
            const rawCorreo = (r.correo || "").toString().trim();
            const correo = rawCorreo || "Sin correo asignado";
            const libre = isLibre(r);

            totalCupos++;
            if (libre) totalLibres++;
            else totalOcupados++;

            if (!platformsMap[streaming]) {
                platformsMap[streaming] = {
                    platform: streaming,
                    totalCupos: 0,
                    ocupados: 0,
                    libres: 0,
                    cuentasMap: {}
                };
            }
            platformsMap[streaming].totalCupos++;
            if (libre) platformsMap[streaming].libres++;
            else platformsMap[streaming].ocupados++;

            const accKey = `${streaming}__${correo.toLowerCase()}`;
            if (!platformsMap[streaming].cuentasMap[accKey]) {
                platformsMap[streaming].cuentasMap[accKey] = {
                    id: accKey,
                    platform: streaming,
                    email: rawCorreo || "Sin correo",
                    vencimiento: r.vencimiento || "",
                    total: 0,
                    ocupados: 0,
                    libres: 0,
                    profiles: []
                };
            }
            platformsMap[streaming].cuentasMap[accKey].total++;
            if (libre) platformsMap[streaming].cuentasMap[accKey].libres++;
            else platformsMap[streaming].cuentasMap[accKey].ocupados++;

            platformsMap[streaming].cuentasMap[accKey].profiles.push({
                rowNumber: r._rowNumber || idx + 2,
                nombre: r.Nombre || "",
                apellido: r.apellido || "",
                whatsapp: r.whatsapp || r.numero || "",
                pin: r["Pin perfil"] || "",
                vencimiento: r.deben || r.vencimiento || "",
                isLibre: libre
            });
        });

        const platformsList = Object.values(platformsMap).map(p => {
            const accounts = Object.values(p.cuentasMap).map(acc => ({
                ...acc,
                occupancyRate: Math.round((acc.ocupados / (acc.total || 1)) * 100)
            })).sort((a, b) => b.libres - a.libres);

            return {
                platform: p.platform,
                totalCupos: p.totalCupos,
                ocupados: p.ocupados,
                libres: p.libres,
                totalAccounts: accounts.length,
                accountsWithFreeCount: accounts.filter(a => a.libres > 0).length,
                occupancyRate: Math.round((p.ocupados / (p.totalCupos || 1)) * 100),
                accounts
            };
        }).sort((a, b) => b.libres - a.libres);

        const allAccounts = [];
        platformsList.forEach(p => {
            p.accounts.forEach(acc => {
                allAccounts.push(acc);
            });
        });

        const exhaustedPlatforms = platformsList.filter(p => p.libres === 0).map(p => p.platform);
        const criticalPlatforms = platformsList.filter(p => p.libres > 0 && p.libres <= 2).map(p => p.platform);

        res.json({
            summary: {
                totalCupos,
                totalOcupados,
                totalLibres,
                occupancyRate: Math.round((totalOcupados / (totalCupos || 1)) * 100),
                totalAccounts: allAccounts.length,
                accountsWithFree: allAccounts.filter(a => a.libres > 0).length,
                exhaustedPlatforms,
                criticalPlatforms
            },
            platforms: platformsList,
            accounts: allAccounts.sort((a, b) => b.libres - a.libres)
        });
    } catch (e) {
        console.error("[Free Profiles API] Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to retrieve specific client profile by phone number (including subscriptions, payments, and notes)
app.get('/api/admin/client-history', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Falta el número de teléfono' });

        const { resolveRealPhoneFromJid } = require('../billingService');
        const resolvedPhone = await resolveRealPhoneFromJid(phone.toString());
        const targetPhone = resolvedPhone || phone.toString();

        const { pool } = require('../database');
        const cleanPhone = targetPhone.replace(/\D/g, '');
        const targetTail = cleanPhone.slice(-10);

        if (cleanPhone.length < 7) {
            return res.json({ fullname: "", phone: cleanPhone, email: "", notes: "", subscriptions: [], purchases: [] });
        }

        // 1. Get customer info & notes
        const [custRows] = await pool.query(
            "SELECT * FROM customers WHERE phone LIKE ? OR phone = ?",
            [`%${targetTail}`, cleanPhone]
        );
        let customer = custRows[0] || { phone: cleanPhone, fullname: '', email: '', notes: '' };

        // 2. Get active/expired subscriptions from subscriptions table
        const [subRows] = await pool.query(
            "SELECT streaming_platform, account_email, account_password, profile_pin, expiration_date, status, payment_method, notes FROM subscriptions WHERE customer_phone LIKE ? OR customer_phone = ? ORDER BY expiration_date DESC",
            [`%${targetTail}`, cleanPhone]
        );

        // 3. Get approved purchases from web_sales_approved table
        const [saleRows] = await pool.query(
            "SELECT platformName, amount, createdAt, approvedAt, order_id FROM web_sales_approved WHERE whatsapp LIKE ? OR whatsapp = ? ORDER BY approvedAt DESC",
            [`%${targetTail}`, cleanPhone]
        );

        const forceSync = req.query.force === 'true';

        // Check if there are already records in the DB for this client
        const [existingDbRows] = await pool.query(
            "SELECT 1 FROM excel_historical_records WHERE customer_phone LIKE ? OR customer_phone = ? LIMIT 1",
            [`%${targetTail}`, cleanPhone]
        );

        if (forceSync || existingDbRows.length === 0) {
            // Sync matching records from Excel to DB on-demand
            try {
                const { fetchHistoricoData } = require('../apiService');
                const historicoData = await fetchHistoricoData();

                let matchedPhoneInExcel = null;
                let excelRowsToSync = [];
                let excelProfileName = "";

                for (const [keyPhone, obj] of Object.entries(historicoData)) {
                    const cleanKeyPhone = keyPhone.replace(/\D/g, '');
                    if (cleanKeyPhone.endsWith(targetTail) || targetTail.endsWith(cleanKeyPhone.slice(-10))) {
                        matchedPhoneInExcel = cleanKeyPhone;
                        excelRowsToSync = obj.historial || [];
                        excelProfileName = `${obj.nombre || ''} ${obj.apellido || ''}`.trim();
                        break;
                    }
                }

                if (excelRowsToSync.length > 0 && matchedPhoneInExcel) {
                    for (const hist of excelRowsToSync) {
                        const streaming = (hist.streaming || "").toString().trim();
                        const emailAcct = (hist.correo || "").toString().toLowerCase().trim();
                        const cutDate = (hist.fecha_corte || "").toString().trim();

                        if (!streaming || !emailAcct || !cutDate) continue;

                        // Determinar amount_paid según el precio real de la plataforma en streaming_prices
                        // En Excel la columna 'deben' contiene la fecha de vencimiento, NO un precio en pesos
                        let amountPaid = 13000;
                        try {
                            const [priceRows] = await pool.query(
                                'SELECT normal_price FROM streaming_prices WHERE UPPER(TRIM(platform)) = UPPER(TRIM(?)) LIMIT 1',
                                [streaming]
                            );
                            if (priceRows.length > 0 && priceRows[0].normal_price) {
                                amountPaid = Math.round(Number(priceRows[0].normal_price));
                            }
                        } catch (_) {}

                        // Format vencimiento
                        let vencimientoDate = null;
                        if (hist.vencimiento) {
                            const { getJsDateFromExcel } = require('../apiService');
                            const jsDate = getJsDateFromExcel(hist.vencimiento);
                            if (jsDate) {
                                vencimientoDate = jsDate.toISOString().slice(0, 10);
                            }
                        }

                        await pool.query(
                            `INSERT INTO excel_historical_records 
                                (customer_phone, streaming_platform, account_email, profile_name, profile_pin, fecha_corte, vencimiento, payment_method, amount_paid)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE 
                                profile_name = VALUES(profile_name),
                                profile_pin = VALUES(profile_pin),
                                vencimiento = VALUES(vencimiento),
                                payment_method = VALUES(payment_method),
                                amount_paid = VALUES(amount_paid)`,
                            [
                                matchedPhoneInExcel,
                                streaming,
                                emailAcct,
                                excelProfileName || null,
                                hist.pin_perfil || null,
                                cutDate,
                                vencimientoDate,
                                hist.metodo_pago || null,
                                amountPaid
                            ]
                        );
                    }
                }
            } catch (histErr) {
                console.error("[client-history] Error syncing excel historico to DB on-demand:", histErr.message);
            }
        }

        // Query the excel_historical_records table to return it
        let excelHistory = [];
        try {
            const [dbHistRows] = await pool.query(
                "SELECT streaming_platform AS streaming, account_email AS correo, profile_pin, fecha_corte, vencimiento, payment_method, amount_paid AS deben FROM excel_historical_records WHERE customer_phone LIKE ? OR customer_phone = ? ORDER BY id DESC",
                [`%${targetTail}`, cleanPhone]
            );
            excelHistory = dbHistRows;
        } catch (dbHistErr) {
            console.error("[client-history] Error querying excel_historical_records from DB:", dbHistErr.message);
        }

        let validatedPayments = [];
        try {
            const { getClientValidatedPayments } = require('../paymentLogService');
            validatedPayments = await getClientValidatedPayments(targetTail);
        } catch (vpErr) {
            console.warn("[client-history] Error querying validated_payments_log:", vpErr.message);
        }

        let customBillingRules = [];
        try {
            const { getCustomBillingRulesByPhone } = require('../customBillingService');
            customBillingRules = await getCustomBillingRulesByPhone(targetTail);
        } catch (cbErr) {
            console.warn("[client-history] Error querying custom_billing_rules:", cbErr.message);
        }

        let overdueDebts = [];
        try {
            const { getPendingOverdueDebts } = require('../overdueDebtService');
            overdueDebts = await getPendingOverdueDebts(targetTail);
        } catch (odErr) {
            console.warn("[client-history] Error querying client_overdue_debts:", odErr.message);
        }

        res.json({
            fullname: customer.fullname || '',
            phone: customer.phone || cleanPhone,
            email: customer.email || '',
            notes: customer.notes || '',
            subscriptions: subRows,
            purchases: saleRows,
            excelHistory: excelHistory,
            validatedPayments: validatedPayments,
            customBillingRules: customBillingRules,
            overdueDebts: overdueDebts
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET Custom Billing Rules
app.get('/api/admin/custom-billing', async (req, res) => {
    try {
        const { phone } = req.query;
        const { getAllCustomBillingRules, getCustomBillingRulesByPhone } = require('../customBillingService');
        const rules = phone ? await getCustomBillingRulesByPhone(phone) : await getAllCustomBillingRules();
        res.json({ success: true, rules });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST Save Custom Billing Rule
app.post('/api/admin/custom-billing/save', express.json(), async (req, res) => {
    try {
        const { saveCustomBillingRule } = require('../customBillingService');
        const rules = await saveCustomBillingRule(req.body || {});
        res.json({ success: true, rules });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// POST Delete Custom Billing Rule
app.post('/api/admin/custom-billing/delete', express.json(), async (req, res) => {
    try {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: 'Falta ID de acuerdo.' });
        const { deleteCustomBillingRule } = require('../customBillingService');
        await deleteCustomBillingRule(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST Delete / Forgive Pending Overdue Debt
app.post('/api/admin/overdue-debt/delete', express.json(), async (req, res) => {
    try {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: 'Falta ID de saldo pendiente.' });
        const { deleteOverdueDebt } = require('../overdueDebtService');
        await deleteOverdueDebt(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET Validated Payments & Renewals Log (Auto-OCR, Llave Bre-V, Gmail Match, Admin, Bold)
app.get('/api/admin/payments/validated', async (req, res) => {
    try {
        const { type = 'all', source = 'all', search = '', limit = '200' } = req.query;
        const { getValidatedPayments } = require('../paymentLogService');
        const data = await getValidatedPayments({ type, source, search, limit });
        res.json({ success: true, ...data });
    } catch (e) {
        console.error('❌ Error en /api/admin/payments/validated:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint to retrieve specific account history by email
app.get('/api/admin/account-history', async (req, res) => {
    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }
    try {
        const [rows] = await pool.query(
            `SELECT h.fecha_corte, h.vencimiento, h.payment_method, h.amount_paid AS deben, h.profile_name, h.profile_pin, h.customer_phone, c.fullname AS customer_name
             FROM excel_historical_records h
             LEFT JOIN customers c ON h.customer_phone = c.phone
             WHERE h.account_email = ?
             ORDER BY h.id DESC`,
            [email.toString().trim().toLowerCase()]
        );
        res.json(rows);
    } catch (e) {
        console.error("Error retrieving account history:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Endpoint to save/update customer notes (conocimientos)
app.post('/api/admin/client-history/save-notes', express.json(), async (req, res) => {
    try {
        const { phone, notes, fullname, email } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta el teléfono' });

        const { resolveRealPhoneFromJid } = require('../billingService');
        const resolvedPhone = await resolveRealPhoneFromJid(phone.toString());
        const targetPhone = resolvedPhone || phone.toString();

        const { pool } = require('../database');
        const cleanPhone = targetPhone.replace(/\D/g, '');

        await pool.query(`
            INSERT INTO customers (phone, fullname, email, notes)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                notes = VALUES(notes),
                fullname = VALUES(fullname),
                email = VALUES(email)
        `, [cleanPhone, fullname || '', email || '', notes || '']);

        res.json({ success: true, message: 'Conocimientos del cliente actualizados.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint para editar la fecha de vencimiento (deben) de un cliente a gusto del administrador
app.post('/api/admin/client/update-expiration', express.json(), async (req, res) => {
    try {
        const { rowNumber, phone, streaming, newDate, password } = req.body;
        if (password !== 'admin123') {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        if (!newDate) {
            return res.status(400).json({ success: false, message: 'Fecha de vencimiento requerida' });
        }

        const { updateExcelData, fetchRawData } = require('../apiService');
        let targetRow = parseInt(rowNumber);

        if (!targetRow || isNaN(targetRow)) {
            const allRows = await fetchRawData();
            const cleanPhone = (phone || '').toString().replace(/\D/g, '');
            const target = allRows.find(r => {
                const rPhone = (r.numero || r.Numero || r.whatsapp || '').toString().replace(/\D/g, '');
                const rStreaming = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                const matchPhone = cleanPhone && rPhone.includes(cleanPhone.slice(-10));
                const matchStreaming = !streaming || rStreaming.includes(streaming.toLowerCase());
                return matchPhone && matchStreaming;
            });
            if (target) {
                targetRow = target._rowNumber || (allRows.indexOf(target) + 2);
            }
        }

        if (!targetRow || isNaN(targetRow)) {
            return res.status(404).json({ success: false, message: 'No se encontró la fila del cliente en Excel' });
        }

        const formattedDate = newDate.toString().trim();
        const updates = { "deben": formattedDate, "observaciones": `Vencimiento editado manualmente (${formattedDate})` };

        console.log(`[Admin API] Editando vencimiento en fila ${targetRow} -> ${formattedDate}`);
        const result = await updateExcelData(targetRow, updates);

        res.json({
            success: true,
            message: `Vencimiento actualizado a ${formattedDate} exitosamente.`,
            rowNumber: targetRow,
            newDate: formattedDate,
            result
        });
    } catch (e) {
        console.error("[Admin API] Error actualizando vencimiento:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint para unificar la fecha de vencimiento (deben) de TODAS las cuentas activas de un cliente
// y calcular prorrateo exacto (saldo a favor/descuento o saldo en contra/a cobrar)
app.post('/api/admin/client/unify-expiration', express.json(), async (req, res) => {
    try {
        const { phone, targetDate, previewOnly = false, saveFixedDay = false, clientName = '', password } = req.body || {};
        if (password !== 'admin123') {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        const cleanPhone = String(phone || '').replace(/\D/g, '');
        const phoneTail = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
        if (!phoneTail || phoneTail.length < 7) {
            return res.status(400).json({ success: false, message: 'Teléfono del cliente inválido.' });
        }
        const cleanTargetDate = String(targetDate || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanTargetDate)) {
            return res.status(400).json({ success: false, message: 'Debes indicar una fecha objetivo válida (YYYY-MM-DD).' });
        }

        const [ty, tm, td] = cleanTargetDate.split('-').map(Number);
        const targetDateObj = new Date(ty, tm - 1, td);
        targetDateObj.setHours(0, 0, 0, 0);

        const { fetchRawData, updateExcelData, getJsDateFromExcel, getPlatformKnowledge } = require('../apiService');
        const { getPlatformPriceFromExcel } = require('../billingService');
        const { getCustomBillingRulesByPhone, findMatchingCustomRule, saveCustomBillingRule } = require('../customBillingService');

        const [allRows, platforms, customRules] = await Promise.all([
            fetchRawData(false),
            getPlatformKnowledge().catch(() => []),
            getCustomBillingRulesByPhone(phoneTail).catch(() => [])
        ]);

        const clientRows = [];
        for (let idx = 0; idx < (allRows || []).length; idx++) {
            const r = allRows[idx];
            if (!r) continue;
            const rPhone = String(r.numero || r.Numero || '').replace(/\D/g, '');
            if (!rPhone || !rPhone.includes(phoneTail)) continue;
            const rName = String(r.Nombre || r.nombre || r.whatsapp || '').trim();
            if (!rName || ['libre', 'disponible', 'vacio', 'vacío'].includes(rName.toLowerCase())) continue;
            clientRows.push({
                rowNumber: r._rowNumber || r.rowNumber || (idx + 2),
                row: r
            });
        }

        if (clientRows.length === 0) {
            return res.status(404).json({ success: false, message: 'No se encontraron servicios activos para este cliente en Excel.' });
        }

        const breakdown = [];
        let totalNetAdjustment = 0; // > 0 = cliente debe pagar extra (días adicionales); < 0 = saldo a favor/descuento del cliente
        let totalExtraCharge = 0;
        let totalCreditDiscount = 0;

        for (const item of clientRows) {
            const r = item.row;
            const streamingName = String(r.Streaming || r.Plataforma || 'SERVICIO').trim();
            const rawCurrentDate = r.deben || r.Columna4 || r.vencimiento || '';
            const currentDateObj = getJsDateFromExcel(rawCurrentDate);

            let currentDateISO = null;
            let diffDays = 0;
            if (currentDateObj && !isNaN(currentDateObj.getTime())) {
                const cLocal = new Date(currentDateObj.getFullYear(), currentDateObj.getMonth(), currentDateObj.getDate());
                cLocal.setHours(0, 0, 0, 0);
                currentDateISO = `${cLocal.getFullYear()}-${String(cLocal.getMonth() + 1).padStart(2, '0')}-${String(cLocal.getDate()).padStart(2, '0')}`;
                diffDays = Math.round((targetDateObj.getTime() - cLocal.getTime()) / (1000 * 60 * 60 * 24));
            }

            // Resolver precio mensual real (acuerdo personalizado primero, luego catálogo)
            const matchedRule = findMatchingCustomRule(customRules, streamingName);
            let monthlyPrice = getPlatformPriceFromExcel(r, platforms, '');
            if (matchedRule && matchedRule.mode === 'custom_price' && Number(matchedRule.custom_amount) > 0) {
                monthlyPrice = Number(matchedRule.custom_amount);
            }

            const dailyRate = monthlyPrice > 0 ? (monthlyPrice / 30) : 0;
            const adjustmentAmount = Math.round(dailyRate * diffDays); // + = a cobrar, - = saldo a favor (descuento)

            totalNetAdjustment += adjustmentAmount;
            if (adjustmentAmount > 0) totalExtraCharge += adjustmentAmount;
            if (adjustmentAmount < 0) totalCreditDiscount += Math.abs(adjustmentAmount);

            breakdown.push({
                rowNumber: item.rowNumber,
                streaming: streamingName,
                accountEmail: String(r.correo || r.Correo || '').trim(),
                currentDate: currentDateISO || 'Sin fecha',
                targetDate: cleanTargetDate,
                diffDays,
                monthlyPrice,
                adjustmentAmount
            });
        }

        const balanceStatus = totalNetAdjustment > 0
            ? 'charge_client'
            : (totalNetAdjustment < 0 ? 'client_credit' : 'even');

        if (previewOnly) {
            return res.json({
                success: true,
                preview: true,
                targetDate: cleanTargetDate,
                fixedDay: td,
                rowsCount: breakdown.length,
                breakdown,
                totalExtraCharge,
                totalCreditDiscount,
                netAdjustment: totalNetAdjustment,
                balanceStatus
            });
        }

        // Aplicar escritura en Excel para TODAS las filas activas del cliente
        let updatedCount = 0;
        const failedRows = [];
        for (const b of breakdown) {
            try {
                const updates = {
                    deben: cleanTargetDate,
                    Columna4: cleanTargetDate,
                    observaciones: `Fecha unificada (${cleanTargetDate})`
                };
                await updateExcelData(b.rowNumber, updates);
                updatedCount++;
            } catch (rowErr) {
                console.error(`[Unify Expiration] Error actualizando fila ${b.rowNumber}:`, rowErr.message);
                failedRows.push({ rowNumber: b.rowNumber, streaming: b.streaming, error: rowErr.message });
            }
        }

        // Si pidió guardar también el día fijo para futuras renovaciones, persistir en custom_billing_rules
        let updatedRules = customRules;
        if (saveFixedDay && td >= 1 && td <= 31) {
            const existingAllRule = customRules.find(r => String(r.platform || '').toUpperCase() === 'ALL');
            updatedRules = await saveCustomBillingRule({
                phone: phoneTail,
                client_name: clientName || (clientRows[0].row.Nombre || clientRows[0].row.whatsapp || ''),
                platform: 'ALL',
                account_email: existingAllRule ? existingAllRule.account_email : null,
                mode: existingAllRule ? existingAllRule.mode : 'fixed_date',
                custom_amount: existingAllRule ? existingAllRule.custom_amount : null,
                fixed_billing_day: td,
                notes: existingAllRule && existingAllRule.notes
                    ? existingAllRule.notes
                    : `Fecha fija unificada al día ${td} de cada mes`
            });
        }

        console.log(`[Admin API] 📅 Unificación completada para ${phoneTail}: ${updatedCount}/${breakdown.length} filas -> ${cleanTargetDate} | Ajuste neto: ${totalNetAdjustment} COP`);

        res.json({
            success: true,
            preview: false,
            targetDate: cleanTargetDate,
            fixedDay: td,
            updatedCount,
            rowsCount: breakdown.length,
            failedRows,
            breakdown,
            totalExtraCharge,
            totalCreditDiscount,
            netAdjustment: totalNetAdjustment,
            balanceStatus,
            rules: updatedRules
        });
    } catch (e) {
        console.error('[Admin API] Error unificando vencimientos:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Endpoint para editar datos del cliente, contraseña o customer mail en Excel
app.post('/api/admin/client/update-fields', express.json(), async (req, res) => {
    try {
        const { rowNumber, phone, streaming, fields, applyPasswordToAccount = false, originalCorreo = '', password } = req.body;
        if (password !== 'admin123') {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        if (!fields || typeof fields !== 'object') {
            return res.status(400).json({ success: false, message: 'Campos a actualizar requeridos' });
        }

        const { updateExcelData, fetchRawData } = require('../apiService');
        const allRows = await fetchRawData();
        let targetRow = parseInt(rowNumber);
        let matchedRowObj = null;

        if (targetRow && !isNaN(targetRow)) {
            matchedRowObj = allRows.find(r => (r._rowNumber || (allRows.indexOf(r) + 2)) === targetRow) || null;
        } else {
            const cleanPhone = (phone || '').toString().replace(/\D/g, '');
            matchedRowObj = allRows.find(r => {
                const rPhone = (r.numero || r.Numero || r.whatsapp || '').toString().replace(/\D/g, '');
                const rStreaming = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                const matchPhone = cleanPhone && rPhone.includes(cleanPhone.slice(-10));
                const matchStreaming = !streaming || rStreaming.includes(streaming.toLowerCase());
                return matchPhone && matchStreaming;
            }) || null;
            if (matchedRowObj) {
                targetRow = matchedRowObj._rowNumber || (allRows.indexOf(matchedRowObj) + 2);
            }
        }

        if (!targetRow || isNaN(targetRow)) {
            return res.status(404).json({ success: false, message: 'No se encontró la fila del cliente en Excel' });
        }

        const allowedKeys = ['Nombre', 'apellido', 'numero', 'whatsapp', 'correo', 'contraseña', 'customer mail', 'pin perfil', 'observaciones', 'operador'];
        const updates = {};
        for (const key of allowedKeys) {
            if (fields[key] !== undefined) {
                updates[key] = fields[key] === null ? '' : String(fields[key]).trim();
            }
        }
        if (updates.numero !== undefined && updates.whatsapp === undefined) {
            updates.whatsapp = updates.numero;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, message: 'No hay campos válidos para actualizar' });
        }

        console.log(`[Admin API] Editando fila ${targetRow}:`, Object.keys(updates).join(', '));
        const result = await updateExcelData(targetRow, updates);

        let extraUpdatedRows = 0;
        const accountEmailToMatch = (originalCorreo || updates.correo || (matchedRowObj && (matchedRowObj.correo || matchedRowObj.Correo)) || '').toString().toLowerCase().trim();
        const isSamePasswordFamily = (streamA, streamB) => {
            if (!streamA || !streamB) return true;
            if (streamA === streamB) return true;
            const families = [
                /apple|icloud/,
                /netflix/,
                /disney/,
                /spotify/,
                /youtube/,
                /\bhbo\b|\bmax\b/,
                /prime|amazon/,
                /paramount/,
                /crunchy/,
                /canva/,
                /chatgpt|\bgpt\b/,
                /claude/,
                /microsoft|office/,
                /\bvix\b/
            ];
            return families.some(rx => rx.test(streamA) && rx.test(streamB));
        };
        if (applyPasswordToAccount && updates['contraseña'] !== undefined && accountEmailToMatch) {
            const targetStreamingNorm = (streaming || (matchedRowObj && (matchedRowObj.Streaming || matchedRowObj.Plataforma)) || '').toString().toLowerCase().trim();
            for (const row of allRows) {
                const rNum = row._rowNumber || (allRows.indexOf(row) + 2);
                if (rNum === targetRow) continue;
                const rEmail = (row.correo || row.Correo || '').toString().toLowerCase().trim();
                const rStream = (row.Streaming || row.Plataforma || '').toString().toLowerCase().trim();
                if (rEmail === accountEmailToMatch && isSamePasswordFamily(targetStreamingNorm, rStream)) {
                    await updateExcelData(rNum, { 'contraseña': updates['contraseña'] });
                    extraUpdatedRows++;
                }
            }
        }

        res.json({
            success: true,
            message: extraUpdatedRows > 0
                ? `Datos actualizados (contraseña aplicada también a ${extraUpdatedRows} cupo(s) de la misma cuenta).`
                : 'Datos del cliente actualizados exitosamente.',
            rowNumber: targetRow,
            updates,
            extraUpdatedRows,
            result
        });
    } catch (e) {
        console.error("[Admin API] Error actualizando datos del cliente:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint para aplicar corte de servicio y gestionar reinicio de dispositivos cuando se sacan todas las sesiones
app.post('/api/admin/client/cut-service', express.json(), async (req, res) => {
    try {
        const { rowNumber, phone, streaming, email, reason, resetDevices, leaveSlotVirgin = true, saveOverdueDebt = true, password, agentName } = req.body;
        if (password !== 'admin123') {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { updateExcelData, fetchRawData, getTodayInBogota, getJsDateFromExcel, getPlatformKnowledge } = require('../apiService');
        const { resetDeviceUsage } = require('../deviceLimitService');
        let targetRow = parseInt(rowNumber);

        let targetData = null;
        const allRows = await fetchRawData();
        if (targetRow && !isNaN(targetRow)) {
            targetData = allRows[targetRow - 2];
        }

        if (!targetRow || isNaN(targetRow) || !targetData) {
            const cleanPhone = (phone || '').toString().replace(/\D/g, '');
            const target = allRows.find(r => {
                const rPhone = (r.numero || r.Numero || r.whatsapp || '').toString().replace(/\D/g, '');
                const rStreaming = (r.Streaming || r.Plataforma || '').toString().toLowerCase();
                const matchPhone = cleanPhone && rPhone.includes(cleanPhone.slice(-10));
                const matchStreaming = !streaming || rStreaming.includes(streaming.toLowerCase());
                return matchPhone && matchStreaming;
            });
            if (target) {
                targetRow = target._rowNumber || (allRows.indexOf(target) + 2);
                targetData = target;
            }
        }

        if (!targetRow || isNaN(targetRow)) {
            return res.status(404).json({ success: false, message: 'No se encontró la fila del cliente en Excel' });
        }

        const today = getTodayInBogota ? getTodayInBogota() : new Date();
        const dateStr = today.toLocaleDateString('es-CO');
        const author = agentName || 'admin';
        const cleanReason = (reason || 'No renovó').trim();
        const obsValue = `cortar - ${cleanReason} (${author} ${dateStr})`;

        // Respaldo preventivo en base de datos histórica si se va a dejar la casilla virgen
        if (leaveSlotVirgin && targetData) {
            try {
                const { pool } = require('../database');
                const prevPhone = (phone || targetData.numero || targetData.Numero || targetData.whatsapp || '').toString().replace(/\D/g, '');
                const prevStreaming = streaming || targetData.Streaming || targetData.Plataforma || '';
                const prevEmail = email || targetData.correo || targetData.Correo || '';
                const prevProfile = `${targetData.Nombre || ''} ${targetData.Apellido || ''}`.trim();
                const prevPin = targetData["pin perfil"] || targetData.pin || targetData.pin_perfil || '';
                const prevVenc = targetData.deben || targetData.vencimiento || null;

                if (prevPhone && pool) {
                    await pool.query(
                        `INSERT INTO excel_historical_records 
                            (customer_phone, streaming_platform, account_email, profile_name, profile_pin, fecha_corte, vencimiento, payment_method, amount_paid)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE 
                            fecha_corte = VALUES(fecha_corte),
                            profile_name = VALUES(profile_name)`,
                        [prevPhone, prevStreaming, prevEmail, prevProfile, prevPin, dateStr, prevVenc, 'Corte Admin', 0]
                    );
                }
            } catch (hErr) {
                console.warn("[Admin Cut Service] No se pudo guardar snapshot en histórico DB:", hErr.message);
            }
        }

        // Registrar saldo prorrateado por días disfrutados de más (si aplica y saveOverdueDebt !== false)
        let recordedDebt = null;
        if (saveOverdueDebt !== false && targetData) {
            try {
                const rawExp = targetData.deben || targetData.Columna4 || targetData.vencimiento || null;
                const expDateObj = rawExp ? getJsDateFromExcel(rawExp) : null;
                if (expDateObj && !isNaN(expDateObj.getTime())) {
                    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
                    const expMidnight = new Date(expDateObj.getFullYear(), expDateObj.getMonth(), expDateObj.getDate());
                    const extraDays = Math.round((todayMidnight.getTime() - expMidnight.getTime()) / (1000 * 60 * 60 * 24));
                    if (extraDays > 0) {
                        const prevPhone = (phone || targetData.numero || targetData.Numero || targetData.whatsapp || '').toString().replace(/\D/g, '');
                        const prevStreaming = streaming || targetData.Streaming || targetData.Plataforma || 'SERVICIO';
                        const prevName = `${targetData.Nombre || ''} ${targetData.Apellido || ''}`.trim() || targetData.whatsapp || '';
                        const { getPlatformPriceFromExcel } = require('../billingService');
                        const { getCustomBillingRulesByPhone, findMatchingCustomRule } = require('../customBillingService');
                        const { recordOverdueDebt } = require('../overdueDebtService');
                        const [platforms, customRules] = await Promise.all([
                            getPlatformKnowledge().catch(() => []),
                            getCustomBillingRulesByPhone(prevPhone).catch(() => [])
                        ]);
                        let monthlyPrice = getPlatformPriceFromExcel(targetData, platforms, '');
                        const matchedRule = findMatchingCustomRule(customRules, prevStreaming);
                        if (matchedRule && matchedRule.mode === 'custom_price' && Number(matchedRule.custom_amount) > 0) {
                            monthlyPrice = Number(matchedRule.custom_amount);
                        }
                        recordedDebt = await recordOverdueDebt({
                            phone: prevPhone,
                            clientName: prevName,
                            platform: prevStreaming,
                            extraDays,
                            monthlyPrice,
                            cutDate: dateStr,
                            notes: `Corte (${cleanReason}) con +${extraDays} día(s) de más en ${prevStreaming}`
                        });
                        if (recordedDebt) {
                            console.log(`[Admin Cut Service] ⚖️ Guardada mora previa para ${prevPhone}: +${extraDays}d = $${recordedDebt.debt_amount} COP (${prevStreaming})`);
                        }
                    }
                }
            } catch (debtErr) {
                console.warn('[Admin Cut Service] No se pudo registrar saldo de mora:', debtErr.message);
            }
        }

        let updatePayload = {};
        if (leaveSlotVirgin) {
            updatePayload = {
                "Nombre": "",
                "Apellido": "",
                "numero": "",
                "whatsapp": "",
                "deben": "",
                "observaciones": ""
            };
            console.log(`[Admin Cut Service] Dejando casilla virgen en fila ${targetRow} (Nombre, teléfono y vencimiento completamente vacíos)`);
        } else {
            updatePayload = { "observaciones": obsValue };
            console.log(`[Admin Cut Service] Marcando corte en fila ${targetRow}: "${obsValue}"`);
        }

        const result = await updateExcelData(targetRow, updatePayload);

        let devicesReset = false;
        if (resetDevices) {
            // El límite de códigos no aplica a cuando sacamos todas las sesiones
            devicesReset = resetDeviceUsage(phone, email || streaming);
            console.log(`[Admin Cut Service] Límite de dispositivos reseteado para ${phone} / ${email || streaming}:`, devicesReset);
        }

        res.json({
            success: true,
            message: leaveSlotVirgin 
                ? `Servicio cortado y casilla liberada ("virgen") exitosamente para nueva venta.${resetDevices ? ' Límite de dispositivos reseteado.' : ''}${recordedDebt ? ` Mora de +${recordedDebt.extra_days} día(s) ($${Number(recordedDebt.debt_amount || 0).toLocaleString('es-CO')} COP) guardada para descontar en su próxima activación.` : ''}`
                : `Servicio marcado para corte exitosamente.${resetDevices ? ' Límite de dispositivos reseteado.' : ''}`,
            rowNumber: targetRow,
            leaveSlotVirgin: !!leaveSlotVirgin,
            observaciones: leaveSlotVirgin ? '' : obsValue,
            devicesReset,
            recordedDebt,
            result
        });
    } catch (e) {
        console.error('[Admin Cut Service Error]:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/actions/send-info', async (req, res) => {
    try {
        const { phone, type, password, message: customMessage, platform } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const cleanPhone = phone ? phone.toString().replace(/\D/g, '') : '';
        if (!cleanPhone) {
            return res.status(400).json({ success: false, error: 'Número de teléfono inválido', message: 'Número de teléfono inválido' });
        }

        const formatExcelDate = (excelDate) => {
            if (!excelDate) return '-';
            const str = excelDate.toString().trim();
            if (isNaN(str)) {
                return str;
            }
            try {
                const serial = parseFloat(str);
                const date = new Date((serial - 25569) * 86400 * 1000);
                if (!isNaN(date.getTime())) {
                    const year = date.getUTCFullYear();
                    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
                    const day = String(date.getUTCDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                }
            } catch (e) { }
            return str;
        };

        let message = "";

        if (type === 'custom') {
            message = customMessage || "";
        } else {
            const { getAccountsByPhone } = require('../apiService');
            let accounts = await getAccountsByPhone(cleanPhone);
            if (!accounts || accounts.length === 0) return res.status(404).json({ success: false, message: 'Client not found', error: 'Client not found' });

            if (platform && platform.toString().trim() !== "") {
                const targetPlat = platform.toString().toLowerCase().trim().replace(/\s+/g, ' ');
                const exactAccounts = accounts.filter(acc => {
                    const streaming = (acc.Streaming || acc.Plataforma || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
                    return streaming === targetPlat;
                });
                if (exactAccounts.length > 0) {
                    accounts = exactAccounts;
                } else {
                    const filteredAccounts = accounts.filter(acc => {
                        const streaming = (acc.Streaming || acc.Plataforma || '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
                        if (!targetPlat.includes('extra') && streaming.includes('extra')) return false;
                        return streaming.includes(targetPlat) || targetPlat.includes(streaming);
                    });
                    if (filteredAccounts.length > 0) {
                        accounts = filteredAccounts;
                    }
                }
            }

            if (type === 'credentials') {
                message = `*Tus Credenciales de Sheer IT* 🔑\n\n`;
                accounts.forEach((clientData) => {
                    const streaming = (clientData.Streaming || 'N/A').toString().trim();
                    const streamingLower = streaming.toLowerCase();
                    const pass = clientData.contraseña || clientData.Contraseña || clientData.password || clientData.clave || clientData.Clave || '';
                    const pin = clientData['pin perfil'] || clientData.pin || clientData.pin_perfil || '';
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    const customerMail = clientData['customer mail'] || clientData.customerMail || clientData['Customer Mail'] || '';
                    const email = (clientData.correo && clientData.correo.length > 3) ? clientData.correo : (customerMail || clientData.correo || 'N/A');

                    const isFamilyOrInvitation = streamingLower.includes('youtube') ||
                        streamingLower.includes('apple') ||
                        streamingLower.includes('spotify familiar') ||
                        streamingLower.includes('extra');

                    message += `🍿 *Servicio:* ${streaming.toUpperCase()}\n`;
                    if (isFamilyOrInvitation && (customerMail || !pass)) {
                        message += `📧 *Correo registrado:* ${customerMail || email}\n` +
                            `📌 *Estado:* Acceso por invitación / perfil propio\n`;
                    } else {
                        message += `📧 *Usuario:* ${email}\n`;
                        if (pass && pass !== 'N/A') message += `🔑 *Contraseña:* ${pass}\n`;
                        if (pin && pin !== pass && pin.length > 0) message += `📍 *Pin Perfil:* ${pin}\n`;
                    }
                    message += `📅 *Vence:* ${venc}\n\n`;
                });
                message += `¡Disfruta tu servicio! 🤖`;
            } else if (type === 'payment') {
                const clientName = accounts[0].Nombre || 'Cliente';
                message = `¡Hola ${clientName}! 👋\n\n` +
                    `Te recordamos que tus siguientes servicios están próximos a vencer:\n\n`;
                accounts.forEach((clientData) => {
                    const venc = formatExcelDate(clientData['Fecha Vencimiento'] || clientData.deben || clientData.vencimiento);
                    message += `• *${(clientData.Streaming || 'N/A').toUpperCase()}* - Vence: ${venc}\n`;
                });
                message += `\n` +
                    `Puedes renovar realizando tu transferencia aquí:\n` +
                    `*Nequi / Daviplata / Bre-B (Llave):* 0087387259 ⚡\n\n` +
                    `Una vez realizado, envíanos el comprobante por este medio. ¡Gracias!`;
            }
        }

        const chatId = cleanPhone.includes('@') ? cleanPhone : `${cleanPhone}@c.us`;

        if (req.body.scheduledTime) {
            const { scheduleNewMessage } = require('../scheduledMessageService');
            const result = await scheduleNewMessage(ctx.getClient(), chatId, message, req.body.scheduledTime);
            return res.json({ success: true, isScheduled: true, formattedTime: result.formattedTime, message: 'Mensaje programado con éxito' });
        }

        const { safeSend } = require('../billingService');
        await safeSend(null, message, chatId, ctx.getClient());

        res.json({ success: true, message: 'Message sent via WhatsApp' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, message: e.message });
    }
});

app.post('/api/admin/sales/create', async (req, res) => {
    try {
        const { phone, name, items, duration, total, isRenewal, paymentMethod, password } = req.body;
        if (password !== 'admin123') return res.status(401).json({ success: false, message: 'Unauthorized' });

        const { recordNewSale } = require('../salesRegistryService');

        let subscriptionType = 'mensual';
        if (duration === '3') subscriptionType = 'trimestral';
        if (duration === '6') subscriptionType = 'semestral';
        if (duration === '12') subscriptionType = 'anual';

        const userState = {
            isRenewal: !!isRenewal,
            items: items.map(it => ({
                platform: { name: it.platformName },
                platformName: it.platformName,
                preferredEmail: it.preferredEmail || it.correo || null,
                _rowNumber: it._rowNumber || it.index || null,
                correo: it.correo || it.preferredEmail || null,
                contraseña: it.contraseña || null,
                pin: it.pin || null,
                deben: it.deben || null
            })),
            subscriptionType,
            nombre: name,
            total: parseFloat(total) || 0
        };

        const phoneId = phone.includes('@') ? phone : `${phone}@c.us`;
        const results = await recordNewSale(phoneId, userState, paymentMethod || "Web Admin", parseInt(duration) || null);

        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para consultar cuentas/correos con cupos libres en Excel por plataforma
app.get('/api/admin/available-accounts', async (req, res) => {
    try {
        const platformQuery = (req.query.platform || '').trim();
        const { fetchRawData } = require('../apiService');
        const { normalizeStreamingName } = require('../availabilityService');
        const { isSamePlatformFamily } = require('../salesRegistryService');
        const allRows = await fetchRawData().catch(() => []);
        
        const accountsMap = new Map(); // email -> { email, streaming, freeSlots, totalSlots }
        
        for (const row of allRows) {
            const rowStreaming = row.Streaming || row.Plataforma || '';
            const email = (row.correo || row.Correo || '').toString().toLowerCase().trim();
            if (!email || !rowStreaming) continue;
            
            if (platformQuery) {
                const normQuery = normalizeStreamingName(platformQuery);
                const normRow = normalizeStreamingName(rowStreaming);
                if (normQuery !== normRow && !isSamePlatformFamily(normRow, normQuery) && !rowStreaming.toLowerCase().includes(platformQuery.toLowerCase())) {
                    continue;
                }
            }
            
            const whatsapp = (row.whatsapp || '').toString().trim();
            const nombre = (row.Nombre || row.nombre || '').toString().trim();
            const isFree = !whatsapp && (!nombre || nombre.toLowerCase() === 'libre');
            
            const key = `${rowStreaming.toUpperCase()}:::${email}`;
            if (!accountsMap.has(key)) {
                accountsMap.set(key, {
                    streaming: rowStreaming,
                    email,
                    freeSlots: 0,
                    totalSlots: 0
                });
            }
            const acc = accountsMap.get(key);
            acc.totalSlots++;
            if (isFree) acc.freeSlots++;
        }
        
        const accounts = Array.from(accountsMap.values());
        res.json({ success: true, accounts });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/admin/match', async (req, res) => {
    try {
        const isp = req.query.isp || '';
        const { getNetflixMatchReport } = require('../adminService');
        const matchData = await getNetflixMatchReport(isp);
        res.json(matchData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET número invitado de una cuenta específica del cliente
app.get('/api/admin/client/guest-phone', async (req, res) => {
    try {
        const { ownerPhone, rowNumber, platform, email, profile } = req.query;
        if (!ownerPhone) return res.status(400).json({ success: false, message: 'Falta ownerPhone' });
        const { findExistingGuestRecord } = require('../guestPhoneService');
        const record = await findExistingGuestRecord({
            ownerPhone,
            accountRowId: rowNumber ? Number(rowNumber) : null,
            platform: platform || '',
            accountEmail: email || '',
            profileName: profile || ''
        });
        return res.json({ success: true, guestPhone: record ? record.guest_phone : null, record: record || null });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// POST asignar o actualizar número invitado desde el panel admin
app.post('/api/admin/client/guest-phone', express.json(), async (req, res) => {
    try {
        const { ownerPhone, guestPhone, rowNumber, platform, email, profile } = req.body || {};
        if (!ownerPhone || !platform) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios (ownerPhone, platform)' });
        }
        const { upsertGuestPhone } = require('../guestPhoneService');
        const saved = await upsertGuestPhone({
            ownerPhone,
            guestPhone,
            accountRowId: rowNumber ? Number(rowNumber) : null,
            platform,
            accountEmail: email || '',
            profileName: profile || '',
            addedBy: 'admin'
        });
        return res.json({ success: true, guestPhone: saved.guestPhone, message: 'Número invitado guardado correctamente.' });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message || 'Error al guardar número invitado.' });
    }
});

// DELETE eliminar número invitado desde el panel admin
app.delete('/api/admin/client/guest-phone', express.json(), async (req, res) => {
    try {
        const { ownerPhone, rowNumber, platform, email, profile } = req.body || req.query || {};
        if (!ownerPhone || !platform) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios (ownerPhone, platform)' });
        }
        const { removeGuestPhone } = require('../guestPhoneService');
        const removed = await removeGuestPhone({
            ownerPhone,
            accountRowId: rowNumber ? Number(rowNumber) : null,
            platform,
            accountEmail: email || '',
            profileName: profile || ''
        });
        return res.json({ success: true, removed, message: removed ? 'Número invitado eliminado.' : 'No había número invitado registrado.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message || 'Error al eliminar número invitado.' });
    }
});
}

module.exports = { registerAdminClientsRoutes };
