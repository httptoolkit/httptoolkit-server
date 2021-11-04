import _ = require('lodash');
import * as Docker from 'dockerode';
import * as semver from 'semver';
import { Mutex } from 'async-mutex';

import { DOCKER_HOST_HOSTNAME, isImageAvailable } from './docker-commands';
import { isDockerAvailable } from './docker-interception-services';

const DOCKER_TUNNEL_IMAGE = "httptoolkit/docker-socks-tunnel:v1.1.0";
const DOCKER_TUNNEL_LABEL = "tech.httptoolkit.docker.tunnel";

const getDockerTunnelContainerName = (proxyPort: number) =>
    `httptoolkit-docker-tunnel-${proxyPort}`;

// Parallel mutation of a single Docker container's state is asking for trouble, so we use
// a simple lock over all operations (across all proxes, not per-proxy, just for simplicity/safety).
const containerMutex = new Mutex();

// Starts pulling the docker tunnel image, just to ensure it's available if we need it.
export async function prepareDockerTunnel() {
    if (!await isDockerAvailable()) return;

    await containerMutex.runExclusive(async () => {
        console.log('pull got lock');
        const docker = new Docker();
        if (await isImageAvailable(docker, DOCKER_TUNNEL_IMAGE)) return;
        else await docker.pull(DOCKER_TUNNEL_IMAGE).catch(console.warn);
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

    console.log('ensure tunnel running on port', proxyPort);
    ongoingEnsureTunnelRunningChecks[proxyPort] = containerMutex.runExclusive(async () => {
        console.log('ensure got lock');
        const docker = new Docker();

        // Make sure we have the image available (should've been pre-pulled, but just in case)
        if (!await docker.getImage(DOCKER_TUNNEL_IMAGE).inspect().catch(() => false)) {
            await docker.pull(DOCKER_TUNNEL_IMAGE);
        }

        // Ensure we have a ready-to-use container here:
        const containerName = getDockerTunnelContainerName(proxyPort);
        let container = await docker.getContainer(containerName)
            .inspect().catch(() => undefined);
        if (!container) {
            const versionData = await docker.version();
            const engineVersion = semver.coerce(versionData.Version) || '0.0.0';

            const defaultBridgeGateway = await docker.listNetworks({
                filters: JSON.stringify({
                    driver: ['bridge'],
                    type: ['builtin']
                })
            }).then(([builtinBridge]) =>
                builtinBridge?.IPAM?.Config?.[0].Gateway
            );

            await docker.createContainer({
                name: containerName,
                Image: DOCKER_TUNNEL_IMAGE,
                Labels: {
                    [DOCKER_TUNNEL_LABEL]: String(proxyPort)
                },
                HostConfig: {
                    AutoRemove: true,
                    ...(process.platform === 'linux' ? {
                        ExtraHosts: [
                            // Make sure the host hostname is defined (not set by default on Linux).
                            // We use the host-gateway address on engines where that's possible, or
                            // the default Docker bridge host IP when it's not, because we're always
                            // connected to that network.
                            `${DOCKER_HOST_HOSTNAME}:${
                                semver.satisfies(engineVersion, '>= 20.10')
                                    ? 'host-gateway'
                                    : defaultBridgeGateway || '172.17.0.1'
                            }`
                            // (This doesn't reuse getDockerHostIp, since the logic is slightly
                            // simpler  and we never have container metadata/network state).
                        ]
                    } : {}),
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
            await docker.getContainer(container.Id).start();
            console.log('started tunnel container');
        }

        // Asynchronously, update the Docker port that's in use for this container.
        portCache[proxyPort] = refreshDockerTunnelPortCache(proxyPort);
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
    console.log('update docker networks', interceptedNetworks);

    const docker = new Docker();

    const defaultBridgeId = docker.listNetworks({
        filters: JSON.stringify({
            driver: ['bridge'],
            type: ['builtin']
        })
    }).then(([builtinBridge]) => builtinBridge?.Id);

    console.log('checking container');
    const containerName = getDockerTunnelContainerName(proxyPort);
    await docker.getContainer(containerName).inspect().catch(() =>
        ensureDockerTunnelRunning(proxyPort)
    );
    console.log('checked');

    await containerMutex.runExclusive(async () => {
        console.log('update got lock');
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

export async function refreshDockerTunnelPortCache(proxyPort: number): Promise<number> {
    try {
        if (_.isObject(portCache[proxyPort])) {
            // If there's an existing promise refreshing this data, then don't duplicate:
            return portCache[proxyPort]!
        }

        const docker = new Docker();

        const containerName = getDockerTunnelContainerName(proxyPort);
        let container = await docker.getContainer(containerName)
            .inspect().catch(() => undefined);
        if (!container) {
            // Can't get the container - recreate it (refreshing the port automatically)
            return ensureDockerTunnelRunning(proxyPort)
                .then(() => getDockerTunnelPort(proxyPort));
        }

        const portMappings = container.NetworkSettings.Ports['1080/tcp'];
        const localPort = _.find(portMappings, ({ HostIp }) => HostIp === '127.0.0.1');

        if (!localPort) {
            // This can happen if the networks of the container are changed manually. In some cases
            // this can result in the mapping being lots. Kill & restart the container.
            return docker.getContainer(containerName).kill()
                .then(() => ensureDockerTunnelRunning(proxyPort))
                .then(() => getDockerTunnelPort(proxyPort));
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
    console.log('stopping docker tunnel');

    await containerMutex.runExclusive(async () => {
        console.log('stop got lock');
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

    console.log('stopped docker tunnel');
}