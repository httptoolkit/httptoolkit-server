import * as _ from 'lodash';
import * as Docker from 'dockerode';
import * as path from 'path';
import * as tarFs from 'tar-fs';
import * as semver from 'semver';

import {
    getTerminalEnvVars,
    OVERRIDES_DIR
} from '../terminal/terminal-env-overrides';

// Used to label intercepted docker containers with the port of the proxy
// that's currently intercepting them.
export const DOCKER_CONTAINER_LABEL = "tech.httptoolkit.docker.proxy";

/**
 * The path inside the container where injected files will be stored, and so the paths that
 * env vars injected into the container need to reference.
 */
const HTTP_TOOLKIT_INJECTED_PATH = '/http-toolkit-injections';
const HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'overrides');
const HTTP_TOOLKIT_INJECTED_CA_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem');

/**
 * The hostname that resolves to the host OS (i.e. generally: where HTTP Toolkit is running)
 * from inside containers.
 *
 * In Docker for Windows & Mac, host.docker.internal is supported automatically:
 * https://docs.docker.com/docker-for-windows/networking/#use-cases-and-workarounds
 * https://docs.docker.com/docker-for-mac/networking/#use-cases-and-workarounds
 *
 * On Linux this is _not_ supported, so we add it ourselves with (--add-host).
 */
export const DOCKER_HOST_HOSTNAME = "host.docker.internal";

/**
 * To make the above hostname work on Linux, where it's not supported by default, we need to map it to the
 * host ip. This method works out the host IP to use to do so.
 */
export const getDockerHostIp = (
    platform: typeof process.platform,
    dockerVersion: { apiVersion: string } | { engineVersion: string },
    containerMetadata?: Docker.ContainerInspectInfo
) => {
    const semverVersion = semver.coerce(
        'apiVersion' in dockerVersion
        ? dockerVersion.apiVersion
        : dockerVersion.engineVersion
    );

    if (platform !== 'linux') {
        // On non-linux platforms this method isn't necessary - host.docker.internal is always supported
        // so we can just use that.
        return DOCKER_HOST_HOSTNAME;
    } else if (
        semver.satisfies(
            semverVersion ?? '0.0.0',
            'apiVersion' in dockerVersion ? '>=1.41' : '>=20.10'
        )
    ) {
        // This is supported in Docker Engine 20.10, so always supported at least in API 1.41+
        // Special name defined in new Docker versions, that refers to the host gateway
        return 'host-gateway';
    } else if (containerMetadata) {
        // Old/Unknown Linux with known container: query the metadata, and if _that_ fails, use the default gateway IP.
        return containerMetadata.NetworkSettings.Gateway || "172.17.0.1";
    } else {
        // Old/Unknown Linux without a container (e.g. during a build). Always use the default gateway IP:
        return "172.17.0.1";
    }
}

export function isImageAvailable(docker: Docker, name: string) {
    return docker.getImage(name).inspect()
        .then(() => true)
        .catch(() => false);
}

export function isInterceptedContainer(container: Docker.ContainerInspectInfo, port: string | number) {
    return container.Config.Labels[DOCKER_CONTAINER_LABEL] === port.toString();
}

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
    { interceptionType, proxyPort, proxyHost, certPath }: {
        interceptionType: DOCKER_INTERCEPTION_TYPE
        proxyPort: number,
        proxyHost: string,
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
    const currentConfig: Docker.ContainerCreateOptions = {
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

    const hostConfig: Docker.HostConfig = {
        ...currentConfig.HostConfig,
        // To intercept without modifying the container, we bind mount our overrides and certificate
        // files into place:
        ...(interceptionType === 'mount'
            ? {
                Binds: [
                    ...(currentConfig.HostConfig?.Binds ?? []).filter((existingMount) =>
                        // Drop any existing mounts for these folders - this allows re-intercepting containers, e.g.
                        // to switch from one proxy port to another.
                        !existingMount.startsWith(`${certPath}:`) &&
                        !existingMount.startsWith(`${OVERRIDES_DIR}:`)
                    ),
                    // Bind-mount the CA certificate file individually too:
                    `${certPath}:${HTTP_TOOLKIT_INJECTED_CA_PATH}:ro`,
                    // Bind-mount the overrides directory into the container:
                    `${OVERRIDES_DIR}:${HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH}:ro`
                    // ^ Both 'ro' - untrusted containers must not be able to mess with these!
                ]
            }
            : {}
        ),
        ...(process.platform === 'linux'
            // On Linux only, we need to add an explicit host to make host.docker.internal work:
            ? {
                ExtraHosts: [
                    `${DOCKER_HOST_HOSTNAME}:${proxyHost}`,
                    // Seems that first host wins conflicts, so we go before existing values
                    ...(currentConfig.HostConfig?.ExtraHosts ?? [])
                ]
            }
            : {}
        )
    };

    // Extend that config, injecting our custom overrides:
    return {
        ...currentConfig,
        HostConfig: hostConfig,
        Env: [
            ...(currentConfig.Env ?? []),
            ...envObjectToArray(
                getTerminalEnvVars(
                    proxyPort,
                    { certPath: HTTP_TOOLKIT_INJECTED_CA_PATH },
                    envArrayToObject(currentConfig.Env),
                    {
                        httpToolkitIp: DOCKER_HOST_HOSTNAME,
                        overridePath: HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH,
                        targetPlatform: 'linux'
                    }
                )
            )
        ],
        Labels: {
            ...currentConfig.Labels,
            // If there's a docker-compose project label, append our suffix. This ensures that normal
            // DC commands don't use intercepted containers, and vice versa.
            ...(currentConfig.Labels?.['com.docker.compose.project']
                ? { 'com.docker.compose.project':
                    `${currentConfig.Labels['com.docker.compose.project']}_HTK:${proxyPort}`
                }
                : {}
            ),
            // Label the resulting container as intercepted by this specific proxy:
            [DOCKER_CONTAINER_LABEL]: String(proxyPort)
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

    const proxyHost = getDockerHostIp(
        process.platform,
        { engineVersion: (await docker.version()).Version },
        containerDetails
    );

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
                proxyPort,
                proxyHost
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