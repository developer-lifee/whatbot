const fs = require('fs');
const path = require('path');

const wwebjsRoot = fs.existsSync('/root/whatbot/node_modules/whatsapp-web.js')
    ? '/root/whatbot/node_modules/whatsapp-web.js'
    : path.join(__dirname, 'node_modules', 'whatsapp-web.js');

const authStorePath = path.join(wwebjsRoot, 'src/util/Injected/AuthStore/AuthStore.js');
let authStoreContent = fs.readFileSync(authStorePath, 'utf8');
authStoreContent = authStoreContent.replace(
    /window\.AuthStore\.AppState = .*/,
    "window.AuthStore.AppState = (window.require && typeof window.require === 'function' && window.require('WAWebSocketModel')) ? window.require('WAWebSocketModel').Socket : null;"
);
fs.writeFileSync(authStorePath, authStoreContent);
console.log('AuthStore.js patched');

const clientPath = path.join(wwebjsRoot, 'src/Client.js');
let clientContent = fs.readFileSync(clientPath, 'utf8');

const target1 = `        if (isCometOrAbove) {
            await this.pupPage.evaluate(ExposeAuthStore);`;

const repl1 = `        if (isCometOrAbove) {
            let asStart = Date.now();
            while (asStart > (Date.now() - timeout)) {
                const ready = await this.pupPage.evaluate(() => {
                    return typeof window.require === 'function' &&
                           !!window.require('WAWebSocketModel')?.Socket &&
                           !!window.require('WAWebConnModel')?.Conn;
                }).catch(() => false);
                if (ready) break;
                await new Promise(r => setTimeout(r, 200));
            }
            await this.pupPage.evaluate(ExposeAuthStore);`;

if (clientContent.includes(target1)) {
    clientContent = clientContent.replace(target1, repl1);
    console.log('Client.js target1 patched');
} else {
    console.log('Client.js target1 NOT found (already patched?)');
}

const target2 = `        await this.pupPage.evaluate(() => {
            window.AuthStore.AppState.on('change:state', (_AppState, state) => { window.onAuthAppStateChangedEvent(state); });
            window.AuthStore.AppState.on('change:hasSynced', () => { window.onAppStateHasSyncedEvent(); });
            window.AuthStore.Cmd.on('offline_progress_update', () => {
                window.onOfflineProgressUpdateEvent(window.AuthStore.OfflineMessageHandler.getOfflineDeliveryProgress()); 
            });
            window.AuthStore.Cmd.on('logout', async () => {
                await window.onLogoutEvent();
            });
        });`;

const repl2 = `        await this.pupPage.evaluate(() => {
            const appState = window.AuthStore && window.AuthStore.AppState;
            if (appState && typeof appState.on === 'function') {
                if (appState.hasSynced) {
                    window.onAppStateHasSyncedEvent();
                }
                appState.on('change:state', (_AppState, state) => { window.onAuthAppStateChangedEvent(state); });
                appState.on('change:hasSynced', (_AppState, hasSynced) => { if (hasSynced) window.onAppStateHasSyncedEvent(); });
            }
            const cmd = window.AuthStore && window.AuthStore.Cmd;
            if (cmd && typeof cmd.on === 'function') {
                cmd.on('offline_progress_update', () => {
                    window.onOfflineProgressUpdateEvent(window.AuthStore.OfflineMessageHandler?.getOfflineDeliveryProgress?.()); 
                });
                cmd.on('logout', async () => {
                    await window.onLogoutEvent();
                });
            }
        });`;

if (clientContent.includes(target2)) {
    clientContent = clientContent.replace(target2, repl2);
    console.log('Client.js target2 patched');
} else {
    console.log('Client.js target2 NOT found (already patched?)');
}

fs.writeFileSync(clientPath, clientContent);

// 3. Patch Message.js for downloadMedia() and LID / $1 ID resolution
const messagePath = path.join(wwebjsRoot, 'src/structures/Message.js');

