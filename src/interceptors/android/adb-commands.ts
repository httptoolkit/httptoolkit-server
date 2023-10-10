import * as stream from 'stream';
import * as path from 'path';
import adb, * as Adb from '@devicefarmer/adbkit';
import { logError } from '../../error-tracking';
import { isErrorLike } from '../../util/error';
import { delay, waitUntil } from '../../util/promise';
import { getCertificateFingerprint, parseCert } from '../../certificates';
import { streamToBuffer } from '../../util/stream';

export const ANDROID_TEMP = '/data/local/tmp';
export const SYSTEM_CA_PATH = '/system/etc/security/cacerts';

export function createAdbClient() {
    const client = adb.createClient({
        port: process.env['ANDROID_ADB_SERVER_PORT']
            ? parseInt(process.env['ANDROID_ADB_SERVER_PORT'], 10)
            : 5037,
        // The path used to start adb, if it isn't already running:
        bin: process.env['ANDROID_HOME']
            ? path.join(process.env['ANDROID_HOME'], 'platform-tools', 'adb')
            : 'adb'
    });

    if (process.platform === 'win32') {
        // If ADB is connected (=if list works) then we try to connect to 58526 automatically
        // (but asychronously) at start up. This is the local debug port for Windows
        // Subsystem for Android:
        // https://learn.microsoft.com/en-us/windows/android/wsa/#connect-to-the-windows-subsystem-for-android-for-debugging

        client.listDevices()
            .then(() => client.connect('127.0.0.1', 58526))
            .then(() => console.log('Connected to WSA via ADB'))
            .catch(() => {}); // Just best-efforts, so we ignore any failures here
    }

    // We listen for errors and report them. This only happens if adbkit completely
    // fails to handle or listen to a connection error. We'd rather report that than crash.
    client.on('error', logError);

    return client;
}

// Batch async calls, so that all calls whilst one call is ongoing return the same result.
// Always uses the arguments from the first call, so this isn't safe for some cases!
const batchCalls = <A extends any[], R>(
    fn: (...args: A) => Promise<R>
) => {
    let ongoingCall: Promise<R> | undefined = undefined;

    return (...args: A) => {
        if (!ongoingCall) {
            ongoingCall = fn(...args)
                .then((result) => {
                    ongoingCall = undefined;
                    return result;
                })
                .catch((error) => {
                    ongoingCall = undefined;
                    throw error;
                });
        }

        return ongoingCall;
    };
}

export const getConnectedDevices = batchCalls(async (adbClient: Adb.Client) => {
    try {
        const devices = await (adbClient.listDevices() as Promise<Adb.Device[]>);
        return devices
            .filter((d) =>
                d.type !== 'offline' &&
                d.type !== 'unauthorized' &&
                !d.type.startsWith("no permissions")
            ).map(d => d.id);
    } catch (e) {
        if (isErrorLike(e) && (
                e.code === 'ENOENT' || // No ADB available
                e.code === 'EACCES' || // ADB available, but we aren't allowed to run it
                e.code === 'EPERM' || // Permissions error launching ADB
                e.code === 'ECONNREFUSED' || // Tried to start ADB, but still couldn't connect
                e.code === 'ENOTDIR' || // ADB path contains something that's not a directory
                e.signal === 'SIGKILL' || // In some envs 'adb start-server' is always killed (why?)
                (e.cmd && e.code)      // ADB available, but "adb start-server" failed
            )
        ) {
            if (e.code !== 'ENOENT') {
                console.log(`ADB unavailable, ${e.cmd
                    ? `${e.cmd} exited with ${e.code}`
                    : `due to ${e.code}`
                }`);
            }
            return [];
        } else {
            logError(e);
            throw e;
        }
    }
})

export function stringAsStream(input: string) {
    const contentStream = new stream.Readable();
    contentStream._read = () => {};
    contentStream.push(input);
    contentStream.push(null);
    return contentStream;
}

