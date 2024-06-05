import { UsbmuxClient } from 'usbmux-client';
import * as FridaJs from 'frida-js';

import { buildIosFridaScript } from './frida-scripts';

import {
    FRIDA_DEFAULT_PORT,
    FridaHost,
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

// We scan frequently, but we don't want to spam the logs, so we just log the first
// time that we fail to reach Usbmux (just for general reference of any issues).
let loggedUsbmuxFailure = false;

export async function getIosFridaHosts(usbmuxClient: UsbmuxClient): Promise<FridaHost[]> {
    const devices = await usbmuxClient.getDevices().catch((e) => {
        if (!loggedUsbmuxFailure) {
            console.log('Usbmux iOS scanning failed:', e.message);
            loggedUsbmuxFailure = true;
        }
        return [];
    });

    const result = await Promise.all(
        Object.values(devices).map(({ DeviceID }) => getHostStatus(usbmuxClient, DeviceID as number)
    ));

    return result;
}

const getHostStatus = async (usbmuxClient: UsbmuxClient, deviceId: number) => {
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
        id: `${deviceId}-${deviceMetadata.UniqueDeviceID}`, // Host id = both (to avoid deviceid change races)
        name: deviceName,
        type: 'ios',
        state
    } as const;
};

async function getDeviceId(usbmuxClient: UsbmuxClient, hostId: string) {
    const parts = hostId.split('-');
    const deviceId = parseInt(parts[0]);
    const udid = parts[1];

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

export async function interceptIosFridaTarget(
    usbmuxClient: UsbmuxClient,
    hostId: string,
    appId: string,
    caCertContent: string,
    proxyPort: number
) {
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
                        console.warn('Frida iOS injection error:', error);
                    }
                } else if (message.type === 'log') {
                    console.log(`Frida iOS [${message.level}]: ${message.payload}`);
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