if (fs.existsSync(messagePath)) {
    let msgContent = fs.readFileSync(messagePath, 'utf8');

    // Patch 3A: ID normalization in _patch(data)
    const patchIdTarget = `        this.id = data.id;\n\n        /**`;
    const patchIdRepl = `        this.id = data.id;\n        if (this.id && !this.id._serialized && this.id.$1) {\n            this.id._serialized = this.id.$1;\n        }\n\n        /**`;
    if (msgContent.includes(patchIdTarget)) {
        msgContent = msgContent.replace(patchIdTarget, patchIdRepl);
        console.log('Message.js: ID normalization patched');
    } else {
        console.log('Message.js: ID normalization already present or target not matched');
    }

    // Patch 3B: Robust downloadMedia with LID lookup and active wait for RESOLVED
    const oldDownloadMediaRegex = /async downloadMedia\(\) \{[\s\S]*?if \(!result\) return undefined;\s*return new MessageMedia\(result\.mimetype, result\.data, result\.filename, result\.filesize\);\s*\}/;

    const newDownloadMedia = `async downloadMedia() {
        if (!this.hasMedia) {
            return undefined;
        }

        const idInfo = {
            serialized: this.id ? (this.id._serialized || this.id.$1) : null,
            dollar1: this.id ? this.id.$1 : null,
            id: this.id ? this.id.id : null
        };

        const result = await this.client.pupPage.evaluate(async (idInfo) => {
            const rawMsgId = (typeof idInfo === 'string') ? idInfo : (idInfo?.serialized || idInfo?.dollar1 || idInfo?.id);
            let msg = window.Store.Msg.get(rawMsgId);

            if (!msg && idInfo?.dollar1) {
                msg = window.Store.Msg.get(idInfo.dollar1);
            }

            if (!msg && window.Store.Msg.getMessagesById && rawMsgId) {
                try {
                    const res = await window.Store.Msg.getMessagesById([rawMsgId]);
                    msg = res?.messages?.[0];
                } catch (e) {}
            }

            if (!msg && idInfo?.id) {
                const models = window.Store.Msg.getModelsArray ? window.Store.Msg.getModelsArray() : (window.Store.Msg.models || []);
                msg = models.find(m => {
                    if (!m || !m.id) return false;
                    return m.id.id === idInfo.id ||
                           m.id._serialized === idInfo.serialized ||
                           m.id.$1 === idInfo.dollar1 ||
                           m.id._serialized === idInfo.dollar1;
                });
            }

            if (!msg || !msg.mediaData || msg.mediaData.mediaStage === 'REUPLOADING') {
                return null;
            }

            if (msg.mediaData.mediaStage !== 'RESOLVED') {
                try {
                    await msg.downloadMedia({
                        downloadEvenIfExpensive: true,
                        rmrReason: 1
                    });
                } catch (e) {}

                // Active wait for mediaStage to transition from FETCHING to RESOLVED
                const startTime = Date.now();
                while (msg.mediaData && msg.mediaData.mediaStage !== 'RESOLVED' && (Date.now() - startTime) < 15000) {
                    if (msg.mediaData.mediaStage && msg.mediaData.mediaStage.includes('ERROR')) {
                        break;
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
            }

            if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
                return undefined;
            }

            try {
                const mockQpl = {
                    addAnnotations: function() { return this; },
                    addPoint: function() { return this; }
                };
                const decryptedMedia = await window.Store.DownloadManager.downloadAndMaybeDecrypt({
                    directPath: msg.directPath,
                    encFilehash: msg.encFilehash,
                    filehash: msg.filehash,
                    mediaKey: msg.mediaKey,
                    mediaKeyTimestamp: msg.mediaKeyTimestamp,
                    type: msg.type,
                    signal: (new AbortController).signal,
                    downloadQpl: mockQpl
                });

                const data = await (window.WWebJS.arrayBufferToBase64Async ? 
                    window.WWebJS.arrayBufferToBase64Async(decryptedMedia) : 
                    window.WWebJS.arrayBufferToBase64(decryptedMedia));

                return {
                    data,
                    mimetype: msg.mimetype,
                    filename: msg.filename,
                    filesize: msg.size
                };
            } catch (e) {
                if(e.status && e.status === 404) return undefined;
                throw e;
            }
        }, idInfo);

        if (!result) return undefined;
        return new MessageMedia(result.mimetype, result.data, result.filename, result.filesize);
    }`;

    if (oldDownloadMediaRegex.test(msgContent)) {
        msgContent = msgContent.replace(oldDownloadMediaRegex, newDownloadMedia);
        console.log('Message.js: downloadMedia patched successfully');
        fs.writeFileSync(messagePath, msgContent);
    } else {
        console.log('Message.js: old downloadMedia not matched (already patched?)');
    }
}

console.log('Done!');

