import _ = require('lodash');
import Docker from 'dockerode';
import { Mutex } from 'async-mutex';
import { delay } from '@httptoolkit/util';

import { isImageAvailable } from './docker-commands';
import { isDockerAvailable } from './docker-interception-services';
import { logError } from '../../error-tracking';
import { waitForDockerStream } from './docker-utils';

const DOCKER_TUNNEL_IMAGE = "httptoolkit/docker-socks-tunnel:v1.2.0";
const DOCKER_TUNNEL_LABEL = "tech.httptoolkit.docker.tunnel";

const getDockerTunnelContainerName = (proxyPort: number) =>
    `httptoolkit-docker-tunnel-${proxyPort}`;

const pullTunnelImage = (docker: Docker) =>
    docker.pull(DOCKER_TUNNEL_IMAGE)
    .then(stream => waitForDockerStream(docker, stream));

// Parallel mutation of a single Docker container's state is asking for trouble, so we use
// a simple lock over all operations (across all proxes, not per-proxy, just for simplicity/safety).
const containerMutex = new Mutex();

// Starts pulling the docker tunnel image, just to ensure it's available if we need it.
export async function prepareDockerTunnel() {
    if (!await isDockerAvailable()) return;

    await containerMutex.runExclusive(async () => {
        const docker = new Docker();
        if (await isImageAvailable(docker, DOCKER_TUNNEL_IMAGE)) return;
        else await pullTunnelImage(docker).catch(console.warn);
    });
}

// We use this to avoid duplicate ensureRunning calls - collapsing them instead into a single promise.
const ongoingEnsureTunnelRunningChecks: { [port: number]: Promise<void> | undefined } = {};

// Fully check that the container is created, up & running, recreating it if not.
// This does *not* connect any networks, so most usage will need to connect up the
// networks with updateTunnelledNetworks afterwards.
export function ensureDockerTunnelRunning(proxyPort: number) {
    if (ongoingEnsureTunnelRunningChecks[proxyPort]) {
        return ongoingEnsureTunnelRunningChecks[proxyPort]!;
    }

    ongoingEnsureTunnelRunningChecks[proxyPort] = containerMutex.runExclusive(async () => {
        const docker = new Docker();

        // Ensure we have a ready-to-use container here:
        const containerName = getDockerTunnelContainerName(proxyPort);
        let container = await docker.getContainer(containerName)
            .inspect().catch(() => undefined);
        if (!container) {
            // Make sure we have the image available (should've been pre-pulled, but just in case)
            if (!await docker.getImage(DOCKER_TUNNEL_IMAGE).inspect().catch(() => false)) {
                await pullTunnelImage(docker);
            }

            await docker.createContainer({
                name: containerName,
                Image: DOCKER_TUNNEL_IMAGE,
                Labels: {
                    [DOCKER_TUNNEL_LABEL]: String(proxyPort)
                },
                HostConfig: {
                    AutoRemove: true,
                    PortBindings: {
                        '1080/tcp': [{
                            // Bind host-locally only: we don't want to let remote clients
                            // tunnel directly to any Docker container they like. Of course
                            // we expose HTTP access via the proxy, but that's at least
                            // fully visible & quite limited.
                            HostIp: '127.0.0.1'
                            // No port specified - Docker will choose any free port
                        }]
                    }
                },
            });
            container = await docker.getContainer(containerName).inspect();
        }

        // Make sure the tunneling container is running:
        if (!container.State.Running) {
            console.log("Starting Docker tunnel...");
            await docker.getContainer(container.Id).start();
        }

        const containerPortMappings = container.NetworkSettings.Ports['1080/tcp'];
        const localTunnelPort = _.find(containerPortMappings, ({ HostIp }) => HostIp === '127.0.0.1');
        if (!_.isObject(portCache[proxyPort]) && localTunnelPort?.HostPort !== String(portCache[proxyPort])) {
            // If the tunnel port may be outdated (port changed, or missing, or container just started so
            // port here is undefined) then schedule an async tunnel port refresh:

            const refreshTunnelPort = delay(10).then(
                () => // Leave time for the port to bind
                    refreshDockerTunnelPortCache(proxyPort, {
                        // Force, because otherwise we get into a loop here due to the delay().
                        force: true
                    })
            );
            portCache[proxyPort] = refreshTunnelPort;
            refreshTunnelPort.catch(logError);
        }
    }).finally(() => {
        // Clean up the promise, so that future calls to ensureRunning re-run this check.
        ongoingEnsureTunnelRunningChecks[proxyPort] = undefined;
    });

    return ongoingEnsureTunnelRunningChecks[proxyPort]!;
}

