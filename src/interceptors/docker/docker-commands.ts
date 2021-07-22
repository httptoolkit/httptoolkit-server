import * as _ from 'lodash';
import * as Docker from 'dockerode';
import * as path from 'path';
import * as tarFs from 'tar-fs';

import {
    getTerminalEnvVars,
    OVERRIDES_DIR
} from '../terminal/terminal-env-overrides';

const HTTP_TOOLKIT_INJECTED_PATH = '/http-toolkit-injections';
const HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'overrides');
const HTTP_TOOLKIT_INJECTED_CA_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem');

const envArrayToObject = (envArray: string[] | null | undefined) =>
    _.fromPairs((envArray ?? []).map((e) => {
        const equalsIndex = e.indexOf('=');
        if (equalsIndex === -1) throw new Error('Env var without =');

        return [e.slice(0, equalsIndex), e.slice(equalsIndex + 1)];
    }));

const envObjectToArray = (envObject: { [key: string]: string }): string[] =>
    Object.keys(envObject).map(k => `${k}=${envObject[k]}`);

function packInterceptionFiles(certContent: string) {
    return tarFs.pack(OVERRIDES_DIR, {
        map: (fileHeader) => {
            fileHeader.name = path.posix.join(HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH, fileHeader.name);

            // Owned by root by default
            fileHeader.uid = 0;
            fileHeader.gid = 0;

            // But ensure everything is globally readable & runnable
            fileHeader.mode = parseInt('555', 8);

            return fileHeader;
        },
        finalize: false,
        finish: (pack) => {
            pack.entry({ name: HTTP_TOOLKIT_INJECTED_CA_PATH }, certContent);
            pack.finalize();
        }
    });
}

// The two ways to inject the files required for interception into the image.
// If 'mount', the override files should be bind-mounted directly into the image. If
// 'inject', the override files should be copied into the image. 'Mount' is generally
// better & faster, but not possible for builds or injection into remote hosts.
export type DOCKER_INTERCEPTION_TYPE =
    | 'mount'
    | 'inject';

/**
 * Takes the config for a container, and returns the config to create the
 * same container, but fully intercepted.
 *
 * To hook the creation of any container, we need to get the full config of
 * the container (to make sure we get *all* env vars, for example) and then
 * combine that with the inter
 */
export function transformContainerCreationConfig(
    containerConfig: Docker.ContainerCreateOptions,
    baseImageConfig: Docker.ImageInspectInfo | undefined,
    { interceptionType, proxyPort, certPath }: {
        interceptionType: DOCKER_INTERCEPTION_TYPE
        proxyPort: number,
        certPath: string
    }
): Docker.ContainerCreateOptions {
    // Get the container-relevant config from the image config first.
    // The image has both .Config and .ContainerConfig. The former
    // is preferred, seems that .ContainerConfig is backward compat.
    const imageContainerConfig = baseImageConfig?.Config ??
        baseImageConfig?.ContainerConfig;

    // Combine the image config with the container creation options. Most
    // fields are overriden by container config, a couple are merged:
    const effectiveConfig: Docker.ContainerCreateOptions = {
        ...imageContainerConfig,
        ...containerConfig,
        Env: [
            ...(imageContainerConfig?.Env ?? []),
            ...(containerConfig.Env ?? [])
        ],
        Labels: {
            ...(imageContainerConfig?.Labels ?? {}),
            ...(containerConfig.Labels ?? {})
        }
    };

    // Extend that config, injecting our custom overrides:
    return {
        ...effectiveConfig,
        HostConfig: interceptionType === 'mount' && effectiveConfig.HostConfig
            ? {
                ...effectiveConfig.HostConfig,
                Binds: [
                    ...(effectiveConfig.HostConfig?.Binds || []),
                    // Bind-mount the CA certificate file individually too:
                    `${certPath}:${HTTP_TOOLKIT_INJECTED_CA_PATH}:ro`,
                    // Bind-mount the overrides directory into the container:
                    `${OVERRIDES_DIR}:${HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH}:ro`
                    // ^ Both 'ro' - untrusted containers must not be able to mess with these!
                ]
            }
            : effectiveConfig.HostConfig,
        Env: [
            ...(effectiveConfig.Env ?? []),
            ...envObjectToArray(
                getTerminalEnvVars(
                    proxyPort,
                    { certPath: HTTP_TOOLKIT_INJECTED_CA_PATH },
                    envArrayToObject(effectiveConfig.Env),
                    {
                        httpToolkitIp: '172.17.0.1',
                        overridePath: HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH,
                        targetPlatform: 'linux'
                    }
                )
            )
        ],
        Labels: {
            ...effectiveConfig.Labels,
            'tech.httptoolkit.docker.proxy': String(proxyPort)
        }
    };
}

function deriveContainerCreationConfigFromInspection(
    containerDetails: Docker.ContainerInspectInfo
): Docker.ContainerCreateOptions {
    return {
        ...containerDetails.Config,
        HostConfig: containerDetails.HostConfig,
        name: containerDetails.Name,
        // You can't reconnect all networks at creation for >1 network.
        // To simplify things, we just connect all networks after creation.
        NetworkingConfig: {}
    };
}

async function connectNetworks(
    docker: Docker,
    containerId: string,
    networks: Docker.EndpointsConfig
) {
    await Promise.all(
        Object.keys(networks).map(networkName =>
            docker.getNetwork(networkName).connect({
                Container: containerId,
                EndpointConfig: networks[networkName]
            })
        )
    );
}

export async function restartAndInjectContainer(
    docker: Docker,
    containerId: string,
    { interceptionType, proxyPort, certContent, certPath }: {
        interceptionType: DOCKER_INTERCEPTION_TYPE
        proxyPort: number,
        certContent: string
        certPath: string
    }
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

    // First we clone the continer, injecting our custom settings:
    const newContainer = await docker.createContainer(
        transformContainerCreationConfig(
            // Get options required to directly recreate this container
            deriveContainerCreationConfigFromInspection(
                containerDetails
            ),
            // We don't need image config - inspect result has *everything*
            undefined,
            { // The settings to inject:
                interceptionType,
                certPath,
                proxyPort
            }
        )
    );

    // Reconnect to all the previous container's networks:
    connectNetworks(
        docker,
        newContainer.id,
        containerDetails.NetworkSettings.Networks
    );

    if (interceptionType === 'inject') {
        // Inject the overide files & MITM cert into the image directly:
        await newContainer.putArchive(packInterceptionFiles(certContent), { path: '/' });
    }

    // Start everything up!
    await newContainer.start();
}