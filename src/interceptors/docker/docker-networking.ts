import * as _ from 'lodash';
import * as stream from 'stream';
import * as Docker from 'dockerode';
import * as EventStream from 'event-stream';

import { reportError } from '../../error-tracking';

import { getDnsServer } from '../../dns-server';
import { isInterceptedContainer } from './docker-commands';

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
 * and ensure the DNS server for this proxy port can resolve the relevant Docker container aliases.
 *
 * This has no effect (and no downside) if the monitor is already running, so it's expected
 * that this will be called whenever a user interacts with Docker in a way related to
 * HTTP Toolkit interception for this port. It's useful to call this often, because its
 * dependent on the events stream from Docker that may be fragile and need reseting, in a way
 * that other background services (like the proxy or DNS server) are not.
 *
 * Network monitors are cached and run in the background, staying alive until either the
 * the Docker event stream shuts down (i.e. Docker engine disappears or similar) or it's
 * explicitly shut down with stopMonitoringDockerNetworkAliases for this proxy port.
 */
export function monitorDockerNetworkAliases(proxyPort: number) {
    if (!dockerNetworkMonitors[proxyPort]) {
        const docker = new Docker();

        const dnsSourceId = `docker-${proxyPort}`;

        const stream = getDockerEventStream(docker);
        stream.on('error', (e) => {
            console.log(`Docker stream for port ${proxyPort} hit an error`);
            reportError(e);
        });

        const networkMonitor = new DockerNetworkMonitor(docker, proxyPort, stream, async (aliases) => {
            // Any time the network changes, update our DNS server to map all the
            // relevant aliases appropriately:
            const dnsServer = await getDnsServer(proxyPort);
            dnsServer.setSourceHosts(dnsSourceId, aliases);
        });

        dockerNetworkMonitors[proxyPort] = networkMonitor;

        // If the stream is dead, this network monitor is no longer working - drop it.
        stream.on('close', async () => {
            if (dockerNetworkMonitors[proxyPort] === networkMonitor) {
                // We remove the registration in this case. If somebody calls this method later,
                // become some intercepted Docker activity has happened, then this will
                // reactivate (any hopefully the Docker stream will be usable again then)
                delete dockerNetworkMonitors[proxyPort];

                // Remove all our entries from this proxy's DNS server
                const dnsServer = await getDnsServer(proxyPort);
                dnsServer.setSourceHosts(dnsSourceId, {});

                // Unsubscribe from all events
                networkMonitor.stop();
            }
        });
    }
}

export function stopMonitoringDockerNetworkAliases(proxyPort: number) {
    const monitor = dockerNetworkMonitors[proxyPort];
    if (!monitor) return;

    delete dockerNetworkMonitors[proxyPort];
    monitor.stop();
}

/**
 * Network monitors track the network aliases required to resolve requests from all
 * containers that a proxy is currently intercepting.
 */
class DockerNetworkMonitor {

    constructor(
        private docker: Docker,
        private proxyPort: number,
        private dockerEventStream: NodeJS.ReadableStream,
        private updateCallback: (aliases: { [hostname: string]: string[] }) => void
    ) {
        dockerEventStream.on('data', this.onEvent);

        this.refreshAllNetworks().then(() =>
            this.updateCallback(this.getAliasMapping())
        );
    }

    async stop() {
        this.dockerEventStream.removeListener('data', this.onEvent);
    }

    private aliasMappings: {
        [aliasSourceId: string]: { // Either network-${networkId} or container-${containerId}
            [hostname: string]: Set<string>
        }
    } = {};

    private setContainerMapping(containerId: string, mapping: { [hostname: string]: Set<string> }) {
        this.aliasMappings[`container-${containerId}`] = mapping;
    }

    private clearContainerMapping(containerId: string) {
        delete this.aliasMappings[`container-${containerId}`];
    }

    private setNetworkMapping(networkId: string, mapping: { [hostname: string]: Set<string> }) {
        this.aliasMappings[`network-${networkId}`] = mapping;
    }

    private clearNetworkMapping(networkId: string) {
        delete this.aliasMappings[`network-${networkId}`];
    }

    private getAliasMapping() {
        // Merge the sets for the same hostname in multiple networks together, to create
        // a single mapping from hostnames to all possible addresses. This isn't great,
        // but hopefully in practice there will be few or zero conflicts regardless.
        return _.assignWith<{ [hostname: string]: string [] }>({},
            ...Object.values(this.aliasMappings),
            (existingIps: string[] = [], nextIps: Set<string> = new Set()) => {
                return [...existingIps, ...nextIps.values()];
            }
        );
    }

