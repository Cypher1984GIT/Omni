
// Preload script to disable physical hardware keys (WebAuthn) and force App-based 2FA fallback.
// This runs before the web page loads.

try {
    console.log('Preload: Disabling WebAuthn and Webdriver...');

    // 1. Disable WebAuthn (Security Keys / Passkeys)
    // We mock the credentials API to forcing it to fail immediately, 
    // prompting the site to try the next method (App 2FA).

    // Always mock it, effectively overwriting successful usage.
    const mockCredentials = {
        create: (options) => {
            console.log('Intercepted navigator.credentials.create', options);
            // Return a promise that rejects immediately with 'NotAllowedError'
            // This mimics the user clicking "Cancel" in the browser dialog.
            return Promise.reject(new DOMException("The operation is not allowed.", "NotAllowedError"));
        },
        get: (options) => {
            console.log('Intercepted navigator.credentials.get', options);
            // Return a promise that rejects immediately with 'NotAllowedError'
            return Promise.reject(new DOMException("The operation is not allowed.", "NotAllowedError"));
        },
        preventSilentAccess: () => Promise.resolve(),
        store: () => Promise.resolve()
    };

    // Nuke the existing one and replace it
    try {
        // In some browsers/contexts this might be read-only, so we try defineProperty
        Object.defineProperty(navigator, 'credentials', {
            value: mockCredentials,
            writable: false,
            configurable: false
        });
    } catch (err) {
        console.error('Failed to redefine navigator.credentials:', err);
        // Fallback: try to overwrite execution on the prototype if possible (less likely to work on secure context)
    }

    // 2. Disable Hardware APIs (WebUSB, WebHID, WebBluetooth)
    // These are often used for direct token communication
    ['usb', 'hid', 'bluetooth'].forEach(api => {
        try {
            if (navigator[api] || api in navigator) {
                Object.defineProperty(navigator, api, { get: () => undefined });
            }
        } catch (e) { }
    });

    // 3. Bot Evasion
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) { }
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) { }
    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) { }

    // 4. Overwrite potential key-check variables/Polyfills
    window.PublicKeyCredential = undefined;

    console.log('Preload: WebAuthn blocked.');

} catch (e) {
    console.error('Preload injection error:', e);
}
