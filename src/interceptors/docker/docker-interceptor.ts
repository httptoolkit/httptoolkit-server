import * as _ from 'lodash';
import * as Docker from 'dockerode';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { restartAndInjectContainer } from './docker-commands';
import { monitorDockerNetworkAliases } from './docker-networking';

export class DockerContainerInterceptor implements Interceptor {

    id: string = "docker-attach";
    version: string = "1.0.0";

    constructor(
        private config: HtkConfig
    ) {}

    private docker = new Docker();

    async getMetadata() {
        if (await this.isActivable()) {
            return {
                targets: _(await this.docker.listContainers())
                    .map((containerData) => ({
                        // Keep the docker data structure, but normalize the key names and filter
                        // to just the relevant data, just to make sure we don't unnecessarily
                        // expose secrets or similar.
                        id: containerData.Id,
                        names: containerData.Names,
                        command: containerData.Command,
                        labels: containerData.Labels,
                        state: containerData.State,
                        status: containerData.Status,
                        image: containerData.Image,
                        ips: Object.values(containerData.NetworkSettings.Networks)
                            .map(network => network.IPAddress)
                    }))
                    .keyBy('id')
                    .valueOf()
            };
        }
    }

    async activate(proxyPort: number, options: { containerId: string }): Promise<void | {}> {
        const interceptionSettings = {
            interceptionType: 'mount',
            proxyPort,
            certContent: this.config.https.certContent,
            certPath: this.config.https.certPath,
        } as const;

        monitorDockerNetworkAliases(proxyPort);
        await restartAndInjectContainer(this.docker, options.containerId, interceptionSettings);
    }

    async isActivable(): Promise<boolean> {
        return this.docker.ping().then(() => true).catch(() => false);
    }

    isActive(proxyPort: number): boolean {
        return false;
    }

    async deactivate(proxyPort: number, options?: any): Promise<void | {}> {}

    async deactivateAll(): Promise<void | {}> {}

}