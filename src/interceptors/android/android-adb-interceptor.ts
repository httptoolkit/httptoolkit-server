import _ from 'lodash';
import { DeviceClient } from '@devicefarmer/adbkit';
import { delay } from '@httptoolkit/util';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { generateSPKIFingerprint } from 'mockttp';

import { logError } from '../../error-tracking';
import {
    ANDROID_TEMP,
    createAdbClient,
    getConnectedDevices,
    getRootCommand,
    pushFile,
    injectSystemCertificate,
    stringAsStream,
    hasCertInstalled,
    bringToFront,
    setChromeFlags,
    startActivity,
    createPersistentReverseTunnel,
    closeReverseTunnel,
    EMULATOR_HOST_IPS
} from './adb-commands';
import { streamLatestApk, clearAllApks } from './fetch-apk';
import { parseCert, getCertificateFingerprint, getCertificateSubjectHash } from '../../certificates';
import { getReachableInterfaces } from '../../util/network';

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
        return Object.keys(await getConnectedDevices(this.adbClient)).length > 0;
    }

    activableTimeout = 3000; // Increase timeout for device detection slightly

    isActive(): boolean {
        return false;
    }

    async getMetadata(): Promise<{ deviceIds: string[], devices: Record<string, Record<string, string>> }> {
        const devices = await getConnectedDevices(this.adbClient);

        return {
            deviceIds: Object.keys(devices),
            devices: devices
        };
    }

    async activate(proxyPort: number, options: {
        deviceId: string
    }): Promise<void | {}> {
        const deviceClient = new DeviceClient(this.adbClient, options.deviceId);

        await this.injectSystemCertIfPossible(deviceClient, this.config.https.certContent);

        if (!(await deviceClient.isInstalled('tech.httptoolkit.android.v1'))) {
            console.log("App not installed, installing...");
            try {
                await deviceClient.install(await streamLatestApk(this.config));
            } catch (e) {
                console.log("Resetting & retrying APK install, after initial failure:", e);
                // This can fail due to connection issues (with the device or while downloading
                // the APK) due to a corrupted APK. Reset the APKs and try again, just in case.
                await clearAllApks(this.config);
                await deviceClient.install(await streamLatestApk(this.config));
            }
            console.log("App installed successfully");

            await delay(200); // Add a little delay, to ensure intent URL is registered before we use it
        }

        // Now that the app is installed, bring it to the front (avoids issues with starting a
        // service for the VPN when in the foreground).
        await bringToFront(
            deviceClient,
            'tech.httptoolkit.android.v1/tech.httptoolkit.android.MainActivity'
        ).catch(logError); // Not that important, so we continue if this fails somehow

        // Build a trigger URL to activate the proxy on the device:
        const setupParams = {
            addresses: EMULATOR_HOST_IPS.concat(
                // Every other external network ip
                getReachableInterfaces().filter(a =>
                    a.family === "IPv4" // Android VPN app supports IPv4 only
                ).map(a => a.address)
            ),
            port: proxyPort,
            localTunnelPort: proxyPort,
            certFingerprint: generateSPKIFingerprint(this.config.https.certContent)
        };
        const intentData = urlSafeBase64(JSON.stringify(setupParams));

        await createPersistentReverseTunnel(deviceClient, proxyPort, proxyPort)
            .catch(() => {}); // If we can't tunnel that's OK - we'll use wifi/etc instead

        // Use ADB to launch the app with the proxy details
        await startActivity(deviceClient, {
            action: 'tech.httptoolkit.android.ACTIVATE',
            data: `https://android.httptoolkit.tech/connect/?data=${intentData}`,
            retries: 10
        });

        this.deviceProxyMapping[proxyPort] = this.deviceProxyMapping[proxyPort] || [];
        if (!this.deviceProxyMapping[proxyPort].includes(options.deviceId)) {
            this.deviceProxyMapping[proxyPort].push(options.deviceId);
        }
    }

    async deactivate(port: number | string): Promise<void | {}> {
        const deviceIds = this.deviceProxyMapping[port] || [];

        return Promise.all(
            deviceIds.map(async (deviceId) => {
                const deviceClient = new DeviceClient(this.adbClient, deviceId);

                // Bring app to the front, as otherwise it can't run intents (to tell
                // the background service to stop the VPN)
                await bringToFront(
                    deviceClient,
                    'tech.httptoolkit.android.v1/tech.httptoolkit.android.MainActivity'
                ).catch(logError); // Not that important, so we continue if this fails somehow

                await deviceClient.startActivity({
                    wait: true,
                    action: 'tech.httptoolkit.android.DEACTIVATE'
                });

                closeReverseTunnel(deviceClient, port, port);
            })
        );
    }

    async deactivateAll(): Promise<void | {}> {
        return Promise.all(
            Object.keys(this.deviceProxyMapping)
                .map(port => this.deactivate(port)
            )
        );
    }

    private async injectSystemCertIfPossible(deviceClient: DeviceClient, certContent: string) {
        const rootCmd = await getRootCommand(deviceClient);
        if (!rootCmd) {
            console.log('Root not available, skipping cert injection');
            return;
        }

        const cert = parseCert(certContent);

        try {
            const subjectHash = getCertificateSubjectHash(cert);
            const fingerprint = getCertificateFingerprint(cert);

            if (!await hasCertInstalled(deviceClient, subjectHash, fingerprint)) {
                const certPath = `${ANDROID_TEMP}/${subjectHash}.0`;
                console.log(`Adding cert file as ${certPath}`);

                await pushFile(
                    deviceClient,
                    stringAsStream(certContent.replace('\r\n', '\n')),
                    certPath,
                    0o444
                );

                await injectSystemCertificate(deviceClient, rootCmd, certPath)
                    .then(() => console.log('Cert injected'))
                    .catch((e) => logError(e)); // Continue but log the failure
            } else {
                console.log("Cert already installed, nothing to do");
            }

            const spkiFingerprint = generateSPKIFingerprint(certContent);

            // Chrome requires system certificates to use certificate transparency, which we can't do. To work
            // around this, we need to explicitly trust our certificate in Chrome:
            await setChromeFlags(deviceClient, rootCmd, [
                `--ignore-certificate-errors-spki-list=${spkiFingerprint}`
            ]);
            console.log('Android Chrome flags set');
        } catch (e) {
            logError(e);
        }
    }
}