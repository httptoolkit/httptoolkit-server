import * as stream from 'stream';
import * as path from 'path';
import * as adb from 'adbkit';

import { reportError } from '../../error-tracking';

export const ANDROID_TEMP = '/data/local/tmp';
export const SYSTEM_CA_PATH = '/system/etc/security/cacerts';

export function createAdbClient() {
    return adb.createClient({
        // The path used to start adb, if it isn't already running:
        bin: process.env['ANDROID_HOME']
            ? path.join(process.env['ANDROID_HOME'], 'platform-tools', 'adb')
            : 'adb'
    });
}

export async function getConnectedDevices(adbClient: adb.AdbClient) {
    try {
        const devices = await adbClient.listDevices();
        return devices
            .filter(d => d.type !== 'offline')
            .map(d => d.id);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        else {
            reportError(e);
            throw e;
        }
    }
}

export function stringAsStream(input: string) {
    const contentStream = new stream.Readable();
    contentStream._read = () => {};
    contentStream.push(input);
    contentStream.push(null);
    return contentStream;
}

async function run(adbClient: adb.AdbClient, deviceId: string, command: string[]): Promise<string> {
    return adbClient.shell(deviceId, command)
    .then(adb.util.readAll)
    .then(buffer => buffer.toString('utf8'));
}

export async function pushFile(
    adbClient: adb.AdbClient,
    deviceId: string,
    contents: string | stream.Readable,
    path: string,
    mode?: number
) {
    const transfer = await adbClient.push(deviceId, contents, path, mode);

    return new Promise((resolve, reject) => {
        transfer.on('end', resolve);
        transfer.on('error', reject);
    });
}

const runAsRootCommands = [
    ['su', 'root'], // Used on official emulators
    ['su', '-c'] // Normal root
];

export async function getRootCommand(adbClient: adb.AdbClient, deviceId: string): Promise<string[] | undefined> {
    // Run whoami with each of the possible root commands
    const rootCheckResults = await Promise.all(
        runAsRootCommands.map((cmd) =>
            run(adbClient, deviceId, cmd.concat('whoami')).catch(() => {})
            .then((whoami) => ({ cmd, whoami }))
        )
    )

    // Filter to just commands that successfully printed 'root'
    const validRootCommands = rootCheckResults
        .filter((result) => (result.whoami || '').trim() === 'root')
        .map((result) => result.cmd);

    return validRootCommands[0];
}

export async function hasCertInstalled(
    adbClient: adb.AdbClient,
    deviceId: string,
    certHash: string
) {
    try {
        const certPath = `/system/etc/security/cacerts/${certHash}.0`;
        const certStream = await adbClient.pull(deviceId, certPath);

        // Wait until it's clear that the read is successful
        await new Promise((resolve, reject) => {
            certStream.on('progress', resolve);
            certStream.on('end', resolve);

            certStream.on('error', reject);
        });

        certStream.cancel();
        return true;
    } catch (e) {
        // If we fail to read the cert somehow, it's probably not there
        return false;
    }
}

export async function injectSystemCertificate(
    adbClient: adb.AdbClient,
    deviceId: string,
    rootCmd: string[],
    certificatePath: string
) {
    const injectionScriptPath = `${ANDROID_TEMP}/htk-inject-system-cert.sh`;

    // We have a challenge here. How do we add a new cert to /system/etc/security/cacerts,
    // when that's generally read-only & often hard to remount (emulators require startup
    // args to allow RW system files). Solution: mount a virtual temporary FS on top of it.
    await pushFile(
        adbClient,
        deviceId,
        stringAsStream(`
            set -e # Fail on error

            # Create a separate temp directory, to hold the current certificates
            # Without this, when we add the mount we can't read the current certs anymore.
            mkdir -m 700 /data/local/tmp/htk-ca-copy

            # Copy out the existing certificates
            cp /system/etc/security/cacerts/* /data/local/tmp/htk-ca-copy/

            # Create the in-memory mount on top of the system certs folder
            mount -t tmpfs tmpfs /system/etc/security/cacerts

            # Copy the existing certs back into the tmpfs mount, so we keep trusting them
            mv /data/local/tmp/htk-ca-copy/* /system/etc/security/cacerts/

            # Copy our new cert in, so we trust that too
            mv ${certificatePath} /system/etc/security/cacerts/

            # Update the perms & selinux context labels, so everything is as readable as before
            chown root:root /system/etc/security/cacerts/*
            chmod 644 /system/etc/security/cacerts/*
            chcon u:object_r:system_file:s0 /system/etc/security/cacerts/*

            # Delete the temp cert directory & this script itself
            rm -r /data/local/tmp/htk-ca-copy
            rm ${injectionScriptPath}

            echo "System cert successfully injected"
        `),
        injectionScriptPath,
        // Due to an Android bug - user mode is always duplicated to group & others. We set as read-only
        // to avoid making this writable by others before we run it as root in a moment.
        // More details: https://github.com/openstf/adbkit/issues/126
        0o444
    );

    // Actually run the script that we just pushed above, as root
    await run(adbClient, deviceId, rootCmd.concat('sh', injectionScriptPath));
}

