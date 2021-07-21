import * as _ from 'lodash';
import * as os from 'os';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { generateSPKIFingerprint } from 'mockttp';

import { reportError } from '../../error-tracking';
import { delay } from '../../util';
import {
    ANDROID_TEMP,
    createAdbClient,
    getConnectedDevices,
    getRootCommand,
    pushFile,
    injectSystemCertificate,
    stringAsStream,
    hasCertInstalled,
    bringToFront
} from './adb-commands';
import { streamLatestApk, clearAllApks } from './fetch-apk';
import { parseCert, getCertificateFingerprint, getCertificateSubjectHash } from '../../certificates';

function urlSafeBase64(content: string) {
    return Buffer.from(content, 'utf8').toString('base64')
        .replace('+', '-')
        .replace('/', '_');
}

export class AndroidAdbInterceptor implements Interceptor {
    readonly id = 'android-adb';
    readonly version = '1.0.0';

    private readonly deviceProxyMapping: {
        [port: string]: string[]
    } = {};

    private adbClient = createAdbClient();

    constructor(
        private config: HtkConfig
    ) { }

    async isActivable(): Promise<boolean> {
        return (await getConnectedDevices(this.adbClient)).length > 0;
    }

    activableTimeout = 3000; // Increase timeout for device detection slightly

    isActive(): boolean {
        return false;
    }

    async getMetadata(): Promise<{ deviceIds: string[] }> {
        return {
            deviceIds: await getConnectedDevices(this.adbClient)
        };
    }

    async activate(proxyPort: number, options: {
        deviceId: string
    }): Promise<void | {}> {
        await this.injectSystemCertIfPossible(options.deviceId, this.config.https.certContent);

        if (!(await this.adbClient.isInstalled(options.deviceId, 'tech.httptoolkit.android.v1'))) {
            console.log("App not installed, installing...");
            try {
                await this.adbClient.install(options.deviceId, await streamLatestApk(this.config));
            } catch (e) {
                console.log("Resetting & retrying APK install, after initial failure:", e);
                // This can fail due to connection issues (with the device or while downloading
                // the APK) due to a corrupted APK. Reset the APKs and try again, just in case.
                await clearAllApks(this.config);
                await this.adbClient.install(options.deviceId, await streamLatestApk(this.config));
            }
            console.log("App installed successfully");

            await delay(200); // Add a little delay, to ensure intent URL is registered before we use it
        }

        // Now that the app is installed, bring it to the front (avoids issues with starting a
        // service for the VPN when in the foreground).
        await bringToFront(
            this.adbClient,
            options.deviceId,
            'tech.httptoolkit.android.v1/tech.httptoolkit.android.MainActivity'
        ).catch(reportError); // Not that important, so we continue if this fails somehow

        // Build a trigger URL to activate the proxy on the device:
        const setupParams = {
            addresses: [
                '10.0.2.2', // Standard emulator localhost ip
                '10.0.3.2', // Genymotion localhost ip
            ].concat(
                // Every other external network ip
                _.flatMap(os.networkInterfaces(), (addresses) =>
                    (addresses || [])
                        .filter(a => !a.internal)
                        .map(a => a.address)
                )
            ),
            port: proxyPort,
            localTunnelPort: proxyPort,
            certFingerprint: generateSPKIFingerprint(this.config.https.certContent)
        };
        const intentData = urlSafeBase64(JSON.stringify(setupParams));

        await this.adbClient.reverse(options.deviceId, 'tcp:' + proxyPort, 'tcp:' + proxyPort).catch(() => {});

        // Use ADB to launch the app with the proxy details
        await this.adbClient.startActivity(options.deviceId, {
            wait: true,
            action: 'tech.httptoolkit.android.ACTIVATE',
            data: `https://android.httptoolkit.tech/connect/?data=${intentData}`
        });

        this.deviceProxyMapping[proxyPort] = this.deviceProxyMapping[proxyPort] || [];

        if (!this.deviceProxyMapping[proxyPort].includes(options.deviceId)) {
            this.deviceProxyMapping[proxyPort].push(options.deviceId);

            let tunnelConnectFailures = 0;

            // The reverse tunnel can break when connecting/disconnecting from the VPN. This is a problem! It can
            // also break in other cases, e.g. when ADB is restarted for some reason. To handle this, we constantly
            // reinforce the tunnel while HTTP Toolkit is running & the device is connected.
            const tunnelCheckInterval = setInterval(async () => {
                if (this.deviceProxyMapping[proxyPort].includes(options.deviceId)) {
                    try {
                        await this.adbClient.reverse(options.deviceId, 'tcp:' + proxyPort, 'tcp:' + proxyPort)
                        tunnelConnectFailures = 0;
                    } catch (e) {
                        tunnelConnectFailures += 1;
                        console.log(`${options.deviceId} ADB tunnel failed`, e);

                        if (tunnelConnectFailures >= 5) {
                            // After 10 seconds disconnected, give up
                            console.log(`${options.deviceId} disconnected, dropping the ADB tunnel`);
                            this.deviceProxyMapping[proxyPort] = this.deviceProxyMapping[proxyPort]
                                .filter(id => id !== options.deviceId);
                            clearInterval(tunnelCheckInterval);
                        }
                    }
                } else {
                    // Deactivation at shutdown will clear the proxy data, and so clear this interval
                    // will automatically shut down.
                    clearInterval(tunnelCheckInterval);
                }
            }, 2000);
            tunnelCheckInterval.unref(); // Don't let this block shutdown
        }
    }

    async deactivate(port: number | string): Promise<void | {}> {
        const deviceIds = this.deviceProxyMapping[port] || [];

        return Promise.all(
            deviceIds.map(deviceId =>
                this.adbClient.startActivity(deviceId, {
                    wait: true,
                    action: 'tech.httptoolkit.android.DEACTIVATE'
                })
            )
        );
    }

    async deactivateAll(): Promise<void | {}> {
        return Promise.all(
            Object.keys(this.deviceProxyMapping)
                .map(port => this.deactivate(port)
            )
        );
    }

    private async injectSystemCertIfPossible(deviceId: string, certContent: string) {
        const rootCmd = await getRootCommand(this.adbClient, deviceId);
        if (!rootCmd) {
            console.log('Root not available, skipping cert injection');
            return;
        }

        const cert = parseCert(certContent);

        try {
            const subjectHash = getCertificateSubjectHash(cert);
            const fingerprint = getCertificateFingerprint(cert);

            if (await hasCertInstalled(this.adbClient, deviceId, subjectHash, fingerprint)) {
                console.log("Cert already installed, nothing to do");
                return;
            }

            const certPath = `${ANDROID_TEMP}/${subjectHash}.0`;
            console.log(`Adding cert file as ${certPath}`);

            await pushFile(
                this.adbClient,
                deviceId,
                stringAsStream(certContent.replace('\r\n', '\n')),
                certPath,
                0o444
            );

            await injectSystemCertificate(this.adbClient, deviceId, rootCmd, certPath);
            console.log(`Cert injected`);
        } catch (e) {
            reportError(e);
        }
    }
}