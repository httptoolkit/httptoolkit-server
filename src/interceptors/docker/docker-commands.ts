import _ from 'lodash';
import Docker from 'dockerode';
import * as path from 'path';

import { delay } from '@httptoolkit/util';

import { getTerminalEnvVars } from '../terminal/terminal-env-overrides';
import { transformComposeCreationLabels } from './docker-compose';
import { getDockerDataVolumeName } from './docker-data-injection';

// Used to label intercepted docker containers with the port of the proxy
// that's currently intercepting them.
export const DOCKER_CONTAINER_LABEL = "tech.httptoolkit.docker.proxy";

/**
 * The path inside the container where injected files will be stored, and so the paths that
 * env vars injected into the container need to reference.
 */
const HTTP_TOOLKIT_INJECTED_PATH = '/.http-toolkit-injections';
const HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'overrides');
const HTTP_TOOLKIT_INJECTED_CA_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem');

/**
 * Get the hostname that resolves to the host OS (i.e. generally: where HTTP Toolkit is running)
 * from inside containers.
 *
 * In Docker for Windows & Mac, host.docker.internal is supported automatically:
 * https://docs.docker.com/docker-for-windows/networking/#use-cases-and-workarounds
 * https://docs.docker.com/docker-for-mac/networking/#use-cases-and-workarounds
 *
 * On Linux this is _not_ supported, and we need to be more clever.
 */
export function getDockerHostAddress(
    platform: typeof process.platform,
    containerMetadata?: Docker.ContainerInspectInfo
) {
    if (platform === 'win32' || platform === 'darwin') {
        // On Docker Desktop, this alias always points to the host (outside the VM) IP:
        return 'host.docker.internal';
    } else {
        // Elsewhere (Linux) we should be able to always use the gateway address. We avoid
        // using ExtraHosts with host-gateway, because that uses /etc/hosts, and not all
        // clients use that for resolution (some use _only_ DNS lookups). IPs avoid this.
        return containerMetadata?.NetworkSettings.Gateway
            || "172.17.0.1";
    }
}

export function isImageAvailable(docker: Docker, name: string) {
    return docker.getImage(name).inspect()
        .then(() => true)
        .catch(() => false);
}

export function isInterceptedContainer(container: Docker.ContainerInspectInfo, port: string | number) {
    return container.Config.Labels?.[DOCKER_CONTAINER_LABEL] === port.toString();
}

const envArrayToObject = (envArray: string[] | null | undefined) =>
    _.fromPairs((envArray ?? []).map((e) => {
        const equalsIndex = e.indexOf('=');
        if (equalsIndex === -1) throw new Error('Env var without =');

        return [e.slice(0, equalsIndex), e.slice(equalsIndex + 1)];
    }));

const envObjectToArray = (envObject: { [key: string]: string }): string[] =>
    Object.keys(envObject).map(k => `${k}=${envObject[k]}`);

/**
 * Takes the config for a container, and returns the config to create the
 * same container, but fully intercepted.
 *
 * To hook the creation of any container, we need to get the full config of
 * the container (to make sure we get *all* env vars, for example) and then
 * combine that with the inter
 */
export async function transformContainerCreationConfig(
    containerConfig: Docker.ContainerCreateOptions,
    baseImageConfig: Docker.ImageInspectInfo | undefined,
    { proxyPort, certContent }: {
        proxyPort: number,
        certContent: string
    }
): Promise<Docker.ContainerCreateOptions> {
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

    const envVarsToInject = getTerminalEnvVars(
        proxyPort,
        { certPath: HTTP_TOOLKIT_INJECTED_CA_PATH },
        envArrayToObject(currentConfig.Env),
        {
            httpToolkitHost: getDockerHostAddress(process.platform),
            overridePath: HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH,
            targetPlatform: 'linux'
        }
    );

    // For now, we don't inject DOCKER_HOST into the container, so we don't try to intercept DinD. It
    // should be doable in theory, but it seems complicated and of limited value.
    delete envVarsToInject['DOCKER_HOST'];

    const hostConfig: Docker.HostConfig = {
        ...currentConfig.HostConfig,
        // To intercept without modifying the container, we bind mount our overrides and certificate
        // files into place on top of the existing content:
        Binds: [
            ...(currentConfig.HostConfig?.Binds ?? []).filter((existingMount) =>
                // Drop any existing mounts for these folders - this allows re-intercepting containers,
                // e.g. to switch from one proxy port to another.
                !existingMount.endsWith(`:${HTTP_TOOLKIT_INJECTED_PATH}:ro`)
            ),
            // Bind-mount the injected data volume:
            `${await getDockerDataVolumeName(certContent)}:${HTTP_TOOLKIT_INJECTED_PATH}:ro`,
            // ^ Note the 'ro' - untrusted containers must not be able to mess with this!
        ]
    };

    // Extend that config, injecting our custom overrides:
    return {
        ...currentConfig,
        HostConfig: hostConfig,
        Env: [
            ...(currentConfig.Env ?? []),
            ...envObjectToArray(envVarsToInject)
        ],
        Labels: {
            ...transformComposeCreationLabels(proxyPort, currentConfig.Labels),
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
        name: containerDetails.Name,
        // You can't reconnect all networks at creation for >1 network.
        // To avoid issues, we just reconnect all networks after creation.
        HostConfig: {
            ...containerDetails.HostConfig,
            NetworkMode: 'none'
        },
        NetworkingConfig: {}
    };
}

async function connectNetworks(
    docker: Docker,
    containerId: string,
    networks: Docker.EndpointsConfig
) {
    // At creation, we initially connect containers to 'none', and we have to
    // undo that before we can connect to anything else. Note that this all
    // happens before container startup, so this is invisible.
    await docker.getNetwork('none').disconnect({ Container: containerId });

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
    { proxyPort, certContent }: {
        proxyPort: number,
        certContent: string
    }
) {
    // We intercept containers by stopping them, cloning them, injecting our settings,
    // and then starting up the clone.

    // We could add files to hit PATH and just restart the process, but we can't change
    // env vars or entrypoints (legally... doable with manual edits...) and restarting a
    // proc might be unexpected/unsafe, whilst fresh container should be the 'normal' route.

    const container = docker.getContainer(containerId);
    const containerDetails = await container.inspect();

    await container.stop({ t: 1 }).catch((e) => {
        // Ignore already-stopped errors:
        if (e.message?.includes('container already stopped')) return;
        else throw e;
    });
    await container.remove().catch((e) => {
        if ([409, 404, 304].includes(e.statusCode)) {
            // Generally this means the container was running with --rm, so
            // it's been/being removed automatically already - that's fine!
            return;
        } else {
            throw e;
        }
    });

    // There can be a delay here - wait until the container disappears
    while (await container.inspect().catch(() => false)) {
        await delay(100);
    }

    // First we clone the continer, injecting our custom settings:
    const newContainer = await docker.createContainer(
        await transformContainerCreationConfig(
            // Get options required to directly recreate this container
            deriveContainerCreationConfigFromInspection(
                containerDetails
            ),
            // We don't need image config - inspect result has *everything*
            undefined,
            { proxyPort, certContent }
        )
    );

    // Reconnect to all the previous container's networks:
    await connectNetworks(
        docker,
        newContainer.id,
        containerDetails.NetworkSettings.Networks
    );

    // Start everything up!
    await newContainer.start();
}