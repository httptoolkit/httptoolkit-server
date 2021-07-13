import * as _ from 'lodash';
import * as Docker from 'dockerode';
import * as path from 'path';
import * as tarFs from 'tar-fs';

import {
    getTerminalEnvVars,
    OVERRIDES_DIR
} from '../terminal/terminal-env-overrides';

const HTTP_TOOLKIT_INJECTED_PATH = '/http-toolkit-injections';

const envArrayToObject = (envArray: string[]) =>
    _.fromPairs(envArray.map((e) => {
        const equalsIndex = e.indexOf('=');
        if (equalsIndex === -1) throw new Error('Env var without =');

        return [e.slice(0, equalsIndex), e.slice(equalsIndex + 1)];
    }));

const envObjectToArray = (envObject: { [key: string]: string }): string[] =>
    Object.keys(envObject).map(k => `${k}=${envObject[k]}`);

function packInterceptionFiles(certContent: string) {
    return tarFs.pack(OVERRIDES_DIR, {
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
            }, certContent);
            pack.finalize();
        }
    });
}

export async function restartAndInjectContainer(
    docker: Docker,
    containerId: string,
    { proxyPort, certContent }: { proxyPort: number, certContent: string }
) {
    // We intercept containers by stopping them, cloning them, injecting our settings,
    // and then starting up the clone.

    // We could add files to hit PATH and just restart the process, but we can't change
    // env vars or entrypoints (legally... doable with manual edits...) and restarting a
    // proc might be unexpected/unsafe, whilst fresh container should be the 'normal' route.

    const container = docker.getContainer(containerId);
    const containerDetails = await container.inspect();

    await container.stop({ t: 1 });
    await container.remove().catch((e) => {
        if ([409, 404, 304].includes(e.statusCode)) {
            // Generally this means the container was running with --rm, so
            // it's been/being removed automatically already - that's fine!
            return;
        } else {
            throw e;
        }
    });

    const networkDetails = containerDetails.NetworkSettings.Networks;
    const networkNames = Object.keys(networkDetails);

    // First we clone the continer, with our custom env vars:
    const newContainer = await docker.createContainer({
        ...containerDetails.Config,
        HostConfig: containerDetails.HostConfig,
        name: containerDetails.Name,
        NetworkingConfig: {
            EndpointsConfig: networkNames.length > 1
                ? { [networkNames[0]]: networkDetails[networkNames[0]] }
                : networkDetails
        },
        Env: [
            ...containerDetails.Config.Env,
            ...envObjectToArray(
                getTerminalEnvVars(
                    proxyPort,
                    { certPath: path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem') },
                    envArrayToObject(containerDetails.Config.Env),
                    {
                        httpToolkitIp: '172.17.0.1',
                        overridePath: HTTP_TOOLKIT_INJECTED_PATH,
                        targetPlatform: 'linux'
                    }
                )
            )
        ]
    });

    // We reconnect all networks (we can't do this during create() for >1 network)
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

    // Then we actually inject the overide files & MITM cert:
    await newContainer.putArchive(packInterceptionFiles(certContent), { path: '/' });

    // Start everything up!
    await newContainer.start();
}