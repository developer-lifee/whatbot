const fs = require('fs');
const path = require('path');

const targetRoot = process.argv[2] || '/root/whatbot';

const chatPath = path.join(targetRoot, 'node_modules/whatsapp-web.js/src/structures/Chat.js');
const channelPath = path.join(targetRoot, 'node_modules/whatsapp-web.js/src/structures/Channel.js');

const patchCode = `                    const msgFindLocal = window.require(
                        'WAWebDBMessageFindLocal',
                    );
                    const WAWebMsgKey = window.require('WAWebMsgKey');
                    const MsgStore = window.require('WAWebCollections').Msg;

                    const findBefore = async (anchorKey, count) => {
                        if (
                            typeof msgFindLocal.msgFindByDirection ===
                            'function'
                        ) {
                            return await msgFindLocal.msgFindByDirection({
                                anchor: anchorKey,
                                count,
                                direction: 'before',
                            });
                        }
                        return await msgFindLocal.msgFindBefore({
                            anchor: anchorKey,
                            count,
                        });
                    };

                    const toMsgKey = (id) => {
                        if (!id) return null;
                        if (id instanceof WAWebMsgKey) return id;
                        const s =
                            typeof id === 'string'
                                ? id
                                : id._serialized || id?.toString?.();
                        return s ? WAWebMsgKey.fromString(s) : null;
                    };

                    const toMsgModels = (rawMessages) => {
                        const out = [];
                        for (const m of rawMessages) {
                            if (m && typeof m.serialize === 'function') {
                                out.push(m);
                                continue;
                            }
                            const serialized =
                                m?.id?._serialized ||
                                (typeof m === 'string' ? m : null);
                            let model =
                                (serialized && MsgStore.get(serialized)) ||
                                (m?.id &&
                                    MsgStore.get(m.id._serialized || m.id)) ||
                                null;
                            if (!model && m && MsgStore.modelClass) {
                                try {
                                    model = new MsgStore.modelClass(m);
                                } catch (e) {
                                    model = null;
                                }
                            }
                            if (model) out.push(model);
                        }
                        return out;
                    };

                    const dedupeByMsgId = (arr) => {
                        const seen = new Set();
                        return arr.filter((m) => {
                            const key = m.id?._serialized;
                            if (!key || seen.has(key)) return false;
                            seen.add(key);
                            return true;
                        });
                    };

                    const limit = searchOptions.limit;
                    const finite = Number.isFinite(limit);
                    const fromMeFilter =
                        searchOptions && searchOptions.fromMe !== undefined;`;

