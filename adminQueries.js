const { parseAdminQueryIntent, generateAdminReport } = require('./aiService');
const { fetchRawData, fetchHistoricoData } = require('./apiService');

/**
 * Procesa la consulta analítica del administrador.
 * @param {Message} message
 * @param {string} query
 */
async function processAdminQuery(message, query) {
    try {
        await message.reply("🤖 *Analizando datos...* Dame un momento mientras busco la información.");

        // 1. Extraer intención
        const intent = await parseAdminQueryIntent(query);
        console.log(`[Admin Query] Intent:`, intent);
        
        const action = intent.action;
        const filters = intent.filters || {};
        
        let filteredData = [];

        // 2. Ejecutar búsqueda basada en la acción
        if (action === 'check_history') {
            const historico = await fetchHistoricoData();
            
            // Buscar por nombre o teléfono en histórico (el historico es un objeto cuyas llaves son los números)
            let resultadosHistorico = [];
            
            for (const [numero, datos] of Object.entries(historico)) {
                let match = true;
                
                if (filters.name) {
                   const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.toLowerCase();
                   if (!nombreCompleto.includes(filters.name.toLowerCase())) {
                       match = false;
                   }
                }
                
                if (filters.phone) {
                   if (!numero.includes(filters.phone)) {
                       match = false;
                   }
                }
                
                if (match && (filters.name || filters.phone || filters.generic_search)) {
                   if (filters.generic_search && match === true && !filters.name && !filters.phone) {
                      const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.toLowerCase();
                      if(!nombreCompleto.includes(filters.generic_search.toLowerCase()) && !numero.includes(filters.generic_search)) {
                          match = false;
                      }
                   }
                   if (match) {
                       resultadosHistorico.push({
                           numero: numero,
                           nombre: datos.nombre,
                           apellido: datos.apellido,
                           historial: datos.historial
                       });
                   }
                }
            }
            
            filteredData = resultadosHistorico.length > 0 ? resultadosHistorico : { message: "No se encontraron coincidencias en el histórico." };

        } else {
            // Para otras acciones (buscar cliente actual, buscar libres, resumen), usamos fetchRawData
            // Se usa fetchRawData en vez de fetchCustomersData porque podríamos buscar cuentas "libres" que no tienen cliente
            const rawData = await fetchRawData();
            
            if (action === 'get_available' || (filters.status && filters.status.toLowerCase().includes('libre'))) {
                filteredData = rawData.filter(row => {
                    const statusStr = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const isLibre = statusStr.includes('libre') || nombreStr === 'libre' || nombreStr === '';
                    
                    let platformMatch = true;
                    if (filters.platform) {
                        const platStr = (row['Streaming'] || '').toString().toLowerCase();
                        platformMatch = platStr.includes(filters.platform.toLowerCase());
                    }
                    
                    return isLibre && platformMatch;
                });
            } else if (action === 'search_customer') {
                filteredData = rawData.filter(row => {
                    let match = false;
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const telStr = (row['numero'] || '').toString();
                    
                    if (filters.name && nombreStr.includes(filters.name.toLowerCase())) {
                        match = true;
                    }
                    if (filters.phone && telStr.includes(filters.phone)) {
                        match = true;
                    }
                    if (filters.generic_search && nombreStr.includes(filters.generic_search.toLowerCase())) {
                        match = true;
                    }
                    return match;
                });
            } else if (action === 'summary_stats') {
                // Hacer un mapeo resumido
                const summary = {};
                rawData.forEach(row => {
                    const plat = (row['Streaming'] || 'Desconocido').toString().toUpperCase();
                    const statusStr = (row['Estado'] || row['estado'] || '').toString().toLowerCase();
                    const nombreStr = (row['Nombre'] || '').toString().toLowerCase();
                    const isLibre = statusStr.includes('libre') || nombreStr === 'libre' || nombreStr === '';
                    
                    if (!summary[plat]) {
                        summary[plat] = { total: 0, libres: 0, ocupadas: 0, cuentas_libres_detalle: [] };
                    }
                    summary[plat].total++;
                    if (isLibre) {
                        summary[plat].libres++;
                        // Guardar un poco de detalle por si a caso
                        summary[plat].cuentas_libres_detalle.push({correo: row['correo'], perfil: row['pin perfil'] || row['Nombre']});
                    } else {
                        summary[plat].ocupadas++;
                    }
                });
                
                if (filters.platform) {
                    const filterPlat = filters.platform.toLowerCase();
                    // Filtrar summary para devolver solo las que coinciden con filters.platform
                    const filteredSummary = {};
                    for (const key in summary) {
                        if (key.toLowerCase().includes(filterPlat)) {
                            filteredSummary[key] = summary[key];
                        }
                    }
                    filteredData = { resumen_estadisticas: filteredSummary };
                } else {
                    filteredData = { resumen_estadisticas: summary };
                }
            } else {
                // general query - no filters, or generic filter
                // No enviamos los 5000 registros de la base. Enviamos un error o le pedimos q sea especifico.
                if (filters.generic_search) {
                     filteredData = rawData.filter(row => {
                         const strData = JSON.stringify(row).toLowerCase();
                         return strData.includes(filters.generic_search.toLowerCase());
                     });
                } else {
                     filteredData = { message: "Consulta muy genérica. No se aplicaron filtros sustanciales, por favor sé más específico." };
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