    onEvent = async (event: DockerEvent) => {
        if (event.Type === 'network') {
            if (event.Action === 'destroy') {
                // If the network is deleted, we definitely don't need its aliases anymore.
                this.clearNetworkMapping(event.Actor.ID);
            } else {
                // If anything else happens to any network (connecting a container, disconnecting,
                // whatever) then it could change our aliases, so we refresh it.
                await this.refreshNetwork(event.Actor.ID);
            }
        }

        if (event.Type === 'container') {
            if (event.Action === 'create') {
                const container = await this.docker.getContainer(event.Actor.ID).inspect();
                if (this.isInterceptedContainer(container)) {
                    // When an intercepted container is started, we refresh everything, to ensure
                    // that all network data is available. Don't need to worry about other
                    // containers, since we get a network event for each connection change anyway.
                    await this.refreshAllNetworks();

                    // In addition to the container's network, we need to load its own locally-resolvable
                    // addresses - i.e. localhost name & Docker-added /etc/hosts values.
                    this.refreshContainerHosts(container);
                }
            }

            if (event.Action === 'destroy') {
                // Update all networks - this might enable us to remove aliases
                // for one of our networks entirely.
                await this.refreshAllNetworks();
                this.clearContainerMapping(event.Actor.ID);
            }
        }

        this.updateCallback(this.getAliasMapping());
    }

    private isInterceptedContainer(container: Docker.ContainerInspectInfo) {
        // Is this one of the containers we're supposed to be monitoring?
        return isInterceptedContainer(container, this.proxyPort);
    }

    private async refreshContainerHosts(container: Docker.ContainerInspectInfo) {
        this.setContainerMapping(container.Id, {
            // The container can send itself requests to its own hostname:
            [container.Config.Hostname]: new Set(container.NetworkSettings.IPAddress),
            // It can also have hosts configured via --add-host=host:ip, which adds them to
            // /etc/hosts. Note that we ignore conflicts here, and just pick the first result,
            // which seems to match how resolution against /etc/hosts works in general.
            ...(_(container.HostConfig.ExtraHosts ?? [])
                .reverse() // We want first conflict to win, not last
                .map((hostPair) => hostPair.split(':'))
                .keyBy((hostParts) => hostParts[0])
                .mapValues<string[], string>((hostParts) =>
                    hostParts.slice(1).join(':')
                )
                .mapValues((address) =>
                    address === 'host-gateway' // Special Docker name for the host IP
                        ? new Set(['127.0.0.1'])
                        : new Set([address])
                )
                .valueOf()
            )
        });
    }

    private async refreshAllNetworks() {
        const networks = await this.docker.listNetworks();
        return Promise.all(
            networks.map((network) => this.refreshNetwork(network.Id))
        );
    }

    private async refreshNetwork(networkId: string) {
        this.setNetworkMapping(networkId, await this.getNetworkAliases(networkId));
    }

    private async getNetworkAliases(networkId: string) {
        const networkDetails: Docker.NetworkInspectInfo = await this.docker.getNetwork(networkId).inspect();
        const networkContainers = await Promise.all(
            Object.values(networkDetails.Containers ?? {}).map((networkContainer) =>
                this.docker.getContainer(networkContainer.Name).inspect()
            )
        );

        if (!networkContainers.find((container) => this.isInterceptedContainer(container))) {
            // If we're not tracking any containers in this network, we don't need its aliases.
            return {};
        }

        // Build a map of each container's aliases to its IP on this network
        return networkContainers.reduce((aliasMap, container) => {
            const networkConfig: Docker.EndpointSettings | undefined =
                _.find(container.NetworkSettings.Networks, { NetworkID: networkId });

            if (!networkConfig || !networkConfig.IPAddress) return aliasMap;

            /*
             * What names are resolveable on a network?
             *
             * On a default bridge network: hostnames are self-resolveable (handled by
             * refreshContainerHosts), and that's it unless links are used. No aliases are defined.
             *
             * On a custom bridge network: hostnames are fully resolveable, as are container
             * ids, plus any custom aliases defined in network config. All defined in Aliases.
             *
             * On a host network: everything resolves as on the host (so we do nothing). Since
             * there's no actual network involved, we never get here anyway.
             *
             * Overlay etc out of scope for now.
             */

            const aliases = networkConfig.Aliases ?? [];

            aliases.forEach((alias) => {
                if (!aliasMap[alias]) aliasMap[alias] = new Set();
                aliasMap[alias].add(networkConfig.IPAddress!);
            });
            return aliasMap;
        }, {} as { [alias: string]: Set<string> });
    }
}