if (fs.existsSync(chatPath)) {
    let content = fs.readFileSync(chatPath, 'utf8');
    
    // Find the original loop in Chat.js
    const targetChat = `            if (searchOptions && searchOptions.limit > 0) {
                while (msgs.length < searchOptions.limit) {
                    const loadedMessages = await window.Store.ConversationMsgs.loadEarlierMsgs(chat,chat.msgs);
                    if (!loadedMessages || !loadedMessages.length) break;
                    msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                }
                
                if (msgs.length > searchOptions.limit) {
                    msgs.sort((a, b) => (a.t > b.t) ? 1 : -1);
                    msgs = msgs.splice(msgs.length - searchOptions.limit);
                }
            }`;

    // Also handle if already partially patched by our previous try-catch patch
    const partialTargetChat = `            if (searchOptions && searchOptions.limit > 0) {
                while (msgs.length < searchOptions.limit) {
                    let loadedMessages;
                    try {
                        loadedMessages = await window.Store.ConversationMsgs.loadEarlierMsgs(chat,chat.msgs);
                    } catch (e) {
                        break;
                    }
                    if (!loadedMessages || !loadedMessages.length) break;
                    msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                }
                
                if (msgs.length > searchOptions.limit) {
                    msgs.sort((a, b) => (a.t > b.t) ? 1 : -1);
                    msgs = msgs.splice(msgs.length - searchOptions.limit);
                }
            }`;

    const newChatLogic = `            if (searchOptions && searchOptions.limit > 0) {
${patchCode}

                    if (false) { // Bypassed for robustness
                        const anchorSerialized =
                            chat.lastReceivedKey?.toString();
                        if (!anchorSerialized) {
                            msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
                            msgs = msgs.slice(-Math.min(limit, msgs.length));
                        } else {
                            const fetchCount = Math.max(0, limit - 1);
                            const anchorKey = toMsgKey(anchorSerialized);
                            const result = await findBefore(
                                anchorKey,
                                fetchCount,
                            );
                            const rawMessages = Array.isArray(result)
                                ? result
                                : result?.messages || [];
                            if (
                                result?.status === 404 &&
                                (!rawMessages || !rawMessages.length)
                            ) {
                                msgs = [];
                            } else {
                                let loaded = toMsgModels(rawMessages);
                                const anchorMsg =
                                    MsgStore.get(anchorSerialized);
                                let merged = [
                                    ...loaded,
                                    ...(anchorMsg ? [anchorMsg] : []),
                                ];
                                merged = merged.filter(
                                    (m) => !m.isNotification,
                                );
                                merged.sort((a, b) => (a.t > b.t ? 1 : -1));
                                merged = dedupeByMsgId(merged);
                                msgs = merged.filter(msgFilter);
                                if (msgs.length > limit) {
                                    msgs = msgs.slice(-limit);
                                }
                            }
                        }
                    } else {
                        msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
                        const batchCap = finite ? limit : 100;
                        while (msgs.length < limit || !finite) {
                            const anchor =
                                msgs[0]?.id ||
                                chat.msgs.getModelsArray()[0]?.id ||
                                chat.lastReceivedKey;
                            if (!anchor) break;

                            const anchorKey = toMsgKey(anchor);
                            if (!anchorKey) break;

                            const need = finite
                                ? Math.min(batchCap, limit - msgs.length)
                                : batchCap;
                            if (need <= 0) break;

                            const result = await findBefore(anchorKey, need);
                            const rawMessages = Array.isArray(result)
                                ? result
                                : result?.messages || [];
                            if (result?.status === 404 || !rawMessages.length) {
                                break;
                            }

                            const loadedMessages = toMsgModels(rawMessages);
                            if (!loadedMessages.length) break;

                            const prevLen = msgs.length;
                            msgs = dedupeByMsgId([
                                ...loadedMessages.filter(msgFilter),
                                ...msgs,
                            ]);
                            msgs.sort((a, b) => (a.t > b.t ? 1 : -1));

                            if (msgs.length === prevLen) break;

                            if (!finite && loadedMessages.length < need) {
                                break;
                            }
                        }

                        if (finite && msgs.length > limit) {
                            msgs = msgs.slice(-limit);
                        }
                    }
            }`;

    if (content.includes(targetChat)) {
        content = content.replace(targetChat, newChatLogic);
        fs.writeFileSync(chatPath, content, 'utf8');
        console.log('Chat.js fully patched!');
    } else if (content.includes(partialTargetChat)) {
        content = content.replace(partialTargetChat, newChatLogic);
        fs.writeFileSync(chatPath, content, 'utf8');
        console.log('Chat.js fully patched from partial!');
    } else {
        console.log('Chat.js target logic not found or already patched.');
    }
}

