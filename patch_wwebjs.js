const fs = require('fs');

const authStorePath = '/root/whatbot/node_modules/whatsapp-web.js/src/util/Injected/AuthStore/AuthStore.js';
let authStoreContent = fs.readFileSync(authStorePath, 'utf8');
authStoreContent = authStoreContent.replace(
    /window\.AuthStore\.AppState = .*/,
    "window.AuthStore.AppState = (window.require && typeof window.require === 'function' && window.require('WAWebSocketModel')) ? window.require('WAWebSocketModel').Socket : null;"
);
fs.writeFileSync(authStorePath, authStoreContent);
console.log('AuthStore.js patched');

const clientPath = '/root/whatbot/node_modules/whatsapp-web.js/src/Client.js';
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
console.log('Done!');
