/**
 * Injected into Electron via the debug protocol before any user code is run.
 */

// Wrap all normal node HTTP APIs
require('./prepend-node');

module.exports = function reconfigureElectron(params) {
    let electronWrapped = false;

    // Reconfigure electron slightly too
    const wrapModule = require('./wrap-require');
    wrapModule('electron', function wrapElectron (loadedModule) {
        if (
            electronWrapped ||
            !loadedModule.app ||
            !loadedModule.app.commandLine
        ) return;

        electronWrapped = true;

        console.log('wrapping');
        const app = loadedModule.app;

        app.commandLine.appendSwitch('proxy-server', process.env.HTTP_PROXY);
        app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

        app.commandLine.appendSwitch(
            'ignore-certificate-errors-spki-list', params.spkiFingerprint
        );

        app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
            if (
                certificate.issuerCert &&
                certificate.issuerCert.data === params.newlineEncodedCertData
            ) {
              event.preventDefault();
              callback(true);
            } else {
              callback(false);
            }
        });
    }, true);

    wrapModule('crypto', function wrapCrypto () {
        const NativeSecureContext = process.binding('crypto').SecureContext;
        const addRootCerts = NativeSecureContext.prototype.addRootCerts;
        NativeSecureContext.prototype.addRootCerts = function() {
            const ret = addRootCerts.apply(this,arguments);
            this.addCACert(params.newlineEncodedCertData);
            return ret;
        };
    }, true);
};