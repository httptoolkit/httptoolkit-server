import * as _ from 'lodash';
import * as stream from 'stream';
import * as Docker from 'dockerode';
import * as EventStream from 'event-stream';
import * as mobx from 'mobx';

import { reportError } from '../../error-tracking';

import { DOCKER_HOST_HOSTNAME, isInterceptedContainer } from './docker-commands';
import { isDockerAvailable } from './docker-interception-services';
import {
    ensureDockerTunnelRunning,
    updateDockerTunnelledNetworks,
    updateDockerTunnelledMappedAliases
} from './docker-tunnel-proxy';

interface DockerEvent {
    Type: string;
    Action: string;
    Actor: {
        ID: string;
        Attributes: unknown;
    };
}

let dockerEventStream: NodeJS.ReadableStream | undefined;

/**
 * Get a stream of events from Docker. Although Dockerode will only give us the raw event buffers,
 * this creates a stream of parsed object data so we can easily process everything.
 *
 * The resulting stream is created on demand and cached. If there's any issues (errors or close
 * from docker itself) then the cache is dropped, so the next usage will recreate it.
 */
function getDockerEventStream(docker: Docker) {
    if (!dockerEventStream) {
        const dockerEventParsingStream = EventStream.pipeline(
            EventStream.split(),
            EventStream.mapSync((rawLine: Buffer) =>
                JSON.parse(rawLine.toString('utf8'))
            )
        );

        // We expose the stream immediately, even though no data is coming yet
        dockerEventStream = dockerEventParsingStream;

        // This gives us a stream of raw Buffer data. Inside, it contains
        // JSON strings, newline separated, which we parse above.
        (docker.getEvents() as Promise<stream.Readable>) // Wrong types, it's a raw http.IncomingMessage
            .then((rawEventStream) => {
                rawEventStream.pipe(dockerEventParsingStream);
                rawEventStream.on('error', (e) => {
                    dockerEventParsingStream?.emit('error', e);
                });
                rawEventStream.on('close', () => {
                    dockerEventParsingStream?.end(() => {});
                    dockerEventStream = undefined;
                });
            })
            .catch((e) => {
                dockerEventParsingStream?.emit('error', e);
                dockerEventStream = undefined;
            });
    }

    return dockerEventStream;
}

const dockerNetworkMonitors: { [proxyPort: string]: DockerNetworkMonitor | undefined } = {};

/**
 * Activate the network monitor for this proxy port, which will subscribe to Docker events,
 * track the aliases for Docker containers that our intercepted containers might want to
 * talk to, and ensure the tunnel for this proxy port is all the relevant networks to
 * allow tunnelling that traffic.
 *
 * This method has no effect (and no downside) if the monitor is already running, so it's
 * expected that this will be called whenever a user interacts with Docker in a way related
 * to HTTP Toolkit interception for this port. It's useful to call this often, because its
 * dependent on the events stream connection from Docker that may be fragile and need resetting,
 * in a way that other background services (like the proxy or tunnel container) are not.
 *
 * Network monitors are cached and run in the background, staying alive until either the
 * the Docker event stream shuts down (i.e. Docker engine disappears or similar) or it's
 * explicitly shut down with stopMonitoringDockerNetworkAliases for this proxy port.
 */
export async function monitorDockerNetworkAliases(proxyPort: number): Promise<DockerNetworkMonitor | undefined> {
    if (!await isDockerAvailable()) return undefined;

    if (!dockerNetworkMonitors[proxyPort]) {
        const docker = new Docker();

        const stream = getDockerEventStream(docker);
        stream.on('error', (e) => {
            console.log(`Docker stream for port ${proxyPort} hit an error`);
            reportError(e);
        });

        ensureDockerTunnelRunning(proxyPort);

        const networkMonitor = new DockerNetworkMonitor(docker, proxyPort, stream);
        mobx.autorun(() =>
            updateDockerTunnelledNetworks(proxyPort, networkMonitor.interceptedNetworks)
            .catch(console.warn)
        );
        mobx.autorun(() =>
            updateDockerTunnelledMappedAliases(proxyPort, networkMonitor.mappedInterceptionTargets)
            .catch(console.warn)
        );

        dockerNetworkMonitors[proxyPort] = networkMonitor;

        // If the stream is dead, this network monitor is no longer working - drop it.
        stream.on('close', async () => {
            if (dockerNetworkMonitors[proxyPort] === networkMonitor) {
                // We remove the registration in this case. If somebody calls this method later,
                // become some intercepted Docker activity has happened, then this will
                // reactivate (any hopefully the Docker stream will be usable again then)
                delete dockerNetworkMonitors[proxyPort];

                // We don't touch the tunnel container - that needs to be shut down separately.

                // Unsubscribe from all events
                networkMonitor.stop();
            }
        });
    }

    return dockerNetworkMonitors[proxyPort];
}