async function run(
    adbClient: Adb.DeviceClient,
    command: string[],
    options: {
        timeout?: number
    } = {
        timeout: 10000
    }
): Promise<string> {
    return Promise.race([
        adbClient.shell(command)
            .then(adb.util.readAll)
            .then((buffer: Buffer) => buffer.toString('utf8'))
            .then((result) => {
                console.debug("Android command", command, "returned", `\`${result.trimEnd()}\``);
                return result;
            }),
        ...(options.timeout
            ? [
                delay(options.timeout)
                .then(() => { throw new Error(`Timeout for ADB command ${command}`) })
            ]
            : []
        )
    ]).catch((e) => {
        console.debug("Android command", command, "threw", e.message);
        throw e;
    });
}

export async function pushFile(
    adbClient: Adb.DeviceClient,
    contents: string | stream.Readable,
    path: string,
    mode?: number
) {
    const transfer = await adbClient.push(contents, path, mode);

    return new Promise((resolve, reject) => {
        transfer.on('end', resolve);
        transfer.on('error', reject);
    });
}

const runAsRootCommands = [
    // Maybe we're already root?
    (...cmd: string[]) => [...cmd],
    // Su on many physical rooted devices requires quotes. Adbkit automatically quotes
    // each argument in the array, so we just have to make it a single arg:
    (...cmd: string[]) => ['su', '-c', cmd.join(' ')],
    // But sometimes it doesn't like them, so try that too:
    (...cmd: string[]) => ['su', '-c', ...cmd],
    // 'su' as available on official emulators, no quoting of commands required:
    (...cmd: string[]) => ['su', 'root', ...cmd],
    // 'su' with a single-arg command here too, just in case:
    (...cmd: string[]) => ['su', 'root', cmd.join(' ')]
];

type RootCmd = (...cmd: string[]) => string[];

export async function getRootCommand(adbClient: Adb.DeviceClient): Promise<RootCmd | undefined> {
    const rootTestScriptPath = `${ANDROID_TEMP}/htk-root-test.sh`;

    try {
        // Just running 'whoami' doesn't fully check certain tricky cases around how the root commands
        // handle multiple arguments etc. Pushing & running this script is an accurate test of which
        // root mechanisms will actually work on this device:
        let rootTestCommand = ['sh', rootTestScriptPath];
        try {
            await pushFile(adbClient, stringAsStream(`
                set -e # Fail on error
                whoami # Log the current user name, to confirm if we're root
            `), rootTestScriptPath, 0o444);
        } catch (e) {
            console.log(`Couldn't write root test script to ${rootTestScriptPath}`, e);
            // Ok, so we can't write the test script, but let's still test for root via whoami directly,
            // because maybe if we get root then that won't be a problem
            rootTestCommand = ['whoami'];
        }

        // Run our whoami script with each of the possible root commands
        const rootCheckResults = await Promise.all(
            runAsRootCommands.map((runAsRoot) =>
                run(adbClient, runAsRoot(...rootTestCommand), { timeout: 1000 }).catch(console.log)
                .then((whoami) => ({ cmd: runAsRoot, whoami }))
            )
        )

        // Filter to just commands that successfully printed 'root'
        const validRootCommands = rootCheckResults
            .filter((result) => (result.whoami || '').trim() === 'root')
            .map((result) => result.cmd);

        if (validRootCommands.length >= 1) return validRootCommands[0];

        // If no explicit root commands are available, try to restart adb in root
        // mode instead. If this works, *all* commands will run as root.
        // We prefer explicit "su" calls if possible, to limit access & side effects.
        await adbClient.root().catch((e: any) => {
            if (isErrorLike(e) && e.message?.includes("adbd is already running as root")) return;
            else console.log(e);
        });

        // Sometimes switching to root can disconnect ADB devices, so double-check
        // they're still here, and wait a few seconds for them to come back if not.

        await delay(500); // Wait, since they may not disconnect immediately
        const whoami = await waitUntil(250, 10, (): Promise<string | false> => {
            return run(adbClient, rootTestCommand, { timeout: 1000 }).catch(() => false)
        }).catch(console.log);

        return (whoami || '').trim() === 'root'
            ? (...cmd: string[]) => cmd // All commands now run as root
            : undefined; // Still not root, no luck.
    } catch (e) {
        console.error(e);
        logError('ADB root check crashed');
        return undefined;
    } finally {
        // Try to clean up the root test script, just to be tidy
        run(adbClient, ['rm', '-f', rootTestScriptPath]).catch(() => {});
    }
}

