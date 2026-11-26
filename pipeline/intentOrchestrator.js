/**
 * CAPA 2: Decisor Contextual Abierto.
 * Evalúa el turno con TODO el contexto reunido en Capa 1 y contempla explícitamente
 * escenarios imprevistos / no medidos (`unmeasured_open_case`) para evitar atajos ciegos.
 */
function orchestrateDecision(turnContext, detection = null) {
    const body = String(turnContext?.combinedBody || '').trim();
    const hasMedia = Boolean(turnContext?.hasMedia);
    const accounts = Array.isArray(turnContext?.accounts) ? turnContext.accounts : [];
    const intent = detection && detection.intent ? String(detection.intent).toLowerCase().trim() : null;
    const platform = detection && detection.detectedPlatform ? String(detection.detectedPlatform).trim() : null;
    const confidence = detection && detection.confidence !== undefined ? detection.confidence : null;

    const isPureSymbolsWithoutMedia = !hasMedia && body.length > 0 && /^[?¿!¡\s\-_.,*#@]+$/.test(body);

    // Señales de casos híbridos o atípicos que no deben ser forzados a un atajo cerrado
    const mentionsFamilyOrOtherOwner = /\b(mam[aá]|pap[aá]|hermano|hermana|espos[oa]|novi[oa]|familiar|otro n[uú]mero|a nombre de)\b/i.test(body);
    const mentionsProfileSelection = /\b(perfil|perfiles|cual|cu[aá]l|coger|cojer|elegir|escoger|candado|pantalla)\b/i.test(body);
    const asksOutsideOwnAccounts = Boolean(
        platform &&
        accounts.length > 0 &&
        !accounts.some(a => {
            const s = String(a.Streaming || a.streaming_platform || a.platform || '').toLowerCase();
            return s.includes(platform.toLowerCase()) || platform.toLowerCase().includes(s);
        })
    );

    // Escenario abierto / no medido: imagen con símbolos/pregunta, duda de perfil en cuenta familiar, o mezcla de señales
    if (
        (hasMedia && mentionsProfileSelection) ||
        (hasMedia && /^[?¿!¡\s\-_.,*#@]*$/.test(body)) ||
        (mentionsFamilyOrOtherOwner && (hasMedia || /c[oó]digo|perfil|hogar|cuenta/i.test(body))) ||
        (asksOutsideOwnAccounts && hasMedia)
    ) {
        const tag = mentionsFamilyOrOtherOwner
            ? 'shared_family_or_third_party_account'
            : (mentionsProfileSelection ? 'tv_profile_selection_visual' : 'visual_ambiguous_case');
        return {
            action: 'unmeasured_open_case',
            intent: intent || 'soporte',
            platform,
            confidence,
            isUnmeasuredScenario: true,
            unmeasuredTag: tag,
            isPureSymbolsWithoutMedia: false,
            reasoning: `Escenario abierto/no medido (${tag}) evaluado con contexto completo (media=${hasMedia}, cuentas=${accounts.length}).`
        };
    }

    if (intent === 'codigo' || intent === 'verificacion') {
        return {
            action: 'deliver_code',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: 'Solicitud directa de código/verificación.'
        };
    }

    if (intent === 'credenciales') {
        return {
            action: 'check_credentials',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: 'Consulta de credenciales o error de acceso.'
        };
    }

    if (intent === 'comprar' || intent === 'renovar') {
        return {
            action: 'purchase_or_renew',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: `Intención comercial (${intent}).`
        };
    }

    if (intent === 'pago') {
        return {
            action: 'validate_payment',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: 'Reporte o comprobante de pago.'
        };
    }

    if (intent === 'cancelar') {
        return {
            action: 'cancel_service',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: 'Solicitud de cancelación/corte.'
        };
    }

    if (intent === 'asesor') {
        return {
            action: 'escalate_human',
            intent,
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: 'Cliente pidió explícitamente atención humana.'
        };
    }

    if (intent === 'soporte' || hasMedia) {
        return {
            action: 'support_media_or_text',
            intent: intent || 'soporte',
            platform,
            confidence,
            isUnmeasuredScenario: false,
            unmeasuredTag: null,
            isPureSymbolsWithoutMedia: false,
            reasoning: hasMedia ? 'Soporte con archivo multimedia adjunto.' : 'Consulta técnica o de soporte.'
        };
    }

    // Cualquier otra consulta que no encaje en un flujo rígido pasa como caso abierto contextual
    return {
        action: 'unmeasured_open_case',
        intent: intent || 'general',
        platform,
        confidence,
        isUnmeasuredScenario: !isPureSymbolsWithoutMedia,
        unmeasuredTag: isPureSymbolsWithoutMedia ? 'pure_symbols_no_media' : 'open_conversational_query',
        isPureSymbolsWithoutMedia,
        reasoning: isPureSymbolsWithoutMedia
            ? 'Solo signos/símbolos sin imagen adjunta.'
            : 'Consulta abierta sin flujo rígido; delegada a IA con contexto completo.'
    };
}

module.exports = {
    orchestrateDecision
};
