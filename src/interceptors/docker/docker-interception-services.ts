import Docker from 'dockerode';
import { ProxySettingCallback } from 'mockttp';

import { logError } from '../../error-tracking';
import { addShutdownHandler } from '../../shutdown';

import { getDockerAddress } from './docker-utils';
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
import { ensureDockerInjectionVolumeExists } from './docker-data-injection';

let dockerAvailableCache: Promise<boolean> | undefined;

export const isDockerAvailable = (options: { logError?: boolean } = {}) => {
    if (dockerAvailableCache) return dockerAvailableCache;
    else {
        dockerAvailableCache = (async () => { // Catch sync & async setup errors
            return new Docker().info();
        })()
        .then((info: { OSType?: 'windows' | 'linux' }) => {
            if (info.OSType === 'windows') {
                // We don't support Windows containers yet (and I think they're very rarely
                // used anyway) so we treat Windows-mode Docker as unavailable:
                throw new Error("Docker running in Windows container mode - not supported");
            } else {
                return true;
            }
        })
        .catch((error) => {
            if (options.logError) console.warn('Docker not available:', error.message);
            return false;
        });

        // Cache the resulting status for 3 seconds:
        setTimeout(() => { dockerAvailableCache = undefined; }, 3000);

        return dockerAvailableCache;
    }
}

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
    // For now we don't support SSH-based Docker connections at all - for starters,
    // they won't be able to use the file system references we set up. If you try
    // to set one, we just ignore it.
    if (process.env.DOCKER_HOST?.startsWith('ssh://')) {
        console.log(`Ignoring unsupported DOCKER_HOST value: ${
            process.env.DOCKER_HOST
        }`);
        delete process.env.DOCKER_HOST;
    }

    // Log if Docker was not available at proxy start, and why, for debugging later:
    isDockerAvailable({ logError: true }).then(async (isAvailable) => {
        if (isAvailable) {
            const dockerAddress = await getDockerAddress(new Docker());
            console.log(`Connected to Docker at ${
                'socketPath' in dockerAddress
                ? dockerAddress.socketPath
                : `tcp://${dockerAddress.host}:${dockerAddress.port}`
            }`);
        }
        // logError:true will log the specific not-available error, if this failed
    });

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
        networkMonitor,
        // Prepare (pull) the tunnel image (but don't actually start the tunnel itself until
        // Docker activity happens - e.g. proxy use, container attach, or an intercepted
        // container connecting to a network):
        prepareDockerTunnel(),
        // Create a Docker volume, containing our cert and the override files:
        ensureDockerInjectionVolumeExists(httpsConfig.certContent)
    ]);
}

export async function ensureDockerServicesRunning(proxyPort: number) {
    await Promise.all([
        monitorDockerNetworkAliases(proxyPort),
        ensureDockerTunnelRunning(proxyPort),
        getDnsServer(proxyPort),
        // We don't double-check on the injection volume here - that's
        // checked separately at the point of use instead.
    ]).catch(logError);
}

export async function stopDockerInterceptionServices(
    proxyPort: number,
    ruleParameters: { [key: `docker-tunnel-proxy-${number}`]: ProxySettingCallback }
) {
    stopDockerProxy(proxyPort);
    stopMonitoringDockerNetworkAliases(proxyPort);
    await deleteAllInterceptedDockerData(proxyPort);
    delete ruleParameters[`docker-tunnel-proxy-${proxyPort}`];
    // Note that we _don't_ drop the data volume, we're OK with leaving that
    // around since it's invisible, tiny, and mildly expensive (a few seconds)
    // to recreate.
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