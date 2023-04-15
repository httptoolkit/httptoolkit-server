import * as path from 'path';
import * as fs from 'fs';
import envPaths from 'env-paths';
import { Mutex } from 'async-mutex';

import {
    PluggableAdmin,
    generateCACertificate
} from 'mockttp';
import {
    MockttpAdminPlugin
} from 'mockttp/dist/pluggable-admin-api/mockttp-pluggable-admin';
import {
    MockRTCAdminPlugin
} from 'mockrtc';
import {
    MockSecurityCheckAdminPlugin
} from 'mocksecurity-check';

import updateCommand from '@oclif/plugin-update/lib/commands/update';

import { HttpToolkitServerApi } from './api-server';
import { checkBrowserConfig } from './browsers';
import { reportError } from './error-tracking';
import { MOCKTTP_ALLOWED_ORIGINS } from './constants';

import { delay } from './util/promise';
import { isErrorLike } from './util/error';
import { readFile, checkAccess, writeFile, ensureDirectoryExists } from './util/fs';

import { registerShutdownHandler } from './shutdown';
import { getTimeToCertExpiry, parseCert } from './certificates';

import {
    startDockerInterceptionServices,
    stopDockerInterceptionServices
} from './interceptors/docker/docker-interception-services';
import { clearWebExtensionConfig, updateWebExtensionConfig } from './webextension';

const APP_NAME = "HTTP Toolkit";

async function generateHTTPSConfig(configPath: string) {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const [ certContent ] = await Promise.all([
        readFile(certPath, 'utf8').then((certContent) => {
            checkCertExpiry(certContent);
            return certContent;
        }),
        checkAccess(keyPath, fs.constants.R_OK),
    ]).catch(async () => {
        // Cert doesn't exist, or is too close/past expiry. Generate a new one:

        const newCertPair = await generateCACertificate({
            commonName: APP_NAME + ' CA',
            organizationName: APP_NAME + ' CA'
        });

        return Promise.all([
            writeFile(certPath, newCertPair.cert).then(() => newCertPair.cert),
            writeFile(keyPath, newCertPair.key)
        ]);
    });

    return {
        keyPath,
        certPath,
        certContent,
        keyLength: 2048 // Reasonably secure keys please
    };
}

function checkCertExpiry(certContents: string): void {
    const remainingLifetime = getTimeToCertExpiry(parseCert(certContents));
    if (remainingLifetime < 1000 * 60 * 60 * 48) { // Next two days
        console.warn('Certificate expires soon - it must be regenerated');
        throw new Error('Certificate regeneration required');
    }
}

function manageBackgroundServices(
    standalone: PluggableAdmin.AdminServer<{
        http: MockttpAdminPlugin,
        webrtc: MockRTCAdminPlugin
    }>,
    httpsConfig: { certPath: string, certContent: string }
) {
    standalone.on('mock-session-started', async ({ http, webrtc }, sessionId) => {
        const httpProxyPort = http.getMockServer().port;

        console.log(`Mock session started, http on port ${
            httpProxyPort
        }, webrtc ${
            !!webrtc ? 'enabled' : 'disabled'
        }`);

        startDockerInterceptionServices(httpProxyPort, httpsConfig, ruleParameters)
        .catch((error) => {
            console.log("Could not start Docker components:", error);
        });

        updateWebExtensionConfig(sessionId, httpProxyPort, !!webrtc)
        .catch((error) => {
            console.log("Could not update WebRTC config:", error);
        });
    });

    standalone.on('mock-session-stopping', ({ http }) => {
        const httpProxyPort = http.getMockServer().port;

        stopDockerInterceptionServices(httpProxyPort, ruleParameters)
        .catch((error) => {
            console.log("Could not stop Docker components:", error);
        });

        clearWebExtensionConfig(httpProxyPort);
    });
}

// A map of rule parameters, which may be referenced by the UI, to pass configuration
// set here directly within the Node process to Mockttp (e.g. to set callbacks etc that
// can't be transferred through the API or which need access to server internals).
// This is a constant but mutable dictionary, which will be modified as the appropriate
// parameters change. Mockttp reads from the dictionary each time rules are configured.
const ruleParameters: { [key: string]: any } = {};

export async function runHTK(options: {
    configPath?: string
    authToken?: string
} = {}) {
    const startTime = Date.now();
    registerShutdownHandler();

    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);
    await checkBrowserConfig(configPath);

    const configCheckTime = Date.now();
    console.log('Config checked in', configCheckTime - startTime, 'ms');

    const httpsConfig = await generateHTTPSConfig(configPath);

    const certSetupTime = Date.now();
    console.log('Certificates setup in', certSetupTime - configCheckTime, 'ms');

    // Start a Mockttp standalone server
    const standalone = new PluggableAdmin.AdminServer<{
        http: MockttpAdminPlugin,
        webrtc: MockRTCAdminPlugin,
        securityCheck: MockSecurityCheckAdminPlugin
    }>({
        adminPlugins: {
            http: MockttpAdminPlugin,
            webrtc: MockRTCAdminPlugin,
            securityCheck: MockSecurityCheckAdminPlugin,
        },
        pluginDefaults: {
            http: {
                options: {
                    cors: false, // Don't add mocked CORS responses to intercepted traffic
                    recordTraffic: false, // Don't persist traffic here (keep it in the UI)
                    https: httpsConfig // Use our HTTPS config for HTTPS MITMs.
                }
            },
            webrtc: {
                recordMessages: false // Don't persist WebRTC traffic server-side either.
            }
        },
        corsOptions: {
            strict: true, // For the standalone admin API, require valid CORS headers
            origin: MOCKTTP_ALLOWED_ORIGINS, // Only allow mock admin control from our origins
            maxAge: 86400, // Cache CORS responses for as long as possible
            allowPrivateNetworkAccess: true // Allow access from non-local domains in Chrome 102+
        },
        webSocketKeepAlive: 20000, // Send a keep-alive ping to Mockttp clients every minute
        ruleParameters // Rule parameter dictionary
    });

    manageBackgroundServices(standalone, httpsConfig);

    await standalone.start({
        port: 45456,
        host: '127.0.0.1'
    });

    const standaloneSetupTime = Date.now();
    console.log('Standalone server started in', standaloneSetupTime - certSetupTime, 'ms');

    // Start the HTK server API
    const apiServer = new HttpToolkitServerApi({
        configPath,
        authToken: options.authToken,
        https: httpsConfig
    }, () => standalone.ruleParameterKeys);

    const updateMutex = new Mutex();
    apiServer.on('update-requested', () => {
        updateMutex.runExclusive(() =>
            (<Promise<void>> updateCommand.run(['stable']))
            .catch((error) => {
                // Received successful update that wants to restart the server
                if (isErrorLike(error) && error.code === 'EEXIT') {
                    // Block future update checks for one hour.

                    // If we don't, we'll redownload the same update again every check.
                    // We don't want to block it completely though, in case this server
                    // stays open for a very long time.
                    return delay(1000 * 60 * 60);
                }

                console.log(error);
                reportError('Failed to check for updates');
            })
        );
    });

    await apiServer.start();

    console.log('Server started in', Date.now() - standaloneSetupTime, 'ms');
    console.log('Total startup took', Date.now() - startTime, 'ms');
}