export async function hasCertInstalled(
    adbClient: Adb.DeviceClient,
    certHash: string,
    certFingerprint: string
) {
    try {
        const certPath = `/system/etc/security/cacerts/${certHash}.0`;
        const certStream = await adbClient.pull(certPath);

        // Wait until it's clear that the read is successful
        const data = await streamToBuffer(certStream);

        // The device already has an HTTP Toolkit cert. But is it the right one?
        const existingCert = parseCert(data.toString('utf8'));
        const existingFingerprint = getCertificateFingerprint(existingCert);
        return certFingerprint === existingFingerprint;
    } catch (e) {
        // Couldn't read the cert, or some other error - either way, we probably
        // don't have a working system cert installed.
        return false;
    }
}

export async function injectSystemCertificate(
    adbClient: Adb.DeviceClient,
    runAsRoot: RootCmd,
    certificatePath: string
) {
    const injectionScriptPath = `${ANDROID_TEMP}/htk-inject-system-cert.sh`;

    // We have a challenge here. How do we add a new cert to /system/etc/security/cacerts,
    // when that's generally read-only & often hard to remount (emulators require startup
    // args to allow RW system files). Solution: mount a virtual temporary FS on top of it.
    await pushFile(
        adbClient,
        stringAsStream(`
            set -e # Fail on error

            # Create a separate temp directory, to hold the current certificates
            # Without this, when we add the mount we can't read the current certs anymore.
            mkdir -p -m 700 /data/local/tmp/htk-ca-copy

            # Copy out the existing certificates
            if [ -d "/apex/com.android.conscrypt/cacerts" ]; then
                cp /apex/com.android.conscrypt/cacerts/* /data/local/tmp/htk-ca-copy/
            else
                cp /system/etc/security/cacerts/* /data/local/tmp/htk-ca-copy/
            fi

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

            echo 'System cacerts setup completed'

            # Deal with the APEX overrides in Android 14+, which need injecting into each namespace:
            if [ -d "/apex/com.android.conscrypt/cacerts" ]; then
                echo 'Injecting certificates into APEX cacerts'

                # When the APEX manages cacerts, we need to mount them at that path too. We can't do
                # this globally as APEX mounts are namespaced per process, so we need to inject a
                # bind mount for this directory into every mount namespace.

                # First we get the Zygote process(es), which launch each app
                ZYGOTE_PID=$(pidof zygote || true)
                ZYGOTE64_PID=$(pidof zygote64 || true)
                Z_PIDS="$ZYGOTE_PID $ZYGOTE64_PID"
                # N.b. some devices appear to have both, some have >1 of each (!)

                # Apps inherit the Zygote's mounts at startup, so we inject here to ensure all newly
                # started apps will see these certs straight away:
                for Z_PID in $Z_PIDS; do
                    if [ -n "$Z_PID" ]; then
                        nsenter --mount=/proc/$Z_PID/ns/mnt -- \
                            /bin/mount --bind /system/etc/security/cacerts /apex/com.android.conscrypt/cacerts
                    fi
                done

                echo 'Zygote APEX certificates remounted'

                # Then we inject the mount into all already running apps, so they see these certs immediately.

                # Get the PID of every process whose parent is one of the Zygotes:
                APP_PIDS=$(
                    echo $Z_PIDS | \
                    xargs -n1 ps -o 'PID' -P | \
                    grep -v PID
                )

                # Inject into the mount namespace of each of those apps:
                for PID in $APP_PIDS; do
                    nsenter --mount=/proc/$PID/ns/mnt -- \
                        /bin/mount --bind /system/etc/security/cacerts /apex/com.android.conscrypt/cacerts &
                done
                wait # Launched in parallel - wait for completion here

                echo "APEX certificates remounted for $(echo $APP_PIDS | wc -w) apps"
            fi

            # Delete the temp cert directory & this script itself
            rm -r /data/local/tmp/htk-ca-copy
            rm ${injectionScriptPath}

            echo "System cert successfully injected"
        `),
        injectionScriptPath,
        // Due to an Android bug, user mode is always duplicated to group & others. We set as read-only
        // to avoid making this writable by others before we run it as root in a moment.
        // More details: https://github.com/openstf/adbkit/issues/126
        0o444
    );

    // Actually run the script that we just pushed above, as root
    const scriptOutput = await run(adbClient, runAsRoot('sh', injectionScriptPath));

    if (!scriptOutput.includes("System cert successfully injected")) {
        throw new Error('System certificate injection failed');
    }
}

