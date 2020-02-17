import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import * as semver from 'semver';
import fetch from 'node-fetch';

import { readDir, createTmp, moveFile, deleteFile } from '../../util';
import { HtkConfig } from '../../config';
import { reportError } from '../../error-tracking';

async function getLatestRelease(): Promise<{ version: string, url: string } | undefined> {
    try {
        const response = await fetch(
            "https://api.github.com/repos/httptoolkit/httptoolkit-android/releases/latest"
        );
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
    } = await createTmp({ keep: true });

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

    await moveFile(tmpApk, path.join(config.configPath, `httptoolkit-${version}.apk`));
    console.log(`Local APK moved to ${path.join(config.configPath, `httptoolkit-${version}.apk`)}`);
    await cleanupOldApks(config);
}

// Delete all but the most recent APK version in the config directory.
async function cleanupOldApks(config: HtkConfig) {
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

    console.log(`Deleting old APKs: ${apks.slice(1).map(apk => apk.path).join(', ')}`);

    return Promise.all(
        apks.slice(1).map(apk => deleteFile(apk.path))
    );
}

export async function streamLatestApk(config: HtkConfig): Promise<stream.Readable> {
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
            updateLocalApk(latestApkRelease.version, apkStream, config).catch(reportError);
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
        return updateLocalApk(latestApkRelease.version, apkStream, config);
    }).catch(reportError);

    console.log('Streaming local APK, and updating it async');
    return fs.createReadStream(localApk.path, { encoding: 'binary' });
}