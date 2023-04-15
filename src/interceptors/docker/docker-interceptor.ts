import _ from 'lodash';
import Docker from 'dockerode';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { DOCKER_CONTAINER_LABEL, restartAndInjectContainer } from './docker-commands';
import {
    isDockerAvailable,
    ensureDockerServicesRunning,
    deleteAllInterceptedDockerData
} from './docker-interception-services';

export class DockerContainerInterceptor implements Interceptor {

    id: string = "docker-attach";
    version: string = "1.0.0";

    constructor(
        private config: HtkConfig
    ) {}

    private _docker: Docker | undefined;
    private getDocker() {
        if (!this._docker) {
            this._docker = new Docker();
        }
        return this._docker;
    }

    async isActivable(): Promise<boolean> {
        return isDockerAvailable();
    }

    private _containersPromise: Promise<Docker.ContainerInfo[]> | undefined;
    async getContainers() {
        if (!this._containersPromise) {
            // We cache the containers query whilst it's active, because this gets hit a lot,
            // usually directly in parallel by getMetadata and isActive, and this ensures
            // that concurrent calls all just run one lookup and use the same result.
            this._containersPromise = this.getDocker().listContainers({
                all: true
            }).finally(() => { this._containersPromise = undefined; });
        }
        return this._containersPromise;
    }

    async getMetadata() {
        if (!await this.isActivable()) return;

        return {
            targets: _(await this.getContainers()).map((containerData) => ({
                // Keep the docker data structure, but normalize the key names and filter
                // to just the relevant data, just to make sure we don't unnecessarily
                // expose secrets or similar.
                id: containerData.Id,
                names: containerData.Names,
                command: containerData.Command,
                labels: containerData.Labels ?? {},
                state: containerData.State,
                status: containerData.Status,
                image: containerData.Image,
                ips: Object.values(containerData.NetworkSettings?.Networks ?? {})
                    .map(network => network.IPAddress)
            }))
            .keyBy('id')
            .valueOf()
        };
    }

    async activate(proxyPort: number, options: { containerId: string }): Promise<void | {}> {
        const interceptionSettings = {
            interceptionType: 'mount',
            proxyPort,
            certContent: this.config.https.certContent,
            certPath: this.config.https.certPath,
        } as const;

        ensureDockerServicesRunning(proxyPort);
        await restartAndInjectContainer(this.getDocker(), options.containerId, interceptionSettings);
    }

    async isActive(proxyPort: number): Promise<boolean> {
        if (!await this.isActivable()) return false;

        return Object.values((await this.getContainers())).some((target) => {
            target.Labels?.[DOCKER_CONTAINER_LABEL] === proxyPort.toString()
        });
    }

    async deactivate(proxyPort: number): Promise<void | {}> {
        if (!await isDockerAvailable()) return;
        await deleteAllInterceptedDockerData(proxyPort);
    }

    async deactivateAll(): Promise<void | {}> {
        if (!await isDockerAvailable()) return;
        await deleteAllInterceptedDockerData('all');
    }

}