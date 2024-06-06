import * as FridaJs from 'frida-js';
import { CustomError } from '@httptoolkit/util';

import { getReachableInterfaces } from '../../util/network';
import { buildIpTestScript } from './frida-scripts';

/**
 * Terminology:
 * - FridaHost: a device which may contain 1+ Frida targets
 * - FridaTarget: a single app that can be intercepted
 **/

export interface FridaHost {
    id: string;
    name: string;
    type: string;
    state:
        | 'unavailable' // Probably not Frida compatible (e.g. not rooted)
        | 'setup-required' // Probably compatible but Frida not installed
        | 'launch-required' // Frida installed, should work if launched
        | 'available', // Frida seems to be running & ready right now
    targets?: FridaTarget[]
}

export interface FridaTarget {
    id: string;
    name: string;
}

export const FRIDA_VERSION = '16.1.7';

export const FRIDA_DEFAULT_PORT = 27042;
export const FRIDA_ALTERNATE_PORT = 24072; // Reversed to mildly inconvenience detection

export const FRIDA_BINARY_NAME = `adirf-server`; // Reversed to mildly inconvenience detection

export async function testAndSelectProxyAddress(
    session: FridaJs.FridaAgentSession,
    proxyPort: number,
    options: { extraAddresses?: string[] } = {}
): Promise<string> {
    const interfaceAddresses = getReachableInterfaces();
    const ips = interfaceAddresses.map(a => a.address);

    if (options.extraAddresses?.length) {
        ips.push(...options.extraAddresses);
    }

    if (ips.length === 0) {
        throw new CustomError("Couldn't detect proxy external IP", {
            code: 'unreachable-proxy'
        });
    }

    const ipTestScript = await buildIpTestScript(ips, proxyPort);

    return await new Promise<string>(async (resolve, reject) => {
        try {
            session.onMessage((message) => {
                if (message.type === 'send') {
                    if (message.payload.type === 'connected') {
                        resolve(message.payload.ip as string);
                    } else if (message.payload.type === 'connection-failed') {
                        reject(new CustomError(`Could not connect to proxy on port ${proxyPort} at ${
                            ips.length > 1
                            ? `any of: ${ips.join(', ')}`
                            : ips[0]
                        }`, { code: 'unreachable-proxy' }));
                    } else {
                        reject(new Error(`Unexpected message type: ${message.payload.type}`));
                    }
                } else if (message.type === 'error') {
                    const error = new Error(message.description);
                    error.stack = message.stack;
                    reject(error);
                }
            });

            await (await session.createScript(ipTestScript)).loadScript();
        } catch (e) {
            reject(e);
        }
    });
}