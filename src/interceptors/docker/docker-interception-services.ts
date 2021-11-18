import * as Docker from 'dockerode';
import { ProxySettingCallback } from 'mockttp';

import { reportError } from '../../error-tracking';
import { addShutdownHandler } from '../../shutdown';

import { DOCKER_BUILD_LABEL } from './docker-build-injection';
import { DOCKER_CONTAINER_LABEL } from './docker-commands';

import { getDnsServer } from '../../dns-server';
import {
    monitorDockerNetworkAliases,
    stopMonitoringDockerNetworkAliases
} from './docker-networking';
import { ensureDockerProxyRunning, stopDockerProxy } from './docker-proxy';
import {
    prepareDockerTunnel,
    getDockerTunnelPort,
    ensureDockerTunnelRunning,
    stopDockerTunnel,
} from './docker-tunnel-proxy';

export const isDockerAvailable = () =>
    (async () => new Docker().ping())() // Catch sync & async setup errors
    .then(() => true)
    .catch(() => false);

const IPv4_IPv6_PREFIX = "::ffff:";

// On shutdown, clean up every container & image that we created, disappearing
// into the mist as if we were never here...
// (Those images/containers are unusable without us, so leaving them breaks things).
addShutdownHandler(async () => {
    if (!await isDockerAvailable()) return;
    await deleteAllInterceptedDockerData('all');
});

export async function startDockerInterceptionServices(
    proxyPort: number,
    httpsConfig: { certPath: string, certContent: string },
    ruleParameters: { [key: `docker-tunnel-proxy-${number}`]: ProxySettingCallback }
) {
    // Prepare (pull) the tunnel image, but we don't actually start the tunnel itself until some
    // Docker interception happens while HTTP Toolkit is running - e.g. proxy use, container attach,
    // or an intercepted container connecting to a network.
    prepareDockerTunnel();
    const networkMonitor = monitorDockerNetworkAliases(proxyPort);

    ruleParameters[`docker-tunnel-proxy-${proxyPort}`] = async ({ hostname }: { hostname: any }) => {
        hostname = hostname.startsWith(IPv4_IPv6_PREFIX)
            ? hostname.slice(IPv4_IPv6_PREFIX.length)
            : hostname;

        if ((await networkMonitor)?.dockerRoutedAliases.has(hostname)) {
            return {
                proxyUrl: `socks5://127.0.0.1:${await getDockerTunnelPort(proxyPort)}`
            };
        }
    };

    await Promise.all([
        // Proxy all terminal Docker API requests, to rewrite & add injection:
        ensureDockerProxyRunning(proxyPort, httpsConfig),
        // Ensure the DNS server is running to handle unresolvable container addresses:
        getDnsServer(proxyPort),
        // Monitor the intercepted containers, to resolve their names in our DNS:
        networkMonitor
    ]);
}

export async function ensureDockerServicesRunning(proxyPort: number) {
    await Promise.all([
        monitorDockerNetworkAliases(proxyPort),
        ensureDockerTunnelRunning(proxyPort),
        getDnsServer(proxyPort)
    ]).catch(reportError);
}

export async function stopDockerInterceptionServices(
    proxyPort: number,
    ruleParameters: { [key: `docker-tunnel-proxy-${number}`]: ProxySettingCallback }
) {
    stopDockerProxy(proxyPort);
    stopMonitoringDockerNetworkAliases(proxyPort);
    await deleteAllInterceptedDockerData(proxyPort);
    delete ruleParameters[`docker-tunnel-proxy-${proxyPort}`];
}

// Batch deactivations - if we're already shutting down, don't shut down again until
// the previous shutdown completes.
const pendingDeactivations: {
    [port: number]: Promise<void> | undefined
    'all'?: Promise<void>
} = {}

// When a Docker container or the whole server shuts down, we do our best to delete
// every remaining intercepted image or container. None of these will be usable
// without us anyway, as they all depend on HTTP Toolkit for connectivity.
export async function deleteAllInterceptedDockerData(proxyPort: number | 'all'): Promise<void> {
    if (pendingDeactivations[proxyPort]) return pendingDeactivations[proxyPort];
    if (!await isDockerAvailable()) return;

    return pendingDeactivations[proxyPort] = Promise.all([
        stopDockerTunnel(proxyPort),
        (async () => {
            const docker = new Docker();

            const containers = await docker.listContainers({
                all: true,
                filters: JSON.stringify({
                    label: [
                        proxyPort === 'all'
                        ? DOCKER_CONTAINER_LABEL
                        : `${DOCKER_CONTAINER_LABEL}=${proxyPort}`
                    ]
                })
            });

            await Promise.all(containers.map(async (containerData) => {
                const container = docker.getContainer(containerData.Id);

                // Best efforts clean stop & remove:
                await container.stop({ t: 1 }).catch(() => {});
                await container.remove({ force: true }).catch(() => {});
            }));

            // We clean up images after containers, in case some containers depended
            // on some images that we intercepted.
            const images = await docker.listImages({
                all: true,
                filters: JSON.stringify({
                    label: [
                        proxyPort === 'all'
                        ? DOCKER_BUILD_LABEL
                        : `${DOCKER_BUILD_LABEL}=${proxyPort}`
                    ]
                })
            });

            await Promise.all(images.map(async (imageData) => {
                await docker.getImage(imageData.Id).remove().catch(() => {});
            }));

            // Unmark this deactivation as pending
            delete pendingDeactivations[proxyPort];
        })()
    ]) as Promise<unknown> as Promise<void>;
}