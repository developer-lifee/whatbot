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
                const { updateExcelData } = require('./apiService');
                const testDate = new Date().toISOString();
                await updateExcelData(2, { "Operador": "TEST EXITOSO: " + testDate });
                await message.reply(`✅ *Prueba de escritura completada.* He inyectado "TEST EXITOSO: ${testDate}" en la columna Operador de la fila 2 de tu Excel. Ve a revisarlo.`);
                return;
            } catch (err) {
                await message.reply(`❌ *Error en prueba de escritura*: ${err.message}`);
                return;
            }
        }

        const intent = await parseAdminQueryIntent(query);
        console.log(`[Admin Query] Intent:`, intent);
        
        const action = intent.action;
        const filters = intent.filters || {};
        
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
                    if (filters.name && nombreStr.includes(filters.name.toLowerCase())) match = true;
                    if (filters.phone && telStr.includes(filters.phone)) match = true;
                    if (filters.generic_search && nombreStr.includes(filters.generic_search.toLowerCase())) match = true;
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
            } else {
                if (filters.generic_search) {
                     filteredData = rawData.filter(row => JSON.stringify(row).toLowerCase().includes(filters.generic_search.toLowerCase()));
                } else filteredData = { message: "Consulta muy genérica." };
            }
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
        const report = await generateAdminReport(query, filteredData);
        await message.reply(report);

    } catch (error) {
        console.error("Error en processAdminQuery:", error);
        await message.reply("❌ Ups, hubo un error técnico procesando tu consulta de datos.");
    }
}

module.exports = {
    processAdminQuery
};
