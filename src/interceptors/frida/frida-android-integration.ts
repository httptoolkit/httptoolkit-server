import { CustomError } from '@httptoolkit/util';
import { Client as AdbClient, DeviceClient } from '@devicefarmer/adbkit';
import * as FridaJs from 'frida-js';

import { waitUntil, withTimeout } from '../../util/promise';
import { HtkConfig } from '../../config';
import {
    EMULATOR_HOST_IPS,
    createPersistentReverseTunnel,
    getConnectedDevices,
    getRootCommand,
    isProbablyRooted
} from '../android/adb-commands';
import { buildAndroidFridaScript } from './frida-scripts';
import {
    FRIDA_ALTERNATE_PORT,
    FRIDA_BINARY_NAME,
    FRIDA_DEFAULT_PORT,
    FridaHost,
    getFridaServer,
    killProcess,
    launchScript,
    testAndSelectProxyAddress
} from './frida-integration';

const ANDROID_DEVICE_HTK_PATH = '/data/local/tmp/.httptoolkit';
const ANDROID_FRIDA_BINARY_PATH = `${ANDROID_DEVICE_HTK_PATH}/${FRIDA_BINARY_NAME}`;

const ALL_X_PERMS = 0o00111;

const isFridaInstalled = (deviceClient: DeviceClient) =>
    deviceClient.readdir(ANDROID_DEVICE_HTK_PATH)
    .then((entries) => entries.some((entry) =>
        entry.name === FRIDA_BINARY_NAME &&
        (entry.mode & ALL_X_PERMS) !== 0 &&
        entry.size > 0
    ))
    .catch(() => false);

const isDevicePortOpen = (deviceClient: DeviceClient, port: number) =>
    withTimeout(1000, deviceClient.openTcp(port))
    .then((conn) => {
        // If the connection opened at all, then something is listening...
        conn.on('error', () => {});
        conn.end();
        return true;
    }).catch(() => {
        // If the port is closed, we jump straight to the error state instead
        return false
    });

export async function getAndroidFridaHosts(adbClient: AdbClient): Promise<Record<string, FridaHost>> {
    const devices = await getConnectedDevices(adbClient);

    return Object.fromEntries(await Promise.all(
        Object.entries(devices).map(async ([id, device]) => [
            id, {
                ...device,
                type: 'android',
                state: await getHostState(adbClient, id)
            }
        ])
    ));
}

const getHostState = async (adbClient: AdbClient, deviceId: string) => {
    const deviceClient = adbClient.getDevice(deviceId);

    let state: FridaHost['state'] = 'unavailable';

    // We run state checks in series, not parallel - slower, but less hammering of
    // ADB APIs & device processing, and no running any unnecessary checks.

    const [defaultPortOpen, alternatePortOpen] = await Promise.all([
        isDevicePortOpen(deviceClient, FRIDA_DEFAULT_PORT),
        isDevicePortOpen(deviceClient, FRIDA_ALTERNATE_PORT)
    ]);

    if (defaultPortOpen || alternatePortOpen) {
        state = 'available';
    } else if (await isFridaInstalled(deviceClient)) {
        state = 'launch-required'
    } else if (await isProbablyRooted(deviceClient)) {
        state = 'setup-required'
    } else {
        // No Frida - looks unrooted - nothing we can do.
        state = 'unavailable';
    }

    return state;
};

const ANDROID_ABI_FRIDA_ARCH_MAP = {
    'arm64-v8a': 'arm64',
    'armeabi': 'arm',
    'armabi-v7a': 'arm',
    'x86': 'x86',
    'x86_64': 'x86_64'
} as const;

export async function setupAndroidHost(config: HtkConfig, adbClient: AdbClient, hostId: string) {
    console.log(`Installing Android Frida server on ${hostId}...`);
    const deviceClient = adbClient.getDevice(hostId);

    const deviceProperties = await deviceClient.getProperties();
    const supportedAbis = (
        deviceProperties['ro.product.cpu.abilist']?.split(',') ??
        [deviceProperties['ro.product.cpu.abi']]
    ).map(abi => abi.trim());

    const firstKnownAbi = supportedAbis.find((abi): abi is keyof typeof ANDROID_ABI_FRIDA_ARCH_MAP =>
        Object.keys(ANDROID_ABI_FRIDA_ARCH_MAP).includes(abi)
    );
    if (!firstKnownAbi) throw new Error(`Did not recognize any device ABIs from ${supportedAbis.join(',')}`);

    const deviceArch = ANDROID_ABI_FRIDA_ARCH_MAP[firstKnownAbi];
    const serverStream = await getFridaServer(config, 'android', deviceArch);

    const transfer = await deviceClient.push(serverStream, ANDROID_FRIDA_BINARY_PATH, 0o555);
    await new Promise<void>((resolve, reject) => {
        transfer.on('end', resolve);
        transfer.on('error', reject);
    });
}