export function stopMonitoringDockerNetworkAliases(proxyPort: number) {
    const monitor = dockerNetworkMonitors[proxyPort];
    if (!monitor) return;

    delete dockerNetworkMonitors[proxyPort];
    monitor.stop();
}

/**
 * Network monitors tracks which networks the intercepted containers are connected to, and
 * monitors the network aliases & IPs accessible on those networks.
 */
class DockerNetworkMonitor {

    constructor(
        private docker: Docker,
        private proxyPort: number,
        private dockerEventStream: NodeJS.ReadableStream
    ) {
        // We use mobx here to automatically propagate updates whilst avoiding
        // unnecessary updates when nothing changes.
        mobx.makeObservable(this, {
            'interceptedNetworks': mobx.computed.struct,
            'interceptionTargetAliases': mobx.computed.struct,
            'mappedInterceptionTargets': mobx.computed.struct
        });

        dockerEventStream.on('data', this.onEvent);
        this.refreshAllNetworks();
    }

    async stop() {
        this.dockerEventStream.removeListener('data', this.onEvent);
    }

    private readonly networkTargets: {
        [networkId: string]: {
            // Aliases that the tunnel will be able to resolve itself by simply joining the network
            publicTargets: Array<string>,
            // Container-specific aliases, which need to be manually mapped (container links, ExtraHosts)
            mappedTargets: Array<{ alias: string, to: string }>
        }
    } = mobx.observable({});

    // The list of networks where interception is currently active:
    get interceptedNetworks() {
        return Object.keys(this.networkTargets);
    }

    // The list of aliases that should be resolvable by intercepted containers:
    get interceptionTargetAliases() {
        return new Set([
            ..._.flatMap(Object.values(this.networkTargets), ({ publicTargets, mappedTargets }) => [
                ...publicTargets,
                ...mappedTargets.map(link => link.alias)
            ]),
            // Always defined (by default on Mac & Windows, manually by us on Linux) as an
            // alias that links to the host itself. Doesn't need mapping: the tunnel will resolve
            // this correctly to the host OS in every environment.
            'host.docker.internal'
        ]);
    }

    // The list of mappings per-network, for aliases that should be resolveable, but aren't publicly
    // resolveable by default, such as links & ExtraHosts config:
    get mappedInterceptionTargets() {
        return _.flatten(
            Object.values(this.networkTargets)
            .map(({ mappedTargets }) => mappedTargets)
        );
    }

    onEvent = async (event: DockerEvent) => {
        if (event.Type !== 'network') return;

        if (event.Action === 'destroy') {
            // If the network is deleted, we definitely don't need its aliases anymore.
            const networkId = event.Actor.ID;
            if (networkId in this.networkTargets) {
                mobx.runInAction(() => {
                    delete this.networkTargets[event.Actor.ID];
                });
            }
        } else if (event.Action === 'connect' || event.Action === 'disconnect') {
            // If any containers are attached to the network, or removed from the network
            // then we just update all aliases. Exact changes are a little unpredictable,
            // and this is cheap enough to do every time:
            const networkAliases = await this.getNetworkAliases(event.Actor.ID);

            mobx.runInAction(() => {
                if (networkAliases) {
                    this.networkTargets[event.Actor.ID] = networkAliases;
                } else {
                    delete this.networkTargets[event.Actor.ID];
                }
            });
        }
    }

    private async refreshAllNetworks() {
        const networks = await this.docker.listNetworks();

        const networkMap = await Promise.all(
            networks.map(async (network) => {
                const aliases = await this.getNetworkAliases(network.Id);
                return [network.Id, aliases] as const;
            })
        );

        // We update the network targets in a batch action, to avoid churn in updating
        // the tunnel configuration later.
        mobx.runInAction(() => {
            networkMap.forEach(([networkId, networkAliases]) => {
                if (networkAliases) {
                    this.networkTargets[networkId] = networkAliases;
                } else {
                    delete this.networkTargets[networkId];
                }
            })
        });
    }

    private isInterceptedContainer(container: Docker.ContainerInspectInfo) {
        // Is this one of the containers we're supposed to be monitoring?
        return isInterceptedContainer(container, this.proxyPort);
    }

