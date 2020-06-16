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

        const app = loadedModule.app;

        app.commandLine.appendSwitch('proxy-server', process.env.HTTP_PROXY);
        app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

        app.commandLine.appendSwitch(
            'ignore-certificate-errors-spki-list', params.spkiFingerprint
        );

        app.on('quit', () => {
            // This means the user has exited the app while HTTP Toolkit is still running. That's fine,
            // but it normally won't exit, since we still have a debugger attached. If we can, we use
            // the experimental node 8+ inspector API to disconnect it. If not, we just kill the process
            // after a brief delay to allow any other cleanup
            try {
                require('inspector').close();
            } catch (e) {
                console.log('Could not disconnect app via inspector, killing manually', e);
                setTimeout(() => process.exit(0), 1000);
            }
        });

        // Register a cert verifier for the default session, so that electron.net calls
        // can have their certificates manually verified.
        app.on('ready', () => {
            loadedModule.session.defaultSession.setCertificateVerifyProc((req, callback) => {
                if (
                    req.certificate &&
                    req.certificate.issuerCert &&
                    req.certificate.issuerCert.data === params.newlineEncodedCertData
                ) {
                    callback(0); // The cert is good, I promise
                } else {
                    callback(-3); // Fallback to Chromium's own opinion
                }
            });
        })

        // Also handle explicitly certificate errors from Electron in the standard way
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