if (fs.existsSync(channelPath)) {
    let content = fs.readFileSync(channelPath, 'utf8');
    const targetChannel = `            if (searchOptions && searchOptions.limit > 0) {
                while (msgs.length < searchOptions.limit) {
                    const loadedMessages = await window.Store.ConversationMsgs.loadEarlierMsgs(channel);
                    if (!loadedMessages || !loadedMessages.length) break;
                    msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                }
                
                if (msgs.length > searchOptions.limit) {
                    msgs.sort((a, b) => (a.t > b.t) ? 1 : -1);
                    msgs = msgs.splice(msgs.length - searchOptions.limit);
                }
            }`;

    const partialTargetChannel = `            if (searchOptions && searchOptions.limit > 0) {
                while (msgs.length < searchOptions.limit) {
                    let loadedMessages;
                    try {
                        loadedMessages = await window.Store.ConversationMsgs.loadEarlierMsgs(channel);
                    } catch (e) {
                        break;
                    }
                    if (!loadedMessages || !loadedMessages.length) break;
                    msgs = [...loadedMessages.filter(msgFilter), ...msgs];
                }
                
                if (msgs.length > searchOptions.limit) {
                    msgs.sort((a, b) => (a.t > b.t) ? 1 : -1);
                    msgs = msgs.splice(msgs.length - searchOptions.limit);
                }
            }`;

    const newChannelLogic = `            if (searchOptions && searchOptions.limit > 0) {
${patchCode}

                    if (!fromMeFilter && finite) {
                        const anchorSerialized =
                            channel.lastReceivedKey?.toString();
                        if (!anchorSerialized) {
                            msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
                            msgs = msgs.slice(-Math.min(limit, msgs.length));
                        } else {
                            const fetchCount = Math.max(0, limit - 1);
                            const anchorKey = toMsgKey(anchorSerialized);
                            const result = await findBefore(
                                anchorKey,
                                fetchCount,
                            );
                            const rawMessages = Array.isArray(result)
                                ? result
                                : result?.messages || [];
                            if (
                                result?.status === 404 &&
                                (!rawMessages || !rawMessages.length)
                            ) {
                                msgs = [];
                            } else {
                                let loaded = toMsgModels(rawMessages);
                                const anchorMsg =
                                    MsgStore.get(anchorSerialized);
                                let merged = [
                                    ...loaded,
                                    ...(anchorMsg ? [anchorMsg] : []),
                                ];
                                merged = merged.filter(
                                    (m) =>
                                        !m.isNotification &&
                                        m.type !== 'newsletter_notification',
                                );
                                merged.sort((a, b) => (a.t > b.t ? 1 : -1));
                                merged = dedupeByMsgId(merged);
                                msgs = merged.filter(msgFilter);
                                if (msgs.length > limit) {
                                    msgs = msgs.slice(-limit);
                                }
                            }
                        }
                    } else {
                        msgs.sort((a, b) => (a.t > b.t ? 1 : -1));
                        const batchCap = finite ? limit : 100;
                        while (msgs.length < limit || !finite) {
                            const anchor =
                                msgs[0]?.id ||
                                channel.msgs.getModelsArray()[0]?.id ||
                                channel.lastReceivedKey;
                            if (!anchor) break;

                            const anchorKey = toMsgKey(anchor);
                            if (!anchorKey) break;

                            const need = finite
                                ? Math.min(batchCap, limit - msgs.length)
                                : batchCap;
                            if (need <= 0) break;

                            const result = await findBefore(anchorKey, need);
                            const rawMessages = Array.isArray(result)
                                ? result
                                : result?.messages || [];
                            if (result?.status === 404 || !rawMessages.length) {
                                break;
                            }

                            const loadedMessages = toMsgModels(rawMessages);
                            if (!loadedMessages.length) break;

                            const prevLen = msgs.length;
                            msgs = dedupeByMsgId([
                                ...loadedMessages.filter(msgFilter),
                                ...msgs,
                            ]);
                            msgs.sort((a, b) => (a.t > b.t ? 1 : -1));

                            if (msgs.length === prevLen) break;

                            if (!finite && loadedMessages.length < need) {
                                break;
                            }
                        }

                        if (finite && msgs.length > limit) {
                            msgs = msgs.slice(-limit);
                        }
                    }
            }`;

    if (content.includes(targetChannel)) {
        content = content.replace(targetChannel, newChannelLogic);
        fs.writeFileSync(channelPath, content, 'utf8');
        console.log('Channel.js fully patched!');
    } else if (content.includes(partialTargetChannel)) {
        content = content.replace(partialTargetChannel, newChannelLogic);
        fs.writeFileSync(channelPath, content, 'utf8');
        console.log('Channel.js fully patched from partial!');
    } else {
        console.log('Channel.js target logic not found or already patched.');
    }
}
