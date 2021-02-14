import * as _ from 'lodash';
import * as Docker from 'dockerode';
import * as path from 'path';
import * as tarFs from 'tar-fs';

import { Interceptor } from "..";
import { getTerminalEnvVars, OVERRIDES_DIR } from '../terminal/terminal-env-overrides';
import { HtkConfig } from '../../config';

const HTTP_TOOLKIT_INJECTED_PATH = '/http-toolkit-injections';

const envArrayToObject = (envArray: string[]) =>
    _.fromPairs(envArray.map((e) => {
        const equalsIndex = e.indexOf('=');
        if (equalsIndex === -1) throw new Error('Env var without =');

        return [e.slice(0, equalsIndex), e.slice(equalsIndex + 1)];
    }));

const envObjectToArray = (envObject: { [key: string]: string }): string[] =>
    Object.keys(envObject).map(k => `${k}=${envObject[k]}`);

export class DockerInterceptor implements Interceptor {

    id: string = "docker-all";
    version: string = "1.0.0";

    constructor(
        private config: HtkConfig
    ) {}

    async activate(proxyPort: number, options?: any): Promise<void | {}> {
        console.log("activate docker");

        const docker = new Docker();

        const currentContainers = await docker.listContainers()
            .then((containers) =>
                Promise.all(
                    containers.map((c) =>
                        docker.getContainer(c.Id)
                    )
                )
            );

        // Restart each container, plus our own config, one by one. If we do this
        // in parallel, when all containers are stopped any running docker-compose
        // will stop too. Could improve by detecting compose and handling that.

        // Could add files to hit PATH and restart process, but can't change env vars
        // or entrypoint (legally... doable with manual edits...) and restarting a proc
        // might be unexpected/unsafe, whilst fresh container should be the 'normal' route.


        for (let container of currentContainers) {
            const details = await container.inspect();

            await container.stop({ t: 1 });
            await container.remove().catch((e) => {
                if (e.statusCode === 409 || e.statusCode === 404) {
                    // Generally this means the container was running with --rm, so
                    // it's been/being removed automatically already - that's fine!
                    return;
                } else {
                    throw e;
                }
            });

            const networkDetails = details.NetworkSettings.Networks;
            const networkNames = Object.keys(networkDetails);

            const newContainer = await docker.createContainer({
                ...details.Config,
                name: details.Name,
                NetworkingConfig: {
                    EndpointsConfig: networkNames.length > 1
                        ? { [networkNames[0]]: networkDetails[networkNames[0]] }
                        : networkDetails
                },
                Env: [
                    ...details.Config.Env,
                    ...envObjectToArray(
                        getTerminalEnvVars(
                            proxyPort,
                            { certPath: path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem') },
                            envArrayToObject(details.Config.Env),
                            {
                                httpToolkitIp: '172.17.0.1',
                                overridePath: HTTP_TOOLKIT_INJECTED_PATH,
                                targetPlatform: 'linux'
                            }
                        )
                    )
                ]
            });

            // Reconnect all networks (we can't do this during create() for >1 network)
            if (networkNames.length > 1) {
                await Promise.all(
                    Object.keys(networkNames.slice(1)).map(networkName =>
                        docker.getNetwork(networkName).connect({
                            Container: newContainer.id,
                            EndpointConfig: networkDetails[networkName]
                        })
                    )
                );
            }

            // Bundle up all our overrides
            const injectionTarball = tarFs.pack(OVERRIDES_DIR, {
                map: (fileHeader) => {
                    fileHeader.name = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, fileHeader.name);

                    // Owned by root by default
                    fileHeader.uid = 0;
                    fileHeader.gid = 0;

                    // But ensure everything is globally readable & runnable
                    fileHeader.mode = parseInt('555', 8);

                    return fileHeader;
                },
                finalize: false,
                finish: (pack) => {
                    pack.entry({
                        name: path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem')
                    }, this.config.https.certContent);
                    pack.finalize();
                }
            })

            await newContainer.putArchive(injectionTarball, { path: '/' });
            await newContainer.putArchive(
                tarFs.pack(path.join(__dirname, '..', '..', '..', 'node_modules'), {
                    map: (fileHeader) => {
                        fileHeader.name = path.posix.join('node_modules', fileHeader.name);

                        // Owned by root by default
                        fileHeader.uid = 0;
                        fileHeader.gid = 0;

                        // But ensure everything is globally readable by everybody
                        if (fileHeader.type === "directory") {
                            fileHeader.mode = parseInt('555', 8);
                        } else {
                            fileHeader.mode = parseInt('444', 8);
                        }

                        return fileHeader;
                    }
                }),
                { path: HTTP_TOOLKIT_INJECTED_PATH }
            );

            // Start everything up!
            await newContainer.start();
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