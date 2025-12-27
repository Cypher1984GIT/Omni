const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');

// Fix for Google Sign-In "This browser or app may not be secure"
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('ignore-certificate-errors');

// FORCE DISABLE WEBAUTHN - REVERTED to avoid crashing sites that expect the API.
// We will handle this via preload.js mocking.
// app.commandLine.appendSwitch('disable-features', 'WebAuthentication');

// Global handler to ensure all created web contents (including popups) have a clean User Agent
app.on('web-contents-created', (event, contents) => {
    // Modify User Agent to look like a standard browser (remove Electron reference)
    // Unified User Agent for all windows/popups to match Client Hints and prevent fingerprinting mismatches
    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    contents.setUserAgent(userAgent);

    // Inject anti-bot evasion scripts as early as possible
    const antiBotScript = `
        try {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            delete navigator.credentials; // Force fallback to non-Passkey auth
        } catch(e) {}
    `;

    contents.executeJavaScript(antiBotScript).catch(() => { });
    contents.on('did-start-loading', () => {
        contents.executeJavaScript(antiBotScript).catch(() => { });
    });

    // Apply header stripping handling for any new session that might be created
    // (Note: Usually popups share the parent session, but if a new session is created, we want to cover it)
    // We only attach if it hasn't been attached, but webRequest handlers are per session.
    // It's safer to rely on the parent session logic for known AIs, but generic popups might need attention if they drift.
    // For now, the UA fix is the critical one for 2FA popups.
});

let win;
let views = {};
let headerHeight = 70;
let footerHeight = 24;

function createWindow() {
    win = new BrowserWindow({
        width: 1300,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        icon: path.join(__dirname, 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile('index.html');
    win.maximize();

    // Redimensionar la IA activa cuando se cambia el tamaño de la ventana
    win.on('resize', () => {
        const activeView = win.getBrowserView();
        if (activeView) {
            const bounds = win.getBounds();
            activeView.setBounds({ x: 0, y: headerHeight, width: bounds.width, height: bounds.height - headerHeight - footerHeight });
        }
    });
}

ipcMain.on('update-layout', (event, { headerHeight: h, footerHeight: f }) => {
    headerHeight = h;
    footerHeight = f;
    const activeView = win.getBrowserView();
    if (activeView) {
        const bounds = win.getBounds();
        activeView.setBounds({ x: 0, y: headerHeight, width: bounds.width, height: bounds.height - headerHeight - footerHeight });
    }
});

ipcMain.on('add-ai', (event, { id, url }) => {
    // partition: 'persist:id' asegura que el login se guarde en disco
    const view = new BrowserView({
        webPreferences: {
            partition: `persist:${id}`, // Fixed: removed trailing space
            preload: path.join(__dirname, 'preload.js') // Inject protection script
        }
    });

    views[id] = view;
    win.setBrowserView(view);

    const bounds = win.getBounds();
    view.setBounds({ x: 0, y: headerHeight, width: bounds.width, height: bounds.height - headerHeight - footerHeight });

    // FIX 1: Robust User Agent & Client Hints Spoofing
    // Use a fixed, modern Chrome User Agent for consistency (should match global handler)
    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    view.webContents.setUserAgent(userAgent);

    view.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = details.requestHeaders;

        // Spoof Client Hints to match the User Agent perfectly
        requestHeaders['sec-ch-ua'] = '"Not?A_Brand";v="99", "Chromium";v="130", "Google Chrome";v="130"';
        requestHeaders['sec-ch-ua-mobile'] = '?0';
        requestHeaders['sec-ch-ua-platform'] = '"Linux"';

        callback({ cancel: false, requestHeaders });
    });

    // FIX 2: Strip CSP/Frame/Cross-Origin headers AND Allow Permissions
    view.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(true); // Allow all permissions
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
        console.log('Popup requested:', url);
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                // parent: win, // REMOVED: Detach from parent to ensure visibility on all WMs
                width: 600,
                height: 700,
                center: true,
                alwaysOnTop: true, // Force it to be seen
                autoHideMenuBar: true,
                webPreferences: {
                    partition: `persist:${id}`, // Ensure session sharing
                    preload: path.join(__dirname, 'preload.js'),
                    nodeIntegration: false,
                    contextIsolation: true
                }
            }
        };
    });

    // Ensure we set the UA for popups too and FORCE SHOW
    view.webContents.on('did-create-window', (window) => {
        console.log('Popup created');
        window.webContents.setUserAgent(userAgent);
        window.show(); // Verify visibility
    });



    view.webContents.loadURL(url);

    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        // -3 is ERR_ABORTED (happens on user stop or new nav), we ignore it
        if (errorCode !== -3) {
            view.webContents.loadFile('error.html', { query: { url: validatedURL } });
        }
    });

    view.webContents.on('did-finish-load', async () => {
        try {
            const pageText = await view.webContents.executeJavaScript('document.body.innerText');
            if (pageText && (pageText.includes('Sorry, you have been blocked') || pageText.includes('You are unable to access copilot.microsoft.com'))) {
                view.webContents.loadFile('error.html', { query: { url: view.webContents.getURL() } });
            }
        } catch (e) {
            console.error('Error checking page content:', e);
        }
    });

    // Track loading state
    view.webContents.on('did-start-loading', () => {
        if (win) win.webContents.send('ai-loading-status', { id, isLoading: true });
    });
    view.webContents.on('did-stop-loading', () => {
        if (win) win.webContents.send('ai-loading-status', { id, isLoading: false });
    });
});

ipcMain.on('switch-tab', (event, id) => {
    if (views[id]) {
        const bounds = win.getBounds();
        views[id].setBounds({ x: 0, y: headerHeight, width: bounds.width, height: bounds.height - headerHeight - footerHeight });
        win.setBrowserView(views[id]);
    }
});

ipcMain.on('remove-ai', (event, id) => {
    if (views[id]) {
        // Si la vista que se borra es la actual, la quitamos de la ventana
        if (win.getBrowserView() === views[id]) {
            win.setBrowserView(null);
        }
        // Destruimos la vista para liberar memoria
        // (Nota: BrowserView.destroy() no es un método oficial documentado en todas las versiones, 
        // perowebContents.destroy() sí, o simplemente dejar que GC actúe al quitar referencias. 
        // Lo más seguro en Electron moderno es simplemente setBrowserView(null) y borrar referencia)

        // Un método explícito para asegurar limpieza si existe destroy:
        if (typeof views[id].destroy === 'function') {
            views[id].destroy();
        } else if (views[id].webContents) {
            // views[id].webContents.destroy(); // A veces causa crash si no se maneja con cuidado
        }

        delete views[id];
    }
});

ipcMain.on('reload-ai', (event, id) => {
    if (views[id]) {
        views[id].webContents.reload();
    }
});

ipcMain.on('reload-all-ais', () => {
    Object.values(views).forEach(view => {
        view.webContents.reload();
    });
});

ipcMain.on('hide-current-view', () => {
    win.setBrowserView(null);
});

ipcMain.on('show-current-view', (event, id) => {
    if (views[id]) {
        const bounds = win.getBounds();
        views[id].setBounds({ x: 0, y: headerHeight, width: bounds.width, height: bounds.height - headerHeight - footerHeight });
        win.setBrowserView(views[id]);
    }
});


app.whenReady().then(createWindow);