export async function setChromeFlags(
    adbClient: Adb.DeviceClient,
    runAsRoot: RootCmd,
    flags: string[]
) {
    const flagsFileContent = `chrome ${flags.join(' ')}`;

    const chromeFlagsLocations = [
        'chrome',
        'android-webview',
        'webview',
        'content-shell'
    ].flatMap((variant) => [
        `/data/local/${variant}-command-line`,
        `/data/local/tmp/${variant}-command-line`,
    ]);

    const chromeFlagsScriptPath = `${ANDROID_TEMP}/htk-set-chrome-flags.sh`;

    await pushFile(
        adbClient,
        stringAsStream(`
            set -e # Fail on error

            ${
                chromeFlagsLocations.map((flagsFilePath) => `
            echo "${flagsFileContent}" > "${flagsFilePath}"
            chmod 744 "${flagsFilePath}"
            chcon "u:object_r:shell_data_file:s0" "${flagsFilePath}"`
                ).join('\n')
            }

            rm ${chromeFlagsScriptPath}

            echo "Chrome flags script completed"
        `),
        chromeFlagsScriptPath,
        // Due to an Android bug, user mode is always duplicated to group & others. We set as read-only
        // to avoid making this writable by others before we run it as root in a moment.
        // More details: https://github.com/openstf/adbkit/issues/126
        0o444
    );

    // Actually run the script that we just pushed above, as root
    const scriptOutput = await run(adbClient, runAsRoot('sh', chromeFlagsScriptPath));
    console.log(scriptOutput);

    // Try to restart chrome, now that the flags have probably been changed:
    await run(adbClient, runAsRoot('am', 'force-stop', 'com.android.chrome')).catch(() => {});
}

export async function bringToFront(
    adbClient: Adb.DeviceClient,
    activityName: string // Of the form: com.package/com.package.YourActivity
) {
    // Wake the device up, so it's at least obviously locked if locked.
    // It's not possible to unlock the device over ADB. Does nothing if already awake.
    await adbClient.shell([
        "input", "keyevent", "KEYCODE_WAKEUP"
    ]);

    await delay(10);

    // Bring the activity to the front, so we can interact with it (this will
    // silently fail if the device is locked, but we're ok with that).
    await adbClient.shell([
        "am", "start", "--activity-single-top", activityName
    ]);
}

export async function startActivity(
    adbClient: Adb.DeviceClient,
    options: {
        action?: string,
        data?: string,
        retries?: number
    }
): Promise<void> {
    const retries = options.retries ?? 0;

    try {
        await adbClient.startActivity({
            wait: true,
            action: options.action,
            data: options.data
        });
    } catch (e) {
        if (retries <= 0) throw e;
        else {
            await delay(1000);

            return startActivity(adbClient, {
                ...options,
                retries: retries - 1
            });
        }
    }
}