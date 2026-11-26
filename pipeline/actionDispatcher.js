const { recordDecisionTrace } = require('./decisionTraceService');

/**
 * CAPA 3: Despachador modular de respuestas abiertas/soporte con trazabilidad completa.
 */
async function dispatchOpenOrSupportTurn({
    turnContext,
    decision,
    message,
    userId,
    userStates,
    generateEmpatheticFallback,
    safeReply = null,
    precomputedDesc = null,
    branch = 'open_support',
    sendReply = true
}) {
    const extraContext = {
        siblingProfilesText: turnContext.siblingProfilesText || '',
        unmeasuredTag: decision?.unmeasuredTag || null,
        isUnmeasuredScenario: Boolean(decision?.isUnmeasuredScenario)
    };

    const primaryMedia = turnContext.mediaList && turnContext.mediaList.length > 0 ? turnContext.mediaList[0] : null;

    const fallbackResult = await generateEmpatheticFallback(
        turnContext.combinedBody || '',
        turnContext.hasMedia,
        turnContext.chatHistory || '',
        primaryMedia,
        turnContext.accounts || [],
        userId,
        userStates,
        precomputedDesc,
        extraContext
    );

    const silent = Boolean(fallbackResult && typeof fallbackResult === 'object' && fallbackResult.silent === true);
    const replyMessage = typeof fallbackResult === 'string'
        ? fallbackResult
        : (fallbackResult?.replyMessage || '');
    const needsEscalation = Boolean(typeof fallbackResult === 'object' && fallbackResult?.needsEscalation);

    if (sendReply && !silent && replyMessage && replyMessage.replace(/🤖|👍|👋|\s/g, '').length >= 3) {
        if (typeof safeReply === 'function') {
            await safeReply(message, replyMessage, userId);
        } else if (message && typeof message.reply === 'function') {
            await message.reply(replyMessage);
        }
    }

    const trace = recordDecisionTrace({
        phone: turnContext.realPhone || userId,
        userId,
        clientName: turnContext.foundName || '',
        layer1: {
            combinedBodyPreview: turnContext.combinedBody,
            hasMedia: turnContext.hasMedia,
            mediaCount: turnContext.mediaList ? turnContext.mediaList.length : 0,
            accountsCount: turnContext.accounts ? turnContext.accounts.length : 0,
            platforms: (turnContext.accounts || []).map(a => a.Streaming || a.platform || '?'),
            siblingAccountsCount: turnContext.siblingAccountsCount || 0,
            previousState: turnContext.previousState
        },
        layer2: decision || {},
        layer3: {
            handler: 'actionDispatcher',
            branch,
            escalated: needsEscalation,
            replyPreview: silent ? '[SILENCED_BY_ADVISOR_RULE]' : replyMessage
        },
        finalReply: replyMessage,
        needsEscalation,
        durationMs: Date.now() - (turnContext.startedAt || Date.now())
    });

    return {
        replyMessage,
        needsEscalation,
        silent,
        trace
    };
}

module.exports = {
    dispatchOpenOrSupportTurn
};
