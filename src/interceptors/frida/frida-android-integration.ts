import { Client as AdbClient, DeviceClient } from '@devicefarmer/adbkit';
import * as FridaJs from 'frida-js';

import {
    EMULATOR_HOST_IPS,
    createPersistentReverseTunnel,
    getConnectedDevices,
    getRootCommand,
    isProbablyRooted
} from '../android/adb-commands';
import { waitUntil } from '../../util/promise';
import { buildAndroidFridaScript } from './frida-scripts';
import {
    FRIDA_ALTERNATE_PORT,
    FRIDA_BINARY_NAME,
    FRIDA_DEFAULT_PORT,
    FRIDA_VERSION,
    FridaHost,
    testAndSelectProxyAddress
} from './frida-integration';

const ANDROID_DEVICE_HTK_PATH = '/data/local/tmp/.httptoolkit';
const ANDROID_FRIDA_BINARY_PATH = `${ANDROID_DEVICE_HTK_PATH}/${FRIDA_BINARY_NAME}`;

const ALL_X_PERMS = 0o00111;

const isFridaInstalled = (deviceClient: DeviceClient) =>
    deviceClient.readdir(ANDROID_DEVICE_HTK_PATH)
    .then((entries) => entries.some((entry) =>
        entry.name === FRIDA_BINARY_NAME &&
        (entry.mode & ALL_X_PERMS) !== 0
    ))
    .catch(() => false);

const isDevicePortOpen = (deviceClient: DeviceClient, port: number) =>
    deviceClient.openTcp(port).then((conn) => {
        // If the connection opened at all, then something is listening...
        conn.on('error', () => {});
        conn.end();
        return true;
    }).catch(() => {
        // If the port is closed, we jump straight to the error state instead
        return false
    });

export async function getAndroidFridaHosts(adbClient: AdbClient): Promise<FridaHost[]> {
    const devices = await getConnectedDevices(adbClient);

    const result = await Promise.all(
        devices.map((deviceId) => getHostStatus(adbClient, deviceId)
    ));

    return result;
}

const getHostStatus = async (adbClient: AdbClient, deviceId: string) => {
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

    return {
        id: deviceId,
        name: deviceId,
        type: 'android',
        state
    } as const;
};

const ANDROID_ABI_FRIDA_ARCH_MAP = {
    'arm64-v8a': 'arm64',
    'armeabi': 'arm',
    'armabi-v7a': 'arm',
    'x86': 'x86',
    'x86_64': 'x86_64'
} as const;

export async function setupAndroidHost(adbClient: AdbClient, hostId: string) {
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

    const serverStream = await FridaJs.downloadFridaServer({
        version: FRIDA_VERSION,
        platform: 'android',
        arch: deviceArch
    });

    await deviceClient.push(serverStream, ANDROID_FRIDA_BINARY_PATH, 0o555);
}

export async function launchAndroidHost(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

    const runAsRoot = await getRootCommand(deviceClient);

    if (!runAsRoot) {
        throw new Error("Couldn't get root access to launch Frida Server");
    }

    const fridaServerStream = await deviceClient.shell(
        runAsRoot(ANDROID_FRIDA_BINARY_PATH, '-l', `127.0.0.1:${FRIDA_ALTERNATE_PORT}`)
    );
    fridaServerStream.pipe(process.stdout);

    // Wait until the server becomes accessible
    try {
        await waitUntil(500, 10, async () => {
            try {
                const status = await getHostStatus(adbClient, hostId);
                return status.state === 'available';
            } catch (e: any) {
                console.log(e.message ?? e);
                return false;
            }

        });
    } catch (e: any) {
        console.log(e.message ?? e);
        throw new Error(`Failed to launch Frida server for ${hostId}`);
    }
}

export async function getAndroidFridaTargets(adbClient: AdbClient, hostId: string) {
    const deviceClient = adbClient.getDevice(hostId);

     // Try alt port first (preferred and more likely to work - it's ours)
     const fridaStream = await deviceClient.openTcp(FRIDA_ALTERNATE_PORT)
     .catch(() => deviceClient.openTcp(FRIDA_DEFAULT_PORT));

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const apps = await fridaSession.enumerateApplications();
    fridaSession.disconnect().catch(() => {});
    return apps;
}

export async function interceptAndroidFridaTarget(
    adbClient: AdbClient,
    hostId: string,
    appId: string,
    caCertContent: string,
    proxyPort: number
) {
    const deviceClient = adbClient.getDevice(hostId);

    await createPersistentReverseTunnel(deviceClient, proxyPort, proxyPort)
        .catch(() => {}); // If we can't tunnel that's OK - we'll use wifi/etc instead

    // Try alt port first (preferred and more likely to work - it's ours)
    const fridaStream = await deviceClient.openTcp(FRIDA_ALTERNATE_PORT)
        .catch(() => deviceClient.openTcp(FRIDA_DEFAULT_PORT));

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
            proxyPort
        );

        const scriptSession = await session.createScript(interceptionScript);

        let scriptLoaded = false;
        await new Promise((resolve, reject) => {
            session.onMessage((message) => {
                if (message.type === 'error') {
                    const error = new Error(message.description);
                    error.stack = message.stack;

                    if (!scriptLoaded) {
                        reject(error);
                    } else {
                        console.warn('Frida Android injection error:', error);
                    }
                } else if (message.type === 'log') {
                    console.log(`Frida Android [${message.level}]: ${message.payload}`);
                } else {
                    console.log(message);
                }
            });

            scriptSession.loadScript()
                .then(resolve)
                .catch(reject);
        });

        scriptLoaded = true;
        await session.resume();
    } catch (e) {
        // If anything goes wrong, just make sure we shut down the app again
        await session.kill();
        throw e;
    }
}
