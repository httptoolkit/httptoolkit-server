import { UsbmuxClient } from 'usbmux-client';
import * as FridaJs from 'frida-js';

import { buildIosFridaScript } from './frida-scripts';

import {
    FRIDA_DEFAULT_PORT,
    FridaHost,
    killProcess,
    launchScript,
    testAndSelectProxyAddress
} from './frida-integration';

const isDevicePortOpen = (usbmuxClient: UsbmuxClient, deviceId: number, port: number) =>
    usbmuxClient.createDeviceTunnel(deviceId, port).then((conn) => {
        // If the connection opened at all, then something is listening...
        conn.on('error', () => {});
        conn.end();
        return true;
    }).catch((e) => {
        // If the port is closed, we jump straight to the error state instead
        return false;
    });

// We scan frequently, but we don't want to spam the logs, so we just log each time
// Usbmux changes state (just for general reference of any issues).
let lastUsbmuxState: boolean | undefined = undefined;

export async function getIosFridaHosts(usbmuxClient: UsbmuxClient): Promise<Record<string, FridaHost>> {
    const devices = await usbmuxClient.getDevices()
    .then((devices) => {
        if (!lastUsbmuxState) {
            console.log('Usbmux iOS scanning connected');
            lastUsbmuxState = true;
        }
        return devices;
    }).catch((e) => {
        if (lastUsbmuxState !== false) {
            console.log(`Usbmux iOS scanning failed: ${e.message ?? e}`);
            lastUsbmuxState = false;
        }
        return [];
    });

    return Object.fromEntries(await Promise.all(
        Object.values(devices) // N.b. we drop the key, which is just an index (not a useful consistent id)
        .map(async (device): Promise<[string, FridaHost]> => {
            const details = await getHostDetails(usbmuxClient, device.DeviceID);
            return [
                details.id, {
                    ...device,
                    type: 'ios',
                    id: details.id, // iOS HostId !== DeviceId
                    name: details.name,
                    state: details.state
                }
            ];
        })
    ));
}

const HOST_ID_SEPARATOR = '---';

const getHostDetails = async (usbmuxClient: UsbmuxClient, deviceId: number) => {
    const deviceMetadataPromise = usbmuxClient.queryAllDeviceValues(deviceId);

    let state: FridaHost['state'] = 'unavailable';

    // We run state checks in series, not parallel - slower, but less hammering of
    // ADB APIs & device processing, and no running any unnecessary checks.

    const defaultPortOpen = await isDevicePortOpen(usbmuxClient, deviceId, FRIDA_DEFAULT_PORT);
    if (defaultPortOpen) {
        state = 'available';
    } else {
        // No Frida - no way to detect jailbreak (yet?) - nothing we can do.
        state = 'unavailable';
    }

    const deviceMetadata = await deviceMetadataPromise;
    const deviceName = deviceMetadata.DeviceName ??
        deviceMetadata.DeviceClass ??
        'Unknown iOS Device';

    return {
        id: `${deviceId}${HOST_ID_SEPARATOR}${deviceMetadata.UniqueDeviceID}`, // Host id = both (to avoid deviceid change races)
        name: deviceName,
        type: 'ios',
        state
    } as const;
};

async function getDeviceId(usbmuxClient: UsbmuxClient, hostId: string) {
    const parts = hostId.split(HOST_ID_SEPARATOR);
    const deviceId = parseInt(parts[0]);
    const udid = parts.slice(1).join(HOST_ID_SEPARATOR);

    const realUdid = await usbmuxClient.queryDeviceValue(deviceId, 'UniqueDeviceID');

    if (udid !== realUdid) throw new Error(`Device ID mismatch: ${udid} vs ${realUdid}`);

    return deviceId;
};

export async function getIosFridaTargets(usbmuxClient: UsbmuxClient, hostId: string) {
    const deviceId = await getDeviceId(usbmuxClient, hostId);

    // Since we don't start Frida ourselves, alt port will never be used
    const fridaStream = await usbmuxClient.createDeviceTunnel(deviceId, FRIDA_DEFAULT_PORT);

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
    'com.spotify.client': [4070]
};

export async function interceptIosFridaTarget(
    usbmuxClient: UsbmuxClient,
    hostId: string,
    appId: string,
    caCertContent: string,
    proxyPort: number
) {
    console.log(`Intercepting ${appId} via iOS Frida on ${hostId}...`);
    const deviceId = await getDeviceId(usbmuxClient, hostId);
    const fridaStream = await usbmuxClient.createDeviceTunnel(deviceId, FRIDA_DEFAULT_PORT);

    const fridaSession = await FridaJs.connect({
        stream: fridaStream
    });

    const { session } = await fridaSession.spawnPaused(appId, undefined);

    try {
        const proxyIp = await testAndSelectProxyAddress(session, proxyPort);

        const interceptionScript = await buildIosFridaScript(
            caCertContent,
            proxyIp,
            proxyPort,
            KNOWN_APP_PROBLEMATIC_PORTS[appId] ?? []
        );

        await launchScript(`iOS (${appId})`, session, interceptionScript);
        await session.resume();
        console.log(`Frida iOS interception started: ${appId} on ${hostId} forwarding to ${proxyIp}:${proxyPort}`);

        return session;
    } catch (e) {
        // If anything goes wrong, just make sure we shut down the app again
        await killProcess(session).catch(console.log);
        throw e;
    }
}