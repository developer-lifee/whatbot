const { parseAdminQueryIntent, generateAdminReport } = require('./aiService');
const { fetchRawData, fetchHistoricoData, getTodayInBogota, getJsDateFromExcel } = require('./apiService');


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
                let targetCol = "Operador";
                
                // Intentamos primero con Operador (Mayúscula)
                try {
                    await updateExcelData(2, { "Operador": "TEST EXITOSO: " + testDate });
                } catch (e) {
                    console.log("[Test] Falló con 'Operador', intentando con 'operador'...");
                    await updateExcelData(2, { "operador": "TEST EXITOSO: " + testDate });
                    targetCol = "operador";
                }

                await message.reply(`✅ *Prueba de escritura completada.*\n📍 *Ubicación:* Fila 2, Columna "${targetCol}"\n📝 *Dato inyectado:* "TEST EXITOSO: ${testDate}"\n\nPor favor revisa tu Excel para confirmar que el cambio es visible.`);
                return;
            } catch (err) {
                const { fetchRawData } = require('./apiService');
                const sample = await fetchRawData();
                const cols = sample.length > 0 ? Object.keys(sample[0]).sort().join(', ') : "Ninguna";
                await message.reply(`❌ *Error en prueba*: ${err.message}\n\n🔍 *Columnas detectadas en tu Excel:* ${cols}\n\n_Revisa si el nombre coincide exactamente._`);
                return;
            }
        }

        // --- SHORTCUTS DIRECTOS ---
        const cleanQuery = query.toLowerCase().replace('@bot', '').trim();
        if (cleanQuery === 'haz los cobros' || cleanQuery === 'inicia cobranza' || cleanQuery === 'cobros automáticos') {
            const { handleAutoCobros } = require('./billingService');
            const GROUP_ID = '120363102144405222@g.us'; // ID del grupo admin
            await handleAutoCobros(message, GROUP_ID, userStates, {}, client);
            return;
        }

        const { handleAdminSuggestions } = require('./adminService');
        if (cleanQuery === 'funciones' || cleanQuery === 'ayuda' || cleanQuery === 'comandos' || query.toLowerCase().includes('hacer') || query.toLowerCase().includes('pasó')) {
            await handleAdminSuggestions(message, userStates);
            return;
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
                const normSearch = (str) => str ? str.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "") : "";
                const nameFilter = normSearch(filters.name);
                const genericFilter = normSearch(filters.generic_search);
                
                filteredData = rawData.filter(row => {
                    let match = false;
                    const nombreStr = normSearch(row['Nombre'] || row['nombre']);
                    const apellidoStr = normSearch(row['apellido'] || row['Apellido']);
                    const waNameStr = normSearch(row['whatsapp']); // El nombre como está en WhatsApp
                    const fullName = nombreStr + apellidoStr;
                    const telStr = normSearch(row['numero']);
                    const correoStr = normSearch(row['correo'] || row['Correo']);
                    const platStr = normSearch(row['Streaming']);

                    if (nameFilter && (fullName.includes(nameFilter) || waNameStr.includes(nameFilter) || correoStr.includes(nameFilter))) match = true;
                    if (filters.phone && telStr.includes(normSearch(filters.phone))) match = true;
                    if (genericFilter) {
                        if (fullName.includes(genericFilter) || waNameStr.includes(genericFilter) || telStr.includes(genericFilter) || correoStr.includes(genericFilter) || platStr.includes(genericFilter)) match = true;
                    }
                    return match;
                });
                
                // Si no hay match exacto, buscar sugerencias fuzzy
                if (filteredData.length === 0 && (nameFilter || genericFilter)) {
                    const originalSearch = (filters.name || filters.generic_search || "").toLowerCase();
                    const words = originalSearch.split(' ').filter(w => w.length >= 3);
                    const suggestions = new Set();
                    
                    if (words.length > 0) {
                        rawData.forEach(row => {
                            const originalName = (row['Nombre'] || row['nombre'] || '').toString().trim();
                            const originalApe = (row['apellido'] || row['Apellido'] || '').toString().trim();
                            const originalWa = (row['whatsapp'] || '').toString().trim();
                            
                            const fullOriginal = originalName + (originalApe ? ' ' + originalApe : '');
                            const fullNameNorm = fullOriginal.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                            const waNorm = originalWa.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                            
                            for (const w of words) {
                                const wNorm = w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                if ((fullNameNorm.includes(wNorm) && fullOriginal.length > 0) || (waNorm.includes(wNorm) && originalWa.length > 0)) {
                                    suggestions.add(fullOriginal || originalWa);
                                }
                            }
                        });
                    }
                    
                    if (suggestions.size > 0) {
                        filteredData = { 
                            status: "error", 
                            message: `No encontré una coincidencia exacta para *${originalSearch}*, pero encontré clientes con nombres similares:\n\n- ${Array.from(suggestions).slice(0, 10).join('\n- ')}\n\n¿Te referías a alguno de ellos? 🤖` 
                        };
                    }
                }
            } else if (action === 'update_data') {
                const { updateExcelData } = require('./apiService');
                const normSearch = (str) => str ? str.toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "") : "";
                const nameFilter = normSearch(filters.name || filters.generic_search);
                
                // 1. Buscar la fila (Fuzzy match)
                let matchIndex = -1;
                let matchedRow = null;
                
                for (let i = 0; i < rawData.length; i++) {
                    const row = rawData[i];
                    const nombreStr = normSearch(row['Nombre'] || row['nombre']);
                    const apellidoStr = normSearch(row['apellido'] || row['Apellido']);
                    const waNameStr = normSearch(row['whatsapp']);
                    const fullName = nombreStr + apellidoStr;
                    const correoStr = normSearch(row['correo'] || row['Correo']);
                    
                    if (nameFilter && (fullName.includes(nameFilter) || waNameStr.includes(nameFilter) || correoStr.includes(nameFilter))) {
                        matchIndex = i + 2;
                        matchedRow = row;
                        break;
                    }
                }
                
                if (matchIndex === -1) {
                    filteredData = { status: 'error', message: `No encontré a ningún cliente que coincida con "${filters.name || filters.generic_search}" para actualizar.` };
                } else {
                    // 2. Mapear el campo a actualizar
                    const fieldMap = {
                        'nombre': 'Nombre',
                        'apellido': 'apellido',
                        'correo': 'correo',
                        'email': 'correo',
                        'clave': 'contraseña',
                        'password': 'contraseña',
                        'vencimiento': 'vencimiento',
                        'pago': 'Metodo de pago',
                        'metodo': 'Metodo de pago',
                        'pin': 'pin perfil',
                        'perfil': 'pin perfil',
                        'operador': 'operador',
                        'deben': 'deben'
                    };

                    const targetField = fieldMap[filters.target_field?.toLowerCase()] || filters.target_field;
                    
                    if (!targetField) {
                        filteredData = { status: 'error', message: `No entendí qué campo deseas actualizar (nombre, correo, clave, etc.).` };
                    } else {
                        const updates = {};
                        updates[targetField] = filters.new_value;
                        
                        await updateExcelData(matchIndex, updates);
                        
                        // Guardar detalle técnico para la IA
                        const adminState = userStates.get(message.from) || {};
                        userStates.set(message.from, { 
                            ...adminState, 
                            lastAction: {
                                type: 'update_data',
                                row: matchIndex,
                                field: targetField,
                                newValue: filters.new_value,
                                previousValue: matchedRow[targetField],
                                client: matchedRow.Nombre || matchedRow.whatsapp,
                                timestamp: new Date().toISOString()
                            }
                        });

                        filteredData = { 
                            status: 'success', 
                            message: `✅ He actualizado el campo *${targetField}* a "${filters.new_value}" para el cliente *${matchedRow.Nombre || matchedRow.whatsapp}* en la fila ${matchIndex}. 🤖` 
                        };
                    }
                }
            } else if (action === 'record_sale') {
                const { recordNewSale } = require('./salesRegistryService');
                const dummyState = {
                    nombre: filters.name || "Cliente Dashboard",
                    items: [{ platform: { name: filters.platform || filters.generic_search || "Netflix" }, plan: { name: "Dashboard" } }],
                    subscriptionType: 'mensual'
                };
                const targetPhone = (filters.phone || filters.generic_search || '570000000000').replace(/\D/g, '');
                const targetId = (targetPhone.length >= 10 ? targetPhone : '570000000000') + '@c.us';
                
                const results = await recordNewSale(targetId, dummyState, "Venta Manual (Admin)");
                
                let detail = "";
                results.forEach(r => {
                    detail += `\n- *${r.name}*: ${r.status === 'success' ? `Fila ${r.rowNumber} ✅` : `❌ ${r.status}`}`;
                });
                
                // Guardar detalle técnico para la IA
                const adminState = userStates.get(message.from) || {};
                userStates.set(message.from, { 
                    ...adminState, 
                    lastAction: {
                        type: 'record_sale',
                        details: results,
                        client: dummyState.nombre,
                        timestamp: new Date().toISOString()
                    }
                });

                filteredData = { 
                    status: "success", 
                    message: `🚀 *Registro de Venta Manual*\nCliente: ${dummyState.nombre}\nResultados:${detail}\n\nEl sistema ha intentado asignar los cupos automáticamente.` 
                };
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
                const sourceQuery = filters.name ? filters.name.toLowerCase().trim() : (filters.generic_search ? filters.generic_search.toLowerCase().trim() : "");
                const platformFilter = filters.platform ? filters.platform.toLowerCase().trim() : null;
                const isMassiveToPlatform = filters.generic_search && (filters.generic_search.toLowerCase().includes('todos') || filters.generic_search.toLowerCase().includes('usuarios'));

                // Función de normalización para matches "gordos"
                const cln = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

                // 1. BUSCAR LA CUENTA FUENTE (De dónde sacamos las credenciales)
                const sourceMatch = rawData.find(row => {
                    const correoStr = (row['correo'] || row['Correo'] || '').toString();
                    const nombreStr = (row['Nombre'] || row['nombre'] || '').toString();
                    const platStr = (row['Streaming'] || row['streaming'] || '').toString();
                    
                    const accountMatch = cln(correoStr).includes(cln(sourceQuery)) || cln(nombreStr).includes(cln(sourceQuery));
                    const platMatch = platformFilter ? cln(platStr).includes(cln(platformFilter)) : true;
                    return accountMatch && platMatch;
                });

                if (!sourceMatch && !filters.new_password) {
                    filteredData = { status: "error", message: `No encontré ninguna cuenta que coincida con "${sourceQuery}" para usar como fuente de las credenciales.` };
                } else {
                    // 2. BUSCAR LOS DESTINATARIOS
                    let recipients = [];
                    const filterRecipients = (rows) => {
                        return rows.map(row => {
                            const platStr = (row['Streaming'] || row['streaming'] || '').toString().toLowerCase();
                            const numeroStr = (row['numero'] || '').toString().trim();
                            const nombreStr = (row['Nombre'] || row['nombre'] || '').toString().toLowerCase();
                            const isLibre = nombreStr === 'libre' || nombreStr === '';
                            const isOwner = platStr.includes('owner');
                            
                            const emailMatch = cln(row['correo'] || row['Correo']) === cln(sourceMatch.correo);
                            const platMatch = platformFilter ? cln(platStr).includes(cln(platformFilter)) : true;
                            const hasNum = numeroStr.length >= 8;

                            if (emailMatch && platMatch && hasNum && !isLibre) {
                                return {
                                    name: row['Nombre'] || row['nombre'] || "Cliente",
                                    phone: numeroStr,
                                    customer_mail: row['customer mail'] || row['customer_mail'] || null,
                                    pin_perfil: row['pin perfil'] || row['pin_perfil'] || null,
                                    vencimiento: row['vencimiento'] || row['deben'] || null,
                                    is_owner: isOwner
                                };
                            }
                            return null;
                        }).filter(r => r !== null);
                    };

                    if (isMassiveToPlatform && platformFilter) {
                        recipients = filterRecipients(rawData.filter(row => cln(row['Streaming'] || row['streaming']).includes(cln(platformFilter))));
                    } else {
                        recipients = filterRecipients(rawData.filter(row => cln(row['correo'] || row['Correo']) === cln(sourceMatch.correo)));
                    }

                    if (recipients.length > 0) {
                        const uniqueAccount = sourceMatch ? (sourceMatch['correo'] || sourceMatch['Correo']) : "Nueva Cuenta";
                        const platFound = platformFilter || (sourceMatch ? sourceMatch['Streaming'] : 'Streaming');
                        const passToSend = filters.new_password || (sourceMatch ? (sourceMatch['contraseña'] || sourceMatch['clave'] || sourceMatch['Clave']) : 'La actual');
                        
                        filteredData = {
                            status: "pending_confirmation",
                            action_type: "broadcast",
                            target_account: uniqueAccount,
                            platform: platFound,
                            new_password: passToSend,
                            custom_message: filters.custom_message || null,
                            only_fields: filters.only_fields || null,
                            count: recipients.length,
                            recipients: recipients.map(m => ({ 
                                tel: m['numero'], 
                                nombre: m['Nombre'] || m['nombre'] || 'Cliente',
                                pin_perfil: m['pin perfil'] || m['pin_perfil'] || m['perfil'] || m['pin'] || null,
                                vencimiento: m['vencimiento'] || m['Vencimiento'] || null,
                                is_owner: (m['Streaming'] || '').toLowerCase().includes('owner'),
                                customer_mail: m['customer mail'] || m['Customer Mail'] || null
                            }))
                        };
                    } else {
                        filteredData = { status: "error", message: `No encontré destinatarios válidos para el broadcast de ${platformFilter || sourceQuery}.` };
                    }
                }

            } else if (action === 'auto_cobros') {
                const { handleAutoCobros } = require('./billingService');
                const GROUP_ID = '120363102144405222@g.us';
                await handleAutoCobros(message, GROUP_ID, userStates, {}, client);
                return;
            } else if (action === 'list_functions' || action === 'explain_last_action') {
                const { handleAdminSuggestions } = require('./adminService');
                await handleAdminSuggestions(message, userStates);
                return;
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
