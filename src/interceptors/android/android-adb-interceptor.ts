import * as _ from 'lodash';
import * as os from 'os';
import * as crypto from 'crypto';
import * as forge from 'node-forge';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { generateSPKIFingerprint } from 'mockttp';

import { reportError } from '../../error-tracking';
import {
    ANDROID_TEMP,
    createAdbClient,
    getConnectedDevices,
    getRootCommand,
    pushFile,
    injectSystemCertificate,
    stringAsStream,
    hasCertInstalled
} from './adb-commands';
import { streamLatestApk } from './fetch-apk';

function urlSafeBase64(content: string) {
    return Buffer.from(content, 'utf8').toString('base64')
        .replace('+', '-')
        .replace('/', '_');
}

// A series of magic incantations that matches the behaviour of openssl's
// -subject_hash_old output, as expected by Android's cert store.
function getCertificateHash(cert: forge.pki.Certificate) {
    const derBytes = forge.asn1.toDer(
        (
            forge.pki as any
        ).distinguishedNameToAsn1(cert.subject)
    ).getBytes();

    return crypto.createHash('md5')
        .update(derBytes)
        .digest()
        .readUInt32LE(0)
        .toString(16);
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

    isActive(): boolean {
        return false;
    }

    async getMetadata() {
        return {
            deviceIds: await getConnectedDevices(this.adbClient)
        };
    }

    async activate(proxyPort: number, options: {
        deviceId: string
    }): Promise<void | {}> {
        await this.injectSystemCertIfPossible(options.deviceId, this.config.https.certContent);

        if (!(await this.adbClient.isInstalled(options.deviceId, 'tech.httptoolkit.android'))) {
            console.log("App not installed, installing...");
            let stream = await streamLatestApk(this.config);
            await this.adbClient.install(options.deviceId, stream);
            console.log("App installed successfully");
        }

        // Build a trigger URL to activate the proxy on the device:
        const setupParams = {
            addresses: [
                '10.0.2.2', // Standard emulator localhost ip
                '10.0.3.2', // Genymotion localhost ip
            ].concat(
                // Every other external network ip
                _.flatMap(os.networkInterfaces(), (addresses) =>
                    addresses
                        .filter(a => !a.internal)
                        .map(a => a.address)
                )
            ),
            port: proxyPort,
            certFingerprint: generateSPKIFingerprint(this.config.https.certContent)
        };
        const intentData = urlSafeBase64(JSON.stringify(setupParams));

        // Use ADB to launch the app with the proxy details
        await this.adbClient.startActivity(options.deviceId, {
            wait: true,
            action: 'tech.httptoolkit.android.ACTIVATE',
            data: `https://android.httptoolkit.tech/connect/?data=${intentData}`
        });

        this.deviceProxyMapping[proxyPort] = this.deviceProxyMapping[proxyPort] || [];
        this.deviceProxyMapping[proxyPort].push(options.deviceId);
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

        const cert = forge.pki.certificateFromPem(certContent);

        try {
            const certHash = getCertificateHash(cert);

            if (await hasCertInstalled(this.adbClient, deviceId, certHash)) {
                console.log("Cert already installed, nothing to do");
                return;
            }

            const certPath = `${ANDROID_TEMP}/${certHash}.0`;
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