// Update the containers network connections. If the container isn't running, this
// will automatically run ensureDockerTunnelRunning to bring it back up.
export async function updateDockerTunnelledNetworks(
    proxyPort: number,
    interceptedNetworks: string[]
) {
    if (interceptedNetworks.length) {
        console.log(`Updating intercepted Docker networks to: ${interceptedNetworks.join(', ')}`);
    } else {
        console.log('No Docker networks contain intercepted containers');
    }

    const docker = new Docker();

    const defaultBridgeId = docker.listNetworks({
        filters: JSON.stringify({
            driver: ['bridge'],
            type: ['builtin']
        })
    }).then(([builtinBridge]) => builtinBridge?.Id);

    const containerName = getDockerTunnelContainerName(proxyPort);
    await docker.getContainer(containerName).inspect().catch(() =>
        ensureDockerTunnelRunning(proxyPort)
    );

    await containerMutex.runExclusive(async () => {
        // Inspect() must happen inside the lock to avoid any possible races.
        const container = await docker.getContainer(containerName).inspect()
            .catch(() => undefined);

        if (!container) {
            // We checked this before, so if it's now missing again then we're probably in
            // some race where the tunnel & other containers are being stopped en masse, or
            // some odd shutdown condition. Not the end of the world - just skip this update.
            return;
        }

        const expectedNetworks = _.uniq([
            ...interceptedNetworks,
            // We must always stay connected to the default bridge, to ensure that we
            // always have connectivity to the host via the default bridge gateway:
            await defaultBridgeId
        ]);

        const currentNetworks = Object.values(container.NetworkSettings.Networks)
            .map((network) => network.NetworkID);

        const missingNetworks = expectedNetworks
            .filter((network) => !currentNetworks.includes(network));

        const extraNetworks = currentNetworks
            .filter((network) => !expectedNetworks.includes(network));

        await Promise.all([
            ...missingNetworks.map(async (network) =>
                await docker.getNetwork(network)
                    .connect({ Container: container!.Id })
            ),
            ...extraNetworks.map(async (network) =>
                await docker.getNetwork(network)
                    .disconnect({ Container: container!.Id })
            ),
        ]);
    });
}

// A map of proxy port (e.g. 8000) to the automatically mapped Docker tunnel port.
// Refreshed if it's somehow missing, or on every call to ensureDockerTunnelRunning(), e.g.
// async at every docker-proxy request, every network event & every container interception.
const portCache: { [proxyPort: string]: number | Promise<number> | undefined } = {};

export async function getDockerTunnelPort(proxyPort: number): Promise<number> {
    if (!portCache[proxyPort]) {
        // Update the port and wait for the query to complete:
        portCache[proxyPort] = refreshDockerTunnelPortCache(proxyPort);
    }

    return portCache[proxyPort]!;
}

async function refreshDockerTunnelPortCache(proxyPort: number, { force } = { force: false }): Promise<number> {
    console.log("Querying Docker tunnel port...");
    try {
        if (!force && _.isObject(portCache[proxyPort])) {
            // If there's an existing promise refreshing this data, then don't duplicate:
            return portCache[proxyPort]!
        }

        const docker = new Docker();

        const containerName = getDockerTunnelContainerName(proxyPort);
        let container = await docker.getContainer(containerName)
            .inspect().catch(() => undefined);
        if (!container) {
            // Can't get the container - recreate it (refreshing the port automatically)
            await ensureDockerTunnelRunning(proxyPort);
            return refreshDockerTunnelPortCache(proxyPort, { force: true });
        }

        const portMappings = container.NetworkSettings.Ports['1080/tcp'];
        const localPort = _.find(portMappings, ({ HostIp }) => HostIp === '127.0.0.1');

        if (!localPort) {
            // This can happen if the networks of the container are changed manually, which can lose some
            // mappings, or if the container is being shut down. Kill & restart the container:
            await docker.getContainer(containerName).kill().catch((e) => {
                // If the container now doesn't exist/is stopped (due to a race condition) that's fine too:
                if (e.statusCode === 404 || e.statusCode === 409) return;
                else throw e;
            });

            await ensureDockerTunnelRunning(proxyPort);
            await delay(10); // Wait for the port to bind after startup
            return refreshDockerTunnelPortCache(proxyPort, { force: true });
        }

        const port = parseInt(localPort.HostPort, 10);

        portCache[proxyPort] = port;
        return port;
    } catch (e) {
        // If something goes wrong, reset the port cache, to ensure that future checks
        // will query again from scratch:
        portCache[proxyPort] = undefined;
        throw e;
    }
}

export async function stopDockerTunnel(proxyPort: number | 'all'): Promise<void> {
    const docker = new Docker();

    await containerMutex.runExclusive(async () => {
        const containers = await docker.listContainers({
            all: true,
            filters: JSON.stringify({
                label: [
                    proxyPort === 'all'
                    ? DOCKER_TUNNEL_LABEL
                    : `${DOCKER_TUNNEL_LABEL}=${proxyPort}`
                ]
            })
        });

        await Promise.all(containers.map(async (containerData) => {
            const container = docker.getContainer(containerData.Id);
            await container.remove({ force: true }).catch(() => {});
        }));
    });
}