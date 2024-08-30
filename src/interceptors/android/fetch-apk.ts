import * as path from 'path';
import * as stream from 'stream';
import * as semver from 'semver';
import fetch from 'node-fetch';

import * as fs from '../../util/fs';
import { HtkConfig } from '../../config';
import { logError } from '../../error-tracking';

const APK_REPO_RELEASE = 'httptoolkit/httptoolkit-android/releases/latest';

async function getLatestRelease(): Promise<
    | { version: string, url: string }
    | 'unknown-latest'
    | undefined
> {
    try {
        const response = await fetch(`https://api.github.com/repos/${APK_REPO_RELEASE}`);

        if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
            // Likely connectable but we can't check the version (API rate limit). Used only if
            // we don't have any other APK available.
            console.log("Can't check latest APK version due to GitHub rate limit");
            return 'unknown-latest';
        } else if (!response.ok) {
            throw new Error(`Checking latest Android app release failed with ${response.status}`);
        }

        const release = await response.json();
        const apkAsset = release.assets.filter((a: any) => a.name === "httptoolkit.apk")[0];
        const releaseName = release.name || release.tag_name;

        // Ignore non-semver releases
        if (!semver.valid(releaseName)) return;

        return {
            version: releaseName,
            url: apkAsset.browser_download_url
        };
    } catch (e) {
        console.log("Could not check latest Android app release", e);
    }
}

async function getAllLocalApks(config: HtkConfig) {
    const apks = (await fs.readDir(config.configPath))
        .map(filename => filename.match(/^httptoolkit-(.*).apk$/))
        .filter((match): match is RegExpMatchArray => !!match)
        .map((match) => ({
            path: path.join(config.configPath, match[0]),
            version: semver.valid(match[1]) || '0.0.0'
        }));

    apks.sort((apk1, apk2) => {
        return -1 * semver.compare(apk1.version, apk2.version);
    });

    return apks;
}

async function getLatestLocalApk(config: HtkConfig) {
    try {
        const apks = await getAllLocalApks(config);
        const latestLocalApk = apks[0];
        if (!latestLocalApk) return;
        else return latestLocalApk;
    } catch (e) {
        console.log("Could not check for local Android app APK", e);
        logError(e);
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
    } = await fs.createTmp({ keep: true });

    const tmpApkStream = fs.createWriteStream(tmpApk, { fd: tmpApkFd });
    apkStream.pipe(tmpApkStream);

    await new Promise<void>((resolve, reject) => {
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

    await fs.moveFile(tmpApk, path.join(config.configPath, `httptoolkit-${version}.apk`));
    console.log(`Local APK moved to ${path.join(config.configPath, `httptoolkit-${version}.apk`)}`);
    await cleanupOldApks(config);
}

export async function clearAllApks(config: HtkConfig) {
    const apks = await getAllLocalApks(config);
    console.log(`Deleting all APKs: ${apks.map(apk => apk.path).join(', ')}`);
    return Promise.all(apks.map(apk => fs.deleteFile(apk.path)));
}

// Delete all but the most recent APK version in the config directory.
async function cleanupOldApks(config: HtkConfig) {
    const apks = await getAllLocalApks(config);

    console.log(`Deleting old APKs: ${apks.slice(1).map(apk => apk.path).join(', ')}`);

    return Promise.all(
        apks.slice(1).map(apk => fs.deleteFile(apk.path))
    );
}

export async function streamLatestApk(config: HtkConfig): Promise<stream.Readable> {
    const [latestApkRelease, localApk] = await Promise.all([
        getLatestRelease(),
        getLatestLocalApk(config)
    ]);

    if (!localApk) {
        if (!latestApkRelease) {
            throw new Error("Couldn't find an Android APK locally or remotely");
        } else {
            // No APK locally, but we can get one remotely:

            console.log('Streaming remote APK directly');
            const apkUrl = latestApkRelease === 'unknown-latest'
                ? `https://github.com/${APK_REPO_RELEASE}/download/httptoolkit.apk`
                : latestApkRelease.url;

            const apkResponse = await fetch(apkUrl);
            if (!apkResponse.ok) {
                throw new Error(`APK download failed with ${apkResponse.status}`);
            }
            const apkStream = apkResponse.body;

            // We buffer output into two passthrough streams, so both file & install
            // stream usage can be set up async independently. Buffers are 10MB, to
            // avoid issues buffering the whole APK even in super weird cases.
            const apkFileStream = new stream.PassThrough({ highWaterMark: 10485760 });
            apkStream.pipe(apkFileStream);
            const apkOutputStream = new stream.PassThrough({ highWaterMark: 10485760 });
            apkStream.pipe(apkOutputStream);

            if (latestApkRelease !== 'unknown-latest') {
                updateLocalApk(latestApkRelease.version, apkFileStream, config).catch(logError);
            }

            return apkOutputStream;
        }
    }

    // So, we now have a local APK. Do we want to pull the remote one anyway?

    if (
        !latestApkRelease || // Can't get releases at all
        latestApkRelease === 'unknown-latest' || // Can get, but don't know the version
        semver.gte(localApk.version, latestApkRelease.version, true) // Already up to date
    ) {
        console.log('Streaming local APK');
        // If we have an APK locally and it's up to date, or we can't tell, just use it
        return fs.createReadStream(localApk.path);
    }

    // We have a local APK & a remote APK, and the remote is newer.
    // Try to update it async, and use the local APK in the meantime.
    fetch(latestApkRelease.url).then((apkResponse) => {
        const apkStream = apkResponse.body;
        return updateLocalApk(latestApkRelease.version, apkStream, config);
    }).catch(logError);

    console.log('Streaming local APK, and updating it async');
    return fs.createReadStream(localApk.path);
}