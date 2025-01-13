import * as path from 'path';
import * as fs from 'fs';
import envPaths from 'env-paths';
import { Mutex } from 'async-mutex';

import { delay, isErrorLike } from '@httptoolkit/util';
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

import updateCommand from '@oclif/plugin-update/lib/commands/update';

import { HttpToolkitServerApi } from './api/api-server';
import { checkBrowserConfig } from './browsers';
import { logError } from './error-tracking';
import { IS_PROD_BUILD, MOCKTTP_ALLOWED_ORIGINS } from './constants';

import { readFile, checkAccess, writeFile, ensureDirectoryExists } from './util/fs';

import { registerShutdownHandler, shutdown } from './shutdown';
import { getTimeToCertExpiry, parseCert } from './certificates';

import {
    startDockerInterceptionServices,
    stopDockerInterceptionServices
} from './interceptors/docker/docker-interception-services';
import { clearWebExtensionConfig, updateWebExtensionConfig } from './webextension';
import { HttpClient } from './client/http-client';

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
            writeFile(keyPath, newCertPair.key, {
                mode: 0o600 // Only readable for ourselves, nobody else
            })
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

let shutdownTimer: NodeJS.Timeout | undefined;

function manageBackgroundServices(
    standalone: PluggableAdmin.AdminServer<{
        http: MockttpAdminPlugin,
        webrtc: MockRTCAdminPlugin
    }>,
    httpsConfig: { certPath: string, certContent: string }
) {
    let activeSessions = 0;

    standalone.on('mock-session-started', async ({ http, webrtc }, sessionId) => {
        activeSessions += 1;
        if (shutdownTimer) {
            clearTimeout(shutdownTimer);
            shutdownTimer = undefined;
        }

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
        activeSessions -= 1;
        const httpProxyPort = http.getMockServer().port;

        stopDockerInterceptionServices(httpProxyPort, ruleParameters)
        .catch((error) => {
            console.log("Could not stop Docker components:", error);
        });

        clearWebExtensionConfig(httpProxyPort);

        // In some odd cases, the server can end up running even though all UIs & desktop have exited
        // completely. This can be problematic, as it leaves the server holding ports that HTTP Toolkit
        // needs, and blocks future startups. To avoid this, if no Mock sessions are running at all
        // for 10 minutes, the server shuts down automatically. Skipped for dev, where that might be OK.
        // This should catch even hard desktop shell crashes, as sessions shut down automatically if the
        // client websocket becomes non-responsive.
        // We skip this on Mac, where apps don't generally close when the last window closes.
        if (activeSessions <= 0 && IS_PROD_BUILD && process.platform !== 'darwin') {
            if (shutdownTimer) {
                clearTimeout(shutdownTimer);
                shutdownTimer = undefined;
            }

            // We do a two-step timer here: 1 minute then a logged warning, then 9 more minutes
            // until an automatic server shutdown:
            shutdownTimer = setTimeout(() => {
                if (activeSessions !== 0) return;
                console.log('Server is inactive, preparing for auto-shutdown...');

                shutdownTimer = setTimeout(() => {
                    if (activeSessions !== 0) return;
                    shutdown(99, '10 minutes inactive');
                }, 1000 * 60 * 9).unref();
            }, 1000 * 60 * 1).unref();
        }
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
        webrtc: MockRTCAdminPlugin
    }>({
        adminPlugins: {
            http: MockttpAdminPlugin,
            webrtc: MockRTCAdminPlugin
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
    const apiServer = new HttpToolkitServerApi(
        { configPath, authToken: options.authToken, https: httpsConfig },
        new HttpClient(ruleParameters),
        () => standalone.ruleParameterKeys
    );

    const updateMutex = new Mutex();
    apiServer.on('update-requested', () => {
        updateMutex.runExclusive(() =>
            (<Promise<void>> updateCommand.run(['stable']))
            .catch((error) => {
                if (isErrorLike(error)) {
                    // Did we receive a successful update, that wants to restart the server:
                    if (error.code === 'EEXIT') {
                        // Block future update checks for 6 hours.

                        // If we don't, we'll redownload the same update again every check.
                        // We don't want to block it completely though, in case this server
                        // stays open for a very long time.
                        return delay(1000 * 60 * 60 * 6, { unref: true });
                    }

                    if (error.code === 'EACCES') {
                        // We're running the server without write access to the update directory.
                        // Weird, but it happens and there's nothing we can do - ignore it.
                        console.log(`Update check failed: ${error.message}`);
                        return;
                    }

                    // Report any HTTP response errors cleanly & explicitly:
                    if (error.statusCode) {
                        let url: string | undefined;
                        if ('http' in error) {
                            const request = (error as any).http?.request;
                            url = `${request?.protocol}//${request?.host}${request?.path}`
                        }

                        logError(`Failed to check for updates due to ${error.statusCode} response ${
                            url
                                ? `from ${url}`
                                : 'from unknown URL'
                        }`);
                        return;
                    }
                }

                console.log(error.message);
                logError(`Failed to check for updates: ${error.message}`, { cause: error });
            })
        );
    });

    await apiServer.start();

    console.log('Server started in', Date.now() - standaloneSetupTime, 'ms');
    console.log('Total startup took', Date.now() - startTime, 'ms');
}