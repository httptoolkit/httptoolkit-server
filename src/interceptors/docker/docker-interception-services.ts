import * as Docker from 'dockerode';

import { addShutdownHandler } from '../../shutdown';

import { DOCKER_BUILD_LABEL } from './docker-build-injection';
import { DOCKER_CONTAINER_LABEL } from './docker-commands';

import { monitorDockerNetworkAliases, stopMonitoringDockerNetworkAliases } from './docker-networking';
import { ensureDockerProxyRunning, stopDockerProxy } from './docker-proxy';

// On shutdown, clean up every container & image that we created, disappearing
// into the mist as if we were never here...
// (Those images/containers are unusable without us, so leaving them breaks things).
addShutdownHandler(() =>
    deleteAllInterceptedDockerData('all')
);

export function startDockerInterceptionServices(
    proxyPort: number,
    httpsConfig: { certPath: string, certContent: string }
) {
    return Promise.all([
        // Proxy all terminal Docker API requests, to rewrite & add injection:
        ensureDockerProxyRunning(proxyPort, httpsConfig),
        // Monitor the intercepted containers, to resolve their names in our DNS:
        monitorDockerNetworkAliases(proxyPort)
    ]);
}

export async function stopDockerInterceptionServices(proxyPort: number) {
    stopDockerProxy(proxyPort);
    stopMonitoringDockerNetworkAliases(proxyPort);
    await deleteAllInterceptedDockerData(proxyPort);
}

// When a Docker container or the whole server shuts down, we do our best to delete
// every remaining intercepted image or container. None of these will be usable
// without us anyway, as they all depend on HTTP Toolkit for connectivity.
async function deleteAllInterceptedDockerData(proxyPort: number | 'all') {
    const docker = new Docker();

    const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({
            label: [
                proxyPort === 'all'
                ? DOCKER_CONTAINER_LABEL
                : `${DOCKER_CONTAINER_LABEL}=${proxyPort}`
            ]
        })
    });

    await Promise.all(containers.map(async (containerData) => {
        const container = docker.getContainer(containerData.Id);

        // Best efforts clean stop & remove:
        await container.stop({ t: 1 }).catch(() => {});
        await container.kill().catch(() => {});
        await container.remove().catch(() => {});
    }));

    // We clean up images after containers, in case some containers depended
    // on some images that we intercepted.
    const images = await docker.listImages({
        all: true,
        filters: JSON.stringify({
            label: [
                proxyPort === 'all'
                ? DOCKER_BUILD_LABEL
                : `${DOCKER_BUILD_LABEL}=${proxyPort}`
            ]
        })
    });

    await Promise.all(images.map(async (imageData) => {
        await docker.getImage(imageData.Id).remove().catch(() => {});
    }));
}