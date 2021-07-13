import * as _ from 'lodash';
import * as Docker from 'dockerode';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { restartAndInjectContainer } from './docker-commands';

export class DockerAllInterceptor implements Interceptor {

    id: string = "docker-all";
    version: string = "1.0.0";

    constructor(
        private config: HtkConfig
    ) {}

    private docker = new Docker();

    async activate(proxyPort: number, options?: any): Promise<void | {}> {
        const currentContainers = await this.docker.listContainers();

        // Restart each container, plus our own config, one by one. If we do this
        // in parallel, when all containers are stopped any running docker-compose
        // will stop too. Could improve by detecting compose and handling that.

        const interceptionSettings = {
            interceptionType: 'mount',
            proxyPort,
            certContent: this.config.https.certContent,
            certPath: this.config.https.certPath,
        } as const;

        for (let container of currentContainers) {
            await restartAndInjectContainer(this.docker, container.Id, interceptionSettings);
        }
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

export class DockerContainerInterceptor implements Interceptor {

    id: string = "docker-container";
    version: string = "1.0.0";

    constructor(
        private config: HtkConfig
    ) {}

    private docker = new Docker();

    async getMetadata() {
        if (await this.isActivable()) {
            return (await this.docker.listContainers()).map((containerData) => ({
                // Keep the docker data structure, but normalize the key names and filter
                // to just the relevant data, just to make sure we don't unnecessarily
                // expose secrets or similar.
                id: containerData.Id,
                names: containerData.Names,
                command: containerData.Command,
                labels: containerData.Labels,
                state: containerData.State,
                status: containerData.Status
            }));
        }
    }

    async activate(proxyPort: number, options: { containerId: string }): Promise<void | {}> {
        const interceptionSettings = {
            interceptionType: 'mount',
            proxyPort,
            certContent: this.config.https.certContent,
            certPath: this.config.https.certPath,
        } as const;

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