const express = require('express');

async function inspectStoreAndTestSend() {
    try {
        const client = global.client;
        if (!client || !client.pupPage) {
            console.log('CLIENT_NOT_READY');
            process.exit(1);
        }

        const result = await client.pupPage.evaluate(async () => {
            const info = {
                hasStore: typeof window.Store !== 'undefined',
                sendMessageKeys: window.Store && window.Store.SendMessage ? Object.keys(window.Store.SendMessage) : [],
                sendTextMsgToChat: typeof window.Store?.SendTextMsgToChat,
                sendTextMsgToChatAction: !!window.require?.('WAWebSendMsgToChatAction'),
                findOrCreateChat: !!window.require?.('WAWebFindOrCreateChat')
            };

            try {
                const SendMsgAction = window.require('WAWebSendMsgToChatAction');
                info.SendMsgActionKeys = Object.keys(SendMsgAction || {});
            } catch (e) {
                info.SendMsgActionErr = e.message;
            }

            try {
                const FindOrCreate = window.require('WAWebFindOrCreateChat');
                info.FindOrCreateKeys = Object.keys(FindOrCreate || {});
            } catch (e) {
                info.FindOrCreateErr = e.message;
            }

            return info;
        });

        console.log('STORE_INSPECTION_RESULT:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('INSPECTION_ERROR:', err.message);
    }
}

inspectStoreAndTestSend();