    private async getNetworkAliases(networkId: string) {
        const networkDetails: Docker.NetworkInspectInfo = await this.docker.getNetwork(networkId).inspect();
        const isDefaultBridge = networkDetails.Options?.['com.docker.network.bridge.default_bridge'] === 'true';

        const networkContainers = await Promise.all(
            Object.values(networkDetails.Containers ?? {}).map((networkContainer) =>
                this.docker.getContainer(networkContainer.Name).inspect()
            )
        );

        if (!networkContainers.find((container) => this.isInterceptedContainer(container))) {
            // If we're not tracking any containers in this network, we don't need its aliases.
            return;
        }

        const networkPublicAliases: string[] = [];
        const networkMappedAliases: Array<{ alias: string, to: string }> = [];

        /*
         * So, what names are resolveable on a network?
         *
         * On a default bridge network: hostnames are self-resolveable,
         * and that's it unless links are used. No aliases are defined by default.
         *
         * On a custom bridge network: hostnames are fully resolveable, as are container
         * ids, plus any custom aliases defined in network config. All defined in Aliases.
         *
         * On a host network: everything resolves as on the host (so we do nothing). Since
         * there's no actual network involved, we never get here anyway.
         *
         * On any network: linked containers can be referenced by their real name, their
         * their link alias name (if different), and their hostname.
         *
         * Overlay etc out of scope for now.
         */

        // Get each containers aliases, and the mapping for each containers custom-mapping
        // targets (links & ExtraHosts config)
        await Promise.all(networkContainers.map(async (container) => {
            const networkConfig: Docker.EndpointSettings | undefined =
                _.find(container.NetworkSettings.Networks, { NetworkID: networkId });

            // If this container somehow isn't connected, we don't care about it - drop it
            if (!networkConfig || !networkConfig.IPAddress) return;

            // Every container can be accessed by its IP address directly:
            networkPublicAliases.push(networkConfig.IPAddress);

            // Every container can be accessed (at least by itself) by its hostname:
            networkPublicAliases.push(container.Config.Hostname);
            if (isDefaultBridge && this.isInterceptedContainer(container)) {
                // On the default bridge, hostnames aren't routeable, but we need to make
                // intercepted containers hostnames accessible from the proxy:
                networkMappedAliases.push({
                    alias: container.Config.Hostname,
                    to: networkConfig.IPAddress
                });
            }

            // Every container can be accessed by any configured aliases on this network:
            (networkConfig.Aliases || []).forEach((alias) => {
                networkPublicAliases.push(alias);
            });

            if (this.isInterceptedContainer(container)) {
                // Containers may have hosts configured via --add-host=host:ip, which adds them to
                // /etc/hosts. Note that we ignore conflicts here, and just pick the first result,
                // which seems to match how resolution against /etc/hosts works in general.
                networkMappedAliases.push(
                    ..._(container.HostConfig.ExtraHosts ?? [])
                    .reverse() // We want first conflict to win, not last
                    .map((hostString) => {
                        const hostParts = hostString.split(':');
                        return { alias: hostParts[0], to: hostParts.slice(1).join(':') };
                    })
                    .uniqBy(hostMapping => hostMapping.alias)
                    // We don't need to track the host alias - that's built-in, and trying to remap
                    // it might cause problems later.
                    .filter(({ alias }) => alias !== DOCKER_HOST_HOSTNAME)
                    .valueOf()
                );

                // Containers also may have links configured (legacy, but still supported & used I think):
                const linkStrings: string[] = container.HostConfig.Links || [];
                const linkAliases = await Promise.all(linkStrings.map(async (link) => {
                    // Aliases are of the form:
                    // /compose_default-service-a_1_HTK8000:/compose_linked-service-b_1_HTK8000/a
                    // I.e. service-a is linked by service-b with alias 'a'.
                    const endOfContainerName = link.indexOf(':/');
                    const aliasIndex = link.lastIndexOf('/');

                    const linkedContainerName = link.slice(1, endOfContainerName);
                    const linkAlias = link.slice(aliasIndex + 1); // +1 to drop leading slash

                    const linkedContainer = networkContainers.find(c => c.Name === linkedContainerName)
                        // Container should always be in the same network AFAICT, but fallback to lookup just in case:
                        ?? await this.docker.getContainer(linkedContainerName).inspect();

                    const linkedContainerIp = linkedContainer.NetworkSettings.Networks[networkId]?.IPAddress ||
                        linkedContainer.NetworkSettings.IPAddress;

                    return [
                        { alias: linkAlias, to: linkedContainerIp },
                        { alias: linkedContainer.Name, to: linkedContainerIp },
                        { alias: linkedContainer.Config.Hostname, to: linkedContainerIp }
                    ];
                }));

                networkMappedAliases.push(..._.flatten(linkAliases));
            }
        }));

        return {
            publicTargets: networkPublicAliases,
            mappedTargets: networkMappedAliases
        };
    }
}