export async function launchAndroidHost(adbClient: AdbClient, hostId: string) {
    console.log(`Launching Android Frida server on ${hostId}...`);
    const deviceClient = adbClient.getDevice(hostId);

    const runAsRoot = await getRootCommand(deviceClient);

    if (!runAsRoot) {
        throw new CustomError("Couldn't get root access to launch Frida Server", {
            code: 'no-root'
        });
    }

    const fridaServerStream = await deviceClient.shell(
        runAsRoot(ANDROID_FRIDA_BINARY_PATH, '-l', `127.0.0.1:${FRIDA_ALTERNATE_PORT}`)
    );
    fridaServerStream.pipe(process.stdout);

    // Wait until the server becomes accessible
    try {
        await waitUntil(500, 10, async () => {
            try {
                return await getHostState(adbClient, hostId) === 'available';
            } catch (e: any) {
                console.log(e.message ?? e);
                return false;
            }
        });

        return fridaServerStream;
    } catch (e: any) {
        const errorMessage = e?.code === 'wait-loop-failed'
            ? 'Frida server did not startup before timeout'
            : e.message ?? e;
        console.log('Fride launch failed:', errorMessage);

        // Try cleaning up the Frida server (async) just in case it's corrupted somehow:
        deviceClient.shell(runAsRoot('rm', '-f', ANDROID_FRIDA_BINARY_PATH)).catch((e) => {
            console.warn(
                `Failed to clean up broken Frida server on ${hostId} at ${ANDROID_FRIDA_BINARY_PATH}: ${
                    e.message ?? e
                }`
            );
        });

        throw new CustomError(errorMessage, { code: e?.code, cause: e });
    }
}

const getFridaStream = (hostId: string, deviceClient: DeviceClient) =>
    // Try alt port first (preferred and more likely to work - it's ours)
    deviceClient.openTcp(FRIDA_ALTERNATE_PORT)
    .catch(() => deviceClient.openTcp(FRIDA_DEFAULT_PORT))
    .catch(() => {
        throw new CustomError(`Couldn't connect to Frida for ${hostId}`, {
            statusCode: 502
        });
    });

export async function getAndroidFridaTargets(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

    const fridaStream = await getFridaStream(hostId, deviceClient);

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const apps = await fridaSession.enumerateApplications();
    fridaSession.disconnect().catch(() => {});
    return apps;
}

// Various ports which we know that certain apps use for non-HTTP traffic that we
// can't currently intercept, so we avoid capturing for now.
const KNOWN_APP_PROBLEMATIC_PORTS: Record<string, number[] | undefined> = {
    'com.spotify.music': [4070]
};

export async function interceptAndroidFridaTarget(
    adbClient: AdbClient,
    hostId: string,
    appId: string,
    caCertContent: string,
    proxyPort: number
) {
    console.log(`Intercepting ${appId} via Android Frida on ${hostId}...`);
    const deviceClient = adbClient.getDevice(hostId);

    await createPersistentReverseTunnel(deviceClient, proxyPort, proxyPort)
        .catch(() => {}); // If we can't tunnel that's OK - we'll use wifi/etc instead

    const fridaStream = await getFridaStream(hostId, deviceClient);

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const { session } = await fridaSession.spawnPaused(appId, undefined);

    try {
        const proxyIp = await testAndSelectProxyAddress(session, proxyPort, {
            // Localhost here is local to the device - it's the reverse tunnel
            // over ADB, which is generally more robust than wifi etc
            extraAddresses: [
                '127.0.0.1',
                ...EMULATOR_HOST_IPS,
            ]
        });

        const interceptionScript = await buildAndroidFridaScript(
            caCertContent,
            proxyIp,
            proxyPort,
            KNOWN_APP_PROBLEMATIC_PORTS[appId] ?? []
        );

        await launchScript(`Android (${appId})`, session, interceptionScript);
        await session.resume();
        console.log(`Frida Android interception started: ${appId} on ${hostId} forwarding to ${proxyIp}:${proxyPort}`);

        return session;
    } catch (e) {
        // If anything goes wrong, just make sure we shut down the app again
        await killProcess(session).catch(console.log)
        throw e;
    }
}
