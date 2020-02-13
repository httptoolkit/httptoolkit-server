import * as _ from 'lodash';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as stream from 'stream';
import * as forge from 'node-forge';
import * as semver from 'semver';
import fetch from 'node-fetch';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { generateSPKIFingerprint } from 'mockttp';
import {
    ANDROID_TEMP,
    createAdbClient,
    getConnectedDevices,
    getRootCommand,
    pushFile,
    injectSystemCertificate,
    stringAsStream
} from './adb-commands';
import { reportError } from '../../error-tracking';
import { readDir, createTmp, renameFile } from '../../util';

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

async function getLatestRelease(): Promise<{ version: string, url: string } | undefined> {
    try {
        const response = await fetch(
            "https://api.github.com/repos/httptoolkit/httptoolkit-android/releases/latest"
        );
        const release = await response.json();
        const apkAsset = release.assets.filter((a: any) => a.name === "httptoolkit.apk")[0];

        // Ignore non-semver releases
        if (!semver.valid(release.name)) return;

        return {
            version: release.name,
            url: apkAsset.browser_download_url
        };
    } catch (e) {
        console.log("Could not check latest Android app release", e);
    }
}

async function getLocalApk(config: HtkConfig) {
    try {
        const apks = (await readDir(config.configPath))
            .map(filename => filename.match(/^httptoolkit-(.*).apk$/))
            .filter((match): match is RegExpMatchArray => !!match)
            .map((match) => ({
                path: path.join(config.configPath, match[0]),
                version: match[1]
            }));

        apks.sort((apk1, apk2) => {
            return -1 * semver.compare(apk1.version, apk2.version);
        });

        const latestLocalApk = apks[0];
        if (!latestLocalApk) return;
        else return latestLocalApk;
    } catch (e) {
        console.log("Could not check for local Android app APK", e);
        reportError(e);
    }
}

async function updateLocalApk(
    version: string,
    apkStream: stream.Readable | NodeJS.ReadableStream,
    config: HtkConfig
) {
    console.log(`Updating local APK to version ${version}`);
    const {
        path: tmpApk,
        fd: tmpApkFd,
        cleanupCallback
    } = await createTmp();

    const tmpApkStream = fs.createWriteStream(tmpApk, {
        fd: tmpApkFd,
        encoding: 'binary'
    });
    apkStream.pipe(tmpApkStream);

    await new Promise((resolve, reject) => {
        apkStream.on('error', (e) => {
            reject(e);
            tmpApkStream.close();
            cleanupCallback();
        });
        tmpApkStream.on('error', (e) => {
            reject(e);
            cleanupCallback();
        });
        tmpApkStream.on('finish', () => resolve());
    });

    console.log(`Local APK written to ${tmpApk}`);

    await renameFile(tmpApk, path.join(config.configPath, `httptoolkit-${version}.apk`));
    console.log(`Local APK moved to ${path.join(config.configPath, `httptoolkit-${version}.apk`)}`);
}

async function streamLatestApk(config: HtkConfig): Promise<stream.Readable> {
    const [latestApkRelease, localApk] = await Promise.all([
        await getLatestRelease(),
        await getLocalApk(config)
    ]);

    if (!localApk) {
        if (!latestApkRelease) {
            throw new Error("Couldn't find an Android APK locally or remotely");
        } else {
            console.log('Streaming remote APK directly');
            const apkStream = (await fetch(latestApkRelease.url)).body;
            updateLocalApk(latestApkRelease.version, apkStream, config);
            return apkStream as stream.Readable;
        }
    }

    if (!latestApkRelease || semver.gte(localApk.version, latestApkRelease.version, true)) {
        console.log('Streaming local APK');
        // If we have an APK locally and it's up to date, or we can't tell, just use it
        return fs.createReadStream(localApk.path, { encoding: 'binary' });
    }

    // We have a local APK & a remote APK, and the remote is newer.
    // Try to update it async, and use the local APK in the meantime.
    fetch(latestApkRelease.url).then((apkResponse) => {
        const apkStream = apkResponse.body;
        updateLocalApk(latestApkRelease.version, apkStream, config);
    }).catch(reportError);

    console.log('Streaming local APK, and updating it async');
    return fs.createReadStream(localApk.path, { encoding: 'binary' });
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
            const certName = getCertificateHash(cert);
            const certPath = `${ANDROID_TEMP}/${certName}.0`;
            console.log(`Adding cert file as ${certPath}`);

            await pushFile(
                this.adbClient,
                deviceId,
                stringAsStream(certContent.replace('\r\n', '\n')),
                certPath,
                0o644
            );

            await injectSystemCertificate(this.adbClient, deviceId, rootCmd, certPath);
            console.log(`Cert injected`);
        } catch (e) {
            reportError(e);
        }
    }
}