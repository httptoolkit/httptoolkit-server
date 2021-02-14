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

    async activate(proxyPort: number, options?: any): Promise<void | {}> {
        console.log("activate docker");

        const docker = new Docker();

        const currentContainers = await docker.listContainers();

        // Restart each container, plus our own config, one by one. If we do this
        // in parallel, when all containers are stopped any running docker-compose
        // will stop too. Could improve by detecting compose and handling that.

        const interceptionSettings = {
            proxyPort,
            certContent: this.config.https.certContent
        };

        for (let container of currentContainers) {
            await restartAndInjectContainer(docker, container.Id, interceptionSettings);
        }
    }

    async isActivable(): Promise<boolean> {
        return true;
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

    async activate(proxyPort: number, options: { containerId: string }): Promise<void | {}> {
        const docker = new Docker();

        const interceptionSettings = {
            proxyPort,
            certContent: this.config.https.certContent
        };

        await restartAndInjectContainer(docker, options.containerId, interceptionSettings);
    }

    async isActivable(): Promise<boolean> {
        return true;
    }

    isActive(proxyPort: number): boolean {
        return false;
    }

    async deactivate(proxyPort: number, options?: any): Promise<void | {}> {}

    async deactivateAll(): Promise<void | {}> {}

}