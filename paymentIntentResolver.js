/**
 * paymentIntentResolver.js
 *
 * Fuente única de verdad para resolver si un pago entrante corresponde a:
 * - Renovación de 1 o varias cuentas existentes en Excel (type: 'renewal')
 * - Compra nueva de catálogo (type: 'new_sale')
 * - Carrito mixto: renovación + compra nueva en una misma transferencia
 *
 * Reemplaza las múltiples asignaciones dispersas de `stateData.isRenewal` en index.js.
 */

const { getPlatformPriceFromExcel, findPlatformByName } = require('./billingService');
const { isSamePlatformFamily } = require('./salesRegistryService');
const { getPricingRules, getJsDateFromExcel } = require('./apiService');

function hasExcelAccountIdentity(item) {
    return Boolean(item && (item.rowNumber || item._rowNumber || item.correo || item.Correo));
}

function getItemPlatformName(item) {
    if (!item) return '';
    const rawPlan = item.chosenPlan ? item.chosenPlan.name : (item.plan ? (typeof item.plan === 'string' ? item.plan : (item.plan.name || item.plan.label || '')) : '');
    const base = item.Streaming || item.Plataforma || (item.platform && item.platform.name) || item.name || '';
    return rawPlan && !String(base).toLowerCase().includes(String(rawPlan).toLowerCase())
        ? `${base} ${rawPlan}`.trim()
        : String(base).trim();
}

function findMatchingActiveAccount(platformLabel, activeAccounts = []) {
    if (!platformLabel || !Array.isArray(activeAccounts) || activeAccounts.length === 0) return null;
    const normTarget = String(platformLabel).toLowerCase().trim();
    return activeAccounts.find(acc => {
        const accPlat = String(acc.Streaming || acc.Plataforma || '').toLowerCase().trim();
        if (!accPlat) return false;
        return accPlat === normTarget || accPlat.includes(normTarget) || normTarget.includes(accPlat) || isSamePlatformFamily(accPlat, normTarget);
    }) || null;
}

function getDaysRemainingForAccount(acc) {
    const raw = acc && (acc.deben || acc.Columna4 || acc.vencimiento);
    if (!raw) return null;
    const d = getJsDateFromExcel(raw);
    if (!d || isNaN(d.getTime())) return null;
    return (d.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
}

/**
 * Resuelve de forma centralizada los ítems del pedido y su naturaleza (renovación vs venta nueva)
 * mutando `stateData` de forma consistente.
 */
async function resolvePaymentCartAndIntent({
    stateData,
    userAccounts = [],
    accountsWithPrices = [],
    platforms = [],
    check = {},
    candidateTargetPlatform = null,
    matchedUserAccount = null,
    explicitlyWantsNew = false,
    combinedClientText = '',
    batchText = '',
    history = '',
    userId = ''
}) {
    const historyLower = String(history || '').toLowerCase();
    const amount = Number(check && check.amount) || 0;

    // 0. Limpiar carrito obsoleto si venía de un estado viejo (>4h o main_menu/waiting_human sin filas reales)
    const isStaleState =
        stateData.state === 'waiting_human' ||
        stateData.state === 'main_menu' ||
        (stateData.timestamp && (Date.now() - stateData.timestamp > 4 * 60 * 60 * 1000));

    if (isStaleState && (!Array.isArray(stateData.items) || !stateData.items.some(hasExcelAccountIdentity))) {
        delete stateData.items;
        delete stateData.isRenewal;
        delete stateData.isNewSale;
        delete stateData.total;
    }

    // 1. Determinar si el cliente pidió explícitamente un servicio nuevo (o carrito mixto: renovación + plataforma nueva)
    let isNewRequested = false;
    let detectedMixedCombo = null;

    if (candidateTargetPlatform && !matchedUserAccount && userAccounts.length > 0 && amount > 0 && !explicitlyWantsNew) {
        const lowerCand = String(candidateTargetPlatform).toLowerCase().replace(/[^a-z0-9]/g, '');
        const candPlatObj = platforms.find(p => {
            const cleanP = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return lowerCand.includes(cleanP) || cleanP.includes(lowerCand);
        });
        if (candPlatObj) {
            const candPlans = candPlatObj.plans && candPlatObj.plans.length > 0
                ? candPlatObj.plans
                : [{ name: candPlatObj.name, price: candPlatObj.price }];
            // Probar combinación: 1 cuenta activa + nueva plataforma, o todas sus cuentas activas + nueva plataforma
            const activeSubsets = accountsWithPrices.map(a => [a]);
            if (accountsWithPrices.length > 1) activeSubsets.unshift(accountsWithPrices);

            for (const subset of activeSubsets) {
                const activeSum = subset.reduce((s, a) => s + (a.calculatedPrice || 0), 0);
                for (const pl of candPlans) {
                    const newPrice = pl.price || candPlatObj.price || 0;
                    if (!newPrice) continue;
                    const totalItems = subset.length + 1;
                    const rawTotal = activeSum + newPrice;
                    const discTotal = Math.max(0, rawTotal - 1000 * (totalItems - 1));
                    if (Math.abs(amount - discTotal) <= 1000 || Math.abs(amount - rawTotal) <= 1000) {
                        detectedMixedCombo = { activeSubset: subset, plat: candPlatObj, plan: pl, price: newPrice };
                        break;
                    }
                }
                if (detectedMixedCombo) break;
            }
        }
    }

    if (detectedMixedCombo) {
        isNewRequested = false;
    } else if (stateData.isRenewal === true || stateData.intent === 'renovar') {
        isNewRequested = false;
    } else if (explicitlyWantsNew || stateData.intent === 'comprar') {
        // Si tiene cuenta activa de esa misma plataforma y está vencida/por vencer (<= 10 días), sigue siendo renovación salvo que pida cupo adicional explícito
        if (matchedUserAccount && !explicitlyWantsNew) {
            const daysRem = getDaysRemainingForAccount(matchedUserAccount);
            isNewRequested = daysRem !== null && daysRem > 15;
        } else {
            isNewRequested = true;
        }
    } else if (candidateTargetPlatform && !matchedUserAccount) {
        isNewRequested = true;
        console.log(`[PaymentResolver] 🆕 Plataforma detectada (${candidateTargetPlatform}) no está en sus cuentas activas. Marcado como COMPRA NUEVA.`);
    } else if (userAccounts.length > 0 && !matchedUserAccount && amount > 0) {
        const priceMatchesExisting = accountsWithPrices.some(ap => ap.calculatedPrice === amount);
        if (!priceMatchesExisting) {
            const catalogMatch = platforms.find(p => p.price === amount || (p.plans && p.plans.some(pl => pl.price === amount)));
            if (catalogMatch) {
                isNewRequested = true;
                if (!candidateTargetPlatform) candidateTargetPlatform = catalogMatch.name;
            }
        }
    }

    // 2. Si el carrito está vacío, resolver ítems desde cuentas activas de Excel o catálogo
    if (!Array.isArray(stateData.items) || stateData.items.length === 0) {
        if (detectedMixedCombo) {
            console.log(`[PaymentResolver] 🎯 Carrito mixto explícito detectado para @${userId}: Renovación (${detectedMixedCombo.activeSubset.map(a => a.Streaming).join(', ')}) + Compra (${detectedMixedCombo.plat.name})`);
            stateData.items = [
                ...detectedMixedCombo.activeSubset.map(acc => ({ ...acc, isRenewal: true, type: 'renewal' })),
                {
                    Streaming: detectedMixedCombo.plan.name !== detectedMixedCombo.plat.name
                        ? `${detectedMixedCombo.plat.name} - ${detectedMixedCombo.plan.name}`
                        : detectedMixedCombo.plat.name,
                    platform: detectedMixedCombo.plat,
                    chosenPlan: detectedMixedCombo.plan,
                    price: detectedMixedCombo.price,
                    isRenewal: false,
                    type: 'new_sale'
                }
            ];
            stateData.total = amount;
            stateData.durationMonths = 1;
            stateData.isAutoFilled = true;
            stateData.isRenewal = false;
            stateData.hasMixedCart = true;
        }
        // 2.1 Prioridad: Cuentas activas del cliente cuando NO pidió compra nueva
        else if (userAccounts.length > 0 && !isNewRequested) {
            const dateGroups = {};
            accountsWithPrices.forEach(acc => {
                const d = String(acc.deben || acc.vencimiento || '').trim();
                if (!dateGroups[d]) dateGroups[d] = [];
                dateGroups[d].push(acc);
            });

            let matchingSameDateCombo = null;
            for (const d of Object.keys(dateGroups)) {
                const group = dateGroups[d];
                if (group.length > 1) {
                    const baseSum = group.reduce((sum, a) => sum + (a.calculatedPrice || 0), 0);
                    const comboDiscountPrice = Math.max(0, baseSum - 1000 * (group.length - 1));
                    if (amount && (amount === comboDiscountPrice || amount === baseSum)) {
                        matchingSameDateCombo = { items: group, price: amount };
                        break;
                    }
                }
            }

            // También verificar si la suma de TODAS sus cuentas activas coincide con el monto (aunque tengan fechas distintas)
            let matchingAllAccountsCombo = null;
            if (!matchingSameDateCombo && accountsWithPrices.length > 1 && amount > 0) {
                const totalAll = accountsWithPrices.reduce((sum, a) => sum + (a.calculatedPrice || 0), 0);
                const totalAllDisc = Math.max(0, totalAll - 1000 * (accountsWithPrices.length - 1));
                if (amount === totalAll || amount === totalAllDisc) {
                    matchingAllAccountsCombo = { items: accountsWithPrices, price: amount };
                } else {
                    // Buscar par exacto de cuentas activas cuya suma coincida con amount (ej: HBO Platino + Crunchy)
                    for (let i = 0; i < accountsWithPrices.length; i++) {
                        for (let j = i + 1; j < accountsWithPrices.length; j++) {
                            const pairSum = (accountsWithPrices[i].calculatedPrice || 0) + (accountsWithPrices[j].calculatedPrice || 0);
                            if (amount === pairSum || amount === pairSum - 1000) {
                                matchingAllAccountsCombo = { items: [accountsWithPrices[i], accountsWithPrices[j]], price: amount };
                                break;
                            }
                        }
                        if (matchingAllAccountsCombo) break;
                    }
                }
            }

            const chosenCombo = matchingSameDateCombo || matchingAllAccountsCombo;
            if (chosenCombo) {
                stateData.items = chosenCombo.items.map(acc => ({ ...acc, isRenewal: true, type: 'renewal' }));
                stateData.total = chosenCombo.price;
                stateData.isRenewal = true;
                stateData.isNewSale = false;
                stateData.isAutoFilled = true;
            } else if (amount && accountsWithPrices.some(ap => ap.calculatedPrice === amount)) {
                const matchingByPrice = accountsWithPrices.filter(ap => ap.calculatedPrice === amount);
                let matchedAcc = null;
                if (matchingByPrice.length > 1) {
                    const textToSearch = `${candidateTargetPlatform || ''} ${batchText || ''} ${historyLower}`.toLowerCase();
                    matchedAcc = matchingByPrice.find(ap => {
                        const plat = String(ap.Streaming || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        return plat && textToSearch.includes(plat);
                    });
                }
                matchedAcc = matchedAcc || matchingByPrice[0];
                stateData.items = [{ ...matchedAcc, isRenewal: true, type: 'renewal' }];
                stateData.total = amount;
                stateData.isRenewal = true;
                stateData.isNewSale = false;
                stateData.isAutoFilled = true;
            } else if (matchedUserAccount) {
                const accPrice = accountsWithPrices.find(ap => ap.id === matchedUserAccount.id)?.calculatedPrice || amount;
                stateData.items = [{ ...matchedUserAccount, isRenewal: true, type: 'renewal' }];
                stateData.total = amount || accPrice;
                stateData.isRenewal = true;
                stateData.isNewSale = false;
                stateData.isAutoFilled = true;
            } else if (userAccounts.length === 1 && (!amount || Math.abs((accountsWithPrices[0]?.calculatedPrice || 0) - amount) <= 1000)) {
                stateData.items = [{ ...userAccounts[0], isRenewal: true, type: 'renewal' }];
                stateData.total = amount || accountsWithPrices[0]?.calculatedPrice;
                stateData.isRenewal = true;
                stateData.isNewSale = false;
                stateData.isAutoFilled = true;
            }
        }

        // 2.2 Si aún no se resolvió: compra nueva por plataforma objetivo, carrito mixto o multimensual
        if (!Array.isArray(stateData.items) || stateData.items.length === 0) {
            const targetPlatToUse = candidateTargetPlatform || (check && check.inferredPlatform);
            if (targetPlatToUse) {
                const lowerInferred = String(targetPlatToUse).toLowerCase().replace(/[^a-z0-9]/g, '');
                const matchedPlats = platforms.filter(p => {
                    const cleanPlat = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                    return lowerInferred.includes(cleanPlat) || cleanPlat.includes(lowerInferred);
                });

                let catalogPrice = 0;
                const matchedItems = [];
                for (const plat of matchedPlats) {
                    let price = plat.price || 0;
                    let planName = plat.name;
                    if (plat.plans && plat.plans.length > 0) {
                        const textToSearchPlans = `${targetPlatToUse} ${batchText || ''} ${String(history || '').slice(-1500)}`.toLowerCase();
                        let specificPlan = plat.plans.find(plan => plan.price === amount);
                        if (!specificPlan) {
                            specificPlan = plat.plans.find(plan => {
                                const cleanPlan = plan.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                                return cleanPlan.length >= 3 && textToSearchPlans.includes(cleanPlan);
                            });
                        }
                        if (!specificPlan && amount) {
                            const multipleMatches = plat.plans.filter(plan => plan.price > 0 && amount % plan.price === 0 && amount >= plan.price);
                            if (multipleMatches.length > 0) {
                                specificPlan = multipleMatches.sort((a, b) => b.price - a.price)[0];
                            }
                        }
                        specificPlan = specificPlan || plat.plans[0];
                        price = specificPlan.price;
                        planName = `${plat.name} - ${specificPlan.name}`;
                    }
                    catalogPrice += price;
                    matchedItems.push({
                        Streaming: planName,
                        platform: { name: plat.name, price },
                        price,
                        isRenewal: false,
                        type: 'new_sale'
                    });
                }

                if (matchedItems.length > 1) catalogPrice = Math.max(0, catalogPrice - 1000);
                stateData.items = matchedItems.length > 0
                    ? matchedItems
                    : [{ Streaming: targetPlatToUse, platform: { name: targetPlatToUse }, price: amount, isRenewal: false, type: 'new_sale' }];
                stateData.total = amount || catalogPrice;
                stateData.isAutoFilled = true;
                stateData.isRenewal = false;
                stateData.isNewSale = true;
            } else if (userAccounts.length === 1 && !isNewRequested) {
                const singlePrice = accountsWithPrices[0]?.calculatedPrice || 14000;
                let mixedMatchedPlat = null;
                if (amount && amount > singlePrice * 1.3 && platforms.length > 0) {
                    for (const plat of platforms) {
                        const candidatePlans = plat.plans && plat.plans.length > 0 ? plat.plans : [{ name: plat.name, price: plat.price }];
                        for (const pl of candidatePlans) {
                            const pPrice = pl.price || plat.price;
                            const expCombo = singlePrice + pPrice - 1000;
                            const expReg = singlePrice + pPrice;
                            if (Math.abs(amount - expCombo) <= 1000 || Math.abs(amount - expReg) <= 1000) {
                                mixedMatchedPlat = { plat, plan: pl, price: pPrice };
                                break;
                            }
                        }
                        if (mixedMatchedPlat) break;
                    }
                }

                if (mixedMatchedPlat) {
                    console.log(`[PaymentResolver] 🎯 Carrito mixto detectado para @${userId}: Renovación ${userAccounts[0].Streaming} + Compra ${mixedMatchedPlat.plat.name}`);
                    stateData.items = [
                        { ...userAccounts[0], isRenewal: true, type: 'renewal' },
                        {
                            Streaming: mixedMatchedPlat.plan.name !== mixedMatchedPlat.plat.name
                                ? `${mixedMatchedPlat.plat.name} - ${mixedMatchedPlat.plan.name}`
                                : mixedMatchedPlat.plat.name,
                            platform: mixedMatchedPlat.plat,
                            chosenPlan: mixedMatchedPlat.plan,
                            price: mixedMatchedPlat.price,
                            isRenewal: false,
                            type: 'new_sale'
                        }
                    ];
                    stateData.total = amount;
                    stateData.durationMonths = 1;
                    stateData.isAutoFilled = true;
                    stateData.isRenewal = false;
                    stateData.hasMixedCart = true;
                } else {
                    const activeRules = await getPricingRules();
                    const matchedPlatObj = findPlatformByName(userAccounts[0].Streaming || '', platforms);
                    const tier = matchedPlatObj?.discountTier || 'A';
                    const tierRules = (activeRules && activeRules.durationDiscounts && (activeRules.durationDiscounts[tier] || activeRules.durationDiscounts['A'])) || {};
                    const multiMonths = [12, 6, 4, 3, 2, 1];
                    const detectedMultiMonth = amount ? multiMonths.find(m => {
                        const factor = tierRules[String(m)] ? tierRules[String(m)].factor : 1.0;
                        const discountedPrice = Math.ceil((singlePrice * m * factor) / 1000) * 1000;
                        return Math.abs(singlePrice * m - amount) <= 1000 || Math.abs(discountedPrice - amount) <= 1000;
                    }) : 1;
                    if (!amount || detectedMultiMonth || Math.abs(amount - singlePrice) <= 1000) {
                        stateData.items = [{ ...userAccounts[0], isRenewal: true, type: 'renewal' }];
                        stateData.total = amount || singlePrice;
                        stateData.durationMonths = detectedMultiMonth || 1;
                        stateData.isAutoFilled = true;
                        stateData.isRenewal = true;
                        stateData.isNewSale = false;
                    }
                }
            } else if (userAccounts.length > 1 && !isNewRequested) {
                stateData.items = userAccounts.map(acc => ({ ...acc, isRenewal: true, type: 'renewal' }));
                stateData.total = amount;
                stateData.isAutoFilled = true;
                stateData.isRenewal = true;
                stateData.isNewSale = false;
            }

            // 2.3 Recuperación desde cotización reciente en el historial del chat
            if (!Array.isArray(stateData.items) || stateData.items.length === 0) {
                const quoteMatch = String(history || '').match(/Entendido,\s*buscas:\s*[\r\n]+(?:-\s*([^\r\n:]+):\s*\$?(\d+))/i);
                let recoveredPlat = quoteMatch ? quoteMatch[1].trim() : null;
                if (!recoveredPlat) {
                    const textToSearch = `${combinedClientText} ${history || ''}`.toLowerCase();
                    for (const p of platforms) {
                        const cleanPName = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                        const matchesName = cleanPName.length >= 3 && (textToSearch.includes(cleanPName) || (cleanPName.includes('chatgpt') && (textToSearch.includes('gpt') || textToSearch.includes('chat gpt'))));
                        if (matchesName) {
                            const matchesPrice = p.price === amount || (p.plans && p.plans.some(pl => pl.price === amount));
                            if (matchesPrice || !amount) {
                                recoveredPlat = p.name;
                                break;
                            }
                        }
                    }
                }
                if (recoveredPlat) {
                    const lowerRec = recoveredPlat.toLowerCase();
                    const matchedPlat = platforms.find(p => p.name.toLowerCase() === lowerRec || lowerRec.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(lowerRec));
                    let pPrice = amount || 20000;
                    let pName = recoveredPlat;
                    if (matchedPlat) {
                        pName = matchedPlat.name;
                        pPrice = matchedPlat.price || amount;
                        if (matchedPlat.plans && matchedPlat.plans.length > 0) {
                            const textToSearchPlans = `${matchedPlat.name} ${batchText || ''} ${String(history || '').slice(-1500)}`.toLowerCase();
                            let planMatch = matchedPlat.plans.find(pl => pl.price === amount) ||
                                matchedPlat.plans.find(pl => {
                                    const cleanPlan = pl.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                                    return cleanPlan.length >= 3 && textToSearchPlans.includes(cleanPlan);
                                }) ||
                                matchedPlat.plans[0];
                            pPrice = amount || planMatch.price;
                            pName = `${matchedPlat.name} - ${planMatch.name}`;
                        }
                    }
                    stateData.items = [{
                        Streaming: pName,
                        platform: { name: matchedPlat ? matchedPlat.name : recoveredPlat, price: pPrice },
                        price: pPrice,
                        isRenewal: false,
                        type: 'new_sale'
                    }];
                    stateData.total = pPrice;
                    stateData.isAutoFilled = true;
                }
            }
        }
    }

    // 3. Normalización final ÍTEM POR ÍTEM (evita que una compra nueva pise una renovación o viceversa)
    if (Array.isArray(stateData.items) && stateData.items.length > 0) {
        stateData.items = stateData.items.map(item => {
            if (!item) return item;
            // Si ya tiene identidad de fila de Excel y no pidió cuenta nueva explícita -> renovación garantizada
            if (hasExcelAccountIdentity(item) && !explicitlyWantsNew) {
                return { ...item, isRenewal: true, type: 'renewal' };
            }
            // Si coincide con una cuenta activa del cliente (vencida o próxima a vencer <= 15 días) y no pidió cuenta nueva explícita -> vincular fila real de Excel como renovación
            if (!explicitlyWantsNew && userAccounts.length > 0 && item.isRenewal !== false) {
                const itemPlat = getItemPlatformName(item);
                const activeMatch = findMatchingActiveAccount(itemPlat, userAccounts);
                if (activeMatch) {
                    const daysRem = getDaysRemainingForAccount(activeMatch);
                    if (daysRem === null || daysRem <= 15 || stateData.isRenewal === true) {
                        return { ...activeMatch, ...item, rowNumber: activeMatch.rowNumber || activeMatch._rowNumber, correo: activeMatch.correo || activeMatch.Correo, isRenewal: true, type: 'renewal' };
                    }
                }
            }
            // De lo contrario es venta nueva: asegurar precio
            const pName = getItemPlatformName(item);
            const pPrice = item.price || (item.platform && item.platform.price) || (item.plan && item.plan.finalPrice) || (pName ? getPlatformPriceFromExcel(pName, platforms) : 0) || stateData.total || amount || 0;
            return { ...item, price: pPrice, isRenewal: Boolean(item.isRenewal), type: item.isRenewal ? 'renewal' : 'new_sale' };
        });

        const allRenewals = stateData.items.every(i => i && (i.isRenewal === true || i.type === 'renewal'));
        const anyRenewal = stateData.items.some(i => i && (i.isRenewal === true || i.type === 'renewal'));
        stateData.isRenewal = allRenewals;
        stateData.isNewSale = !anyRenewal;
        stateData.hasMixedCart = anyRenewal && !allRenewals;
    }

    return stateData;
}

module.exports = {
    resolvePaymentCartAndIntent,
    hasExcelAccountIdentity,
    findMatchingActiveAccount
};
