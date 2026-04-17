const { parseAdminQueryIntent, generateAdminReport } = require('./aiService');
const { fetchRawData, fetchHistoricoData } = require('./apiService');

/**
 * Procesa la consulta analítica del administrador.
 * @param {Message} message
 * @param {string} query
 * @param {Map} userStates - El mapa global de estados de usuarios
 * @param {Client} client - Cliente de WhatsApp
 */
async function processAdminQuery(message, query, userStates, client) {
    try {
        await message.reply("🤖 *Analizando datos...* Dame un momento mientras busco la información.");

        // 1. Extraer intención
        
        // --- ADMIN TEST COMMAND ---
        if (query.toLowerCase() === 'prueba de escritura') {
            try {
                const { updateExcelData, fetchRawData } = require('./apiService');
                const testDate = new Date().toLocaleString('es-CO');
                
                // Intentamos primero con Operador (Mayúscula)
                try {
                    await updateExcelData(2, { "Operador": "TEST EXITOSO: " + testDate });
                } catch (e) {
                    console.log("[Test] Falló con 'Operador', intentando con 'operador'...");
                    await updateExcelData(2, { "operador": "TEST EXITOSO: " + testDate });
                }

                await message.reply(`✅ *Prueba de escritura completada.* He inyectado "TEST EXITOSO: ${testDate}" en la fila 2. Por favor revisa tu Excel.`);
                return;
            } catch (err) {
                const { fetchRawData } = require('./apiService');
                const sample = await fetchRawData();
                const cols = sample.length > 0 ? Object.keys(sample[0]).sort().join(', ') : "Ninguna";
                await message.reply(`❌ *Error en prueba*: ${err.message}\n\n🔍 *Columnas detectadas en tu Excel:* ${cols}\n\n_Revisa si el nombre coincide exactamente._`);
                return;
            }
        }

        const intent = await parseAdminQueryIntent(query);
        console.log(`[Admin Query] Intent:`, intent);
        
        const action = intent.action;
        const filters = intent.filters || {};
        
        // --- COMANDO DE DEPURACIÓN DE TIEMPO ---
        if (query.toLowerCase().includes('tiempo') || query.toLowerCase().includes('hora')) {
            const now = new Date();
            const serverTime = now.toLocaleString('es-CO');
            const utcTime = now.toUTCString();
            await message.reply(`🕒 *Estado del Reloj del Servidor:*\n\n✅ *Hora Local (Bogotá):* ${serverTime}\n🌍 *Hora UTC:* ${utcTime}\n📍 *Zona Configurada:* America/Bogota\n\n_Esta es la hora que usa el bot para programar cobros (9 AM) y reportes (2 PM)._`);
            return;
        }

        let filteredData = [];

        // 2. Ejecutar búsqueda basada en la acción
        if (action === 'check_history') {
            const historico = await fetchHistoricoData();
            // ... (búsqueda en historico)
            let resultadosHistorico = [];
            for (const [numero, datos] of Object.entries(historico)) {
                let match = true;
                if (filters.name) {
                   const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.toLowerCase();
                   if (!nombreCompleto.includes(filters.name.toLowerCase())) match = false;
                }
                if (filters.phone) {
                   if (!numero.includes(filters.phone)) match = false;
                }
                if (match && (filters.name || filters.phone || filters.generic_search)) {
                   if (filters.generic_search && match === true && !filters.name && !filters.phone) {
                      const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.toLowerCase();
                      if(!nombreCompleto.includes(filters.generic_search.toLowerCase()) && !numero.includes(filters.generic_search)) match = false;
                   }
                   if (match) resultadosHistorico.push({ numero, nombre: datos.nombre, apellido: datos.apellido, historial: datos.historial });
                }
            }
            filteredData = resultadosHistorico.length > 0 ? resultadosHistorico : { message: "No se encontraron coincidencias en el histórico." };

        } else if (action === 'liberate_user') {
            const { searchContactByName } = require('./googleContactsService');
            let targetPhone = filters.phone;
            if (!targetPhone && filters.name) targetPhone = await searchContactByName(filters.name);

            if (targetPhone) {
                const targetId = targetPhone.includes('@') ? targetPhone : targetPhone + '@c.us';
                const actualPhone = targetPhone.replace('@c.us', '');
                if (userStates.has(targetId)) {
                    userStates.delete(targetId);
                    await client.sendMessage(targetId, '🤖 *BOT REACTIVADO*: Un asesor me ha pedido retomar la atención automática. ¿En qué puedo ayudarte?');
                    filteredData = { status: "success", message: `He reactivado el bot para ${filters.name || actualPhone}.` };
                } else {
                    filteredData = { status: "warning", message: `No encontré un estado activo para ${filters.name || actualPhone}.` };
                    userStates.delete(targetId);
                }
            } else {
                filteredData = { status: "error", message: `No pude encontrar a nadie llamado "${filters.name}" en tus contactos.` };
            }

        } else {
            // Para otras acciones (buscar cliente actual, buscar libres, resumen), usamos fetchRawData
            const rawData = await fetchRawData();
            
            if (action === 'get_available' || (filters.status && filters.status.toLowerCase().includes('libre'))) {
                filteredData = rawData.filter(row => {
                    const statusStr = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const isLibre = statusStr.includes('libre') || nombreStr === 'libre' || nombreStr === '';
                    let platformMatch = true;
                    if (filters.platform) platformMatch = (row['Streaming'] || '').toString().toLowerCase().includes(filters.platform.toLowerCase());
                    return isLibre && platformMatch;
                });
            } else if (action === 'search_customer') {
                filteredData = rawData.filter(row => {
                    let match = false;
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const telStr = (row['numero'] || '').toString();
                    const correoStr = (row['correo'] || row['Correo'] || '').toString().toLowerCase();
                    const platStr = (row['Streaming'] || '').toString().toLowerCase();

                    if (filters.name && (nombreStr.includes(filters.name.toLowerCase()) || correoStr.includes(filters.name.toLowerCase()))) match = true;
                    if (filters.phone && telStr.includes(filters.phone)) match = true;
                    if (filters.generic_search) {
                        const gs = filters.generic_search.toLowerCase();
                        if (nombreStr.includes(gs) || telStr.includes(gs) || correoStr.includes(gs) || platStr.includes(gs)) match = true;
                    }
                    return match;
                });
            } else if (action === 'summary_stats') {
                const summary = {};
                rawData.forEach(row => {
                    const plat = (row['Streaming'] || 'Desconocido').toString().toUpperCase();
                    const statusStr = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const isLibre = statusStr.includes('libre') || nombreStr === 'libre' || nombreStr === '';
                    if (!summary[plat]) summary[plat] = { total: 0, libres: 0, ocupadas: 0, cuentas_libres_detalle: [] };
                    summary[plat].total++;
                    if (isLibre) {
                        summary[plat].libres++;
                        summary[plat].cuentas_libres_detalle.push({correo: row['correo'], perfil: row['pin perfil'] || row['Nombre']});
                    } else summary[plat].ocupadas++;
                });
                if (filters.platform) {
                    const filterPlat = filters.platform.toLowerCase();
                    const filteredSummary = {};
                    for (const key in summary) if (key.toLowerCase().includes(filterPlat)) filteredSummary[key] = summary[key];
                    filteredData = { resumen_estadisticas: filteredSummary };
                } else filteredData = { resumen_estadisticas: summary };
            } else if (action === 'broadcast_credentials') {
                const accountQuery = filters.generic_search ? filters.generic_search.toLowerCase().trim() : "";
                const platformFilter = filters.platform ? filters.platform.toLowerCase().trim() : null;

                // Función de normalización para matches "gordos" (ignora espacios, puntos, etc.)
                const cln = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

                // 1. BÚSQUEDA SMART (Fuzzy)
                let matches = rawData.filter(row => {
                    const correoStr = row['correo'] || row['Correo'] || '';
                    const nombreStr = row['Nombre'] || row['nombre'] || '';
                    const platStr = row['Streaming'] || row['streaming'] || '';
                    const numeroStr = (row['numero'] || '').toString().trim();
                    const hasNum = numeroStr.length >= 8;

                    if (!accountQuery) return false;

                    const accountMatch = cln(correoStr).includes(cln(accountQuery)) || cln(nombreStr).includes(cln(accountQuery));
                    const platMatch = platformFilter ? cln(platStr).includes(cln(platformFilter)) : true;
                    
                    return accountMatch && platMatch && hasNum;
                });

                // 2. Si no hubo matches con plataforma, intentamos SIN plataforma para sugerir alternativas
                if (matches.length === 0 && accountQuery && platformFilter) {
                    const altMatches = rawData.filter(row => cln(row['correo'] || row['Correo'] || '').includes(cln(accountQuery)));
                    if (altMatches.length > 0) {
                        const platsEncontradas = [...new Set(altMatches.map(r => r['Streaming'] || 'Otro'))];
                        filteredData = { 
                            status: "suggestion", 
                            message: `No encontré el correo "${accountQuery}" en ${platformFilter}, pero sí lo encontré en: ${platsEncontradas.join(', ')}. ¿Te referías a alguna de estas plataformas? 🤔`,
                            originalFilters: filters,
                            options: platsEncontradas,
                            options_count: platsEncontradas.length
                        };
                    } else {
                        filteredData = { status: "error", message: `No pude encontrar nada parecido a "${accountQuery}" en ninguna plataforma.` };
                    }
                } else if (matches.length > 0) {
                    // MODO PREVIEW: No enviamos nada aún.
                    const uniqueAccount = [...new Set(matches.map(m => m['correo'] || m['Correo']))][0];
                    const platFound = matches[0]['Streaming'] || 'Streaming';
                    const passToSend = filters.new_password || matches[0]['contraseña'] || matches[0]['clave'] || matches[0]['Clave'] || 'La actual';
                    
                    filteredData = {
                        status: "pending_confirmation",
                        action_type: "broadcast",
                        target_account: uniqueAccount,
                        platform: platFound,
                        new_password: passToSend,
                        custom_message: filters.custom_message || null,
                        only_fields: filters.only_fields || null,
                        count: matches.length,
                        // Guardamos más datos para que el mensaje sea más rico (Pin, Factura, etc.)
                        recipients: matches.map(m => ({ 
                            tel: m['numero'], 
                            perfil: m['Nombre'] || m['pin perfil'] || 'Asignado',
                            pin: m['pin perfil'] || m['pin'] || m['Pin'] || null,
                            vencimiento: m['vencimiento'] || m['Vencimiento'] || null
                        }))
                    };
                } else {
                    filteredData = { status: "error", message: `No encontré ningún usuario válido (con teléfono) asociado a "${accountQuery}".` };
                }

            } else if (action === 'confirm_action') {
                // Esta acción se activa cuando el admin dice "sí", "dale" etc.
                // El index.js se encarga de recuperar el payload del estado
                filteredData = { status: "ready_to_confirm" };
            } else {
                if (filters.generic_search) {
                     filteredData = rawData.filter(row => JSON.stringify(row).toLowerCase().includes(filters.generic_search.toLowerCase()));
                } else filteredData = { message: "Consulta muy genérica." };
            }
        }

        // Limitar los resultados retornados para evitar exceder el límite de texto
        if (Array.isArray(filteredData)) {
            // Limpiamos los campos poco relevantes o vacíos para ahorrar espacio (AI prompt token optimization)
            filteredData = filteredData.map(row => {
               const cleanRow = {};
               for (const key in row) {
                   if (row[key] !== null && row[key] !== "") {
                       cleanRow[key] = row[key];
                   }
               }
               return cleanRow;
            });

            if (filteredData.length > 50) {
               console.log(`[Admin Query] Limitando resultados. Mostrando 50 de ${filteredData.length}`);
               filteredData = {
                   nota: `Hay ${filteredData.length} resultados encontrados. Te muestro los primeros 50 para evitar sobrecarga de lectura.`,
                   resultados: filteredData.slice(0, 50)
               };
            }
        } else if (filteredData.resumen_estadisticas) {
            // Limpiar cuentas detalle del resumen si no se preguntaron específicamente, para q no escupa miles de cuentas libres 
            for (const key in filteredData.resumen_estadisticas) {
               if (filteredData.resumen_estadisticas[key].cuentas_libres_detalle.length > 5) {
                   filteredData.resumen_estadisticas[key].cuentas_libres_detalle = filteredData.resumen_estadisticas[key].cuentas_libres_detalle.slice(0, 5); 
                   filteredData.resumen_estadisticas[key].nota_detalle = "Se muestran solo 5 ejemplos de cuentas libres.";
               }
            }
        }

        // 3. Generar reporte con IA
        // OPTIMIZACIÓN: Si es una confirmación de acción, no generamos reporte de IA, 
        // dejamos que el flujo de confirmación en index.js tome el control.
        if (filteredData.status === "ready_to_confirm") {
            return { filteredData }; 
        }

        const report = await generateAdminReport(query, filteredData);
        await message.reply(report);

        return { filteredData }; 
    } catch (error) {
        console.error("Error en processAdminQuery:", error);
        await message.reply("❌ Ups, hubo un error técnico procesando tu consulta de datos.");
    }
}

module.exports = {
    processAdminQuery
};
