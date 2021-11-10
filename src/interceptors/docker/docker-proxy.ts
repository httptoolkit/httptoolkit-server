import * as _ from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream';
import * as net from 'net';
import * as http from 'http';
import * as Dockerode from 'dockerode';
import * as getRawBody from 'raw-body';
import { AbortController } from 'node-abort-controller';

import { chmod, deleteFile, readDir } from '../../util/fs';
import { rawHeadersToHeaders } from '../../util/http';
import { destroyable, DestroyableServer } from '../../destroyable-server';
import { reportError } from '../../error-tracking';
import { addShutdownHandler } from '../../shutdown';

import {
    isInterceptedContainer,
    transformContainerCreationConfig,
    DOCKER_HOST_HOSTNAME,
    getDockerHostIp
} from './docker-commands';
import { injectIntoBuildStream, getBuildOutputPipeline } from './docker-build-injection';
import { ensureDockerServicesRunning, isDockerAvailable } from './docker-interception-services';

export const getDockerPipePath = (proxyPort: number, targetPlatform: NodeJS.Platform = process.platform) => {
    if (targetPlatform === 'win32') {
        return `//./pipe/httptoolkit-${proxyPort}-docker`;
    } else {
        return path.join(os.tmpdir(), `httptoolkit-${proxyPort}-docker.sock`);
    }
};

if (process.platform !== 'win32') {
    // At shutdown on Linux/Mac we cleanup all our leftover Docker sockets:
    addShutdownHandler(async () => Promise.all(
        (await readDir(os.tmpdir()))
            .filter((filename) => filename.match(/^httptoolkit-\d+-docker.sock$/))
            .map((filename) => deleteFile(path.join(os.tmpdir(), filename)))
    ));
}

const API_VERSION_MATCH = /^\/v?([\.\d]+)\//;
const CREATE_CONTAINER_MATCHER = /^\/[^\/]+\/containers\/create/;
const START_CONTAINER_MATCHER = /^\/[^\/]+\/containers\/([^\/]+)\/start/;
const BUILD_IMAGE_MATCHER = /^\/[^\/]+\/build$/;
const EVENTS_MATCHER = /^\/[^\/]+\/events$/;
const ATTACH_CONTAINER_MATCHER = /^\/[^\/]+\/containers\/([^\/]+)\/attach/;
const CONTAINER_LIST_MATCHER = /^\/[^\/]+\/containers\/json/;

const DOCKER_PROXY_MAP: { [mockServerPort: number]: Promise<DestroyableServer> | undefined } = {};

export async function ensureDockerProxyRunning(
    proxyPort: number,
    httpsConfig: { certPath: string, certContent: string }
) {
    if (!DOCKER_PROXY_MAP[proxyPort]) {
        DOCKER_PROXY_MAP[proxyPort] = createDockerProxy(proxyPort, httpsConfig);
    }

    await DOCKER_PROXY_MAP[proxyPort];
};

export async function stopDockerProxy(proxyPort: number) {
    const proxy = await DOCKER_PROXY_MAP[proxyPort];
    if (!proxy) return;

    delete DOCKER_PROXY_MAP[proxyPort];
    await proxy.destroy();
}

async function createDockerProxy(proxyPort: number, httpsConfig: { certPath: string, certContent: string }) {
    const docker = new Dockerode();

    // Hacky logic to reuse docker-modem's internal env + OS parsing logic to
    // work out where the local Docker host is:
    const modem = docker.modem as any as ({ socketPath: string } | { host: string, port: number });
    const dockerHostOptions = 'socketPath' in modem
        ? { socketPath: modem.socketPath }
        : { host: modem.host, port: modem.port };

    const agent = new http.Agent({ keepAlive: true });

    const sendToDocker = (req: http.IncomingMessage, bodyStream: stream.Readable = req) => {
        const headers = rawHeadersToHeaders(req.rawHeaders);

        const dockerReq = http.request({
            ...dockerHostOptions,
            agent: agent,

            method: req.method,
            headers: _.omitBy(headers, (_v, k) => k.toLowerCase() === 'content-length'),
            path: req.url,
        });


        bodyStream.pipe(dockerReq);

        return dockerReq;
    };

    // Forward all requests & responses to & from the real docker server:
    const server = http.createServer(async (req, res) => {
        if (!await isDockerAvailable()) {
            res.writeHead(504, "Docker not available").end("HTTP Toolkit could not connect to Docker");
            return;
        }

        let requestBodyStream: stream.Readable = req;

        const reqUrl = new URL(req.url!, 'http://localhost');
        const reqPath = reqUrl.pathname;

        const dockerApiVersion = API_VERSION_MATCH.exec(reqPath)?.[1];

        ensureDockerServicesRunning(proxyPort);

        // Intercept container creation (e.g. docker run):
        if (reqPath.match(CREATE_CONTAINER_MATCHER)) {
            const body = await getRawBody(req);
            const config = JSON.parse(body.toString('utf8')) as Dockerode.ContainerCreateOptions;

            const imageConfig = await docker.getImage(config.Image!).inspect()
                // We ignore errors - if the image doesn't exist, generally that means that the
                // create will fail, and will be re-run after the image is pulled in a minute.
                .catch(() => undefined);

            const proxyHost = getDockerHostIp(
                process.platform,
                { apiVersion: dockerApiVersion! },
            );

            const transformedConfig = transformContainerCreationConfig(
                config,
                imageConfig,
                {
                    interceptionType: 'mount',
                    certPath: httpsConfig.certPath,
                    proxyPort,
                    proxyHost
                }
            );
            requestBodyStream = stream.Readable.from(JSON.stringify(transformedConfig));

            // If you try to create a container with a name that directly conflicts with another name
            // that's currently in use by a non-intercepted container, we create a separate container
            // with an _HTK$PORT suffix to avoid conflicts. This happens commonly, because of how
            // docker-compose automatically generates container names.
            const containerName = reqUrl.searchParams.get('name');
            if (containerName) {
                const existingContainer = await docker.getContainer(containerName).inspect()
                    .catch<false>(() => false);
                if (existingContainer && !isInterceptedContainer(existingContainer, proxyPort)) {
                    if (!existingContainer.State.Running) {
                        // If there's a duplicate but stopped container, we start the new container with an
                        // modified name, so that everything works with no conflicts:
                        reqUrl.searchParams.set('name', `${containerName}_HTK${proxyPort}`);
                        req.url = reqUrl.toString();
                    } else {
                        // If there's a duplicate running container, we could to the same, but instead we return an error.
                        // It's likely that this will create conflicts otherwise, e.g. two running containers using the
                        // same volumes or the same network aliases. Better to play it safe.
                        res.statusCode = 409;
                        res.end(JSON.stringify({
                            "message": `Conflict. The container name ${
                                containerName
                            } is already in use by a running container.\n${''
                            }HTTP Toolkit won't intercept this by default to avoid conflicts with shared resources. ${''
                            }To create & intercept this container, either stop the existing unintercepted container, or use a different name.`
                        }));
                        return;
                    }
                }
            }
        }

        // Intercept container creation (e.g. docker start):
        const startContainerMatch = START_CONTAINER_MATCHER.exec(reqPath);
        if (startContainerMatch) {
            const containerId = startContainerMatch[1];
            if (!isInterceptedContainer(await docker.getContainer(containerId).inspect(), proxyPort)) {
                res.writeHead(400).end(
                    "HTTP Toolkit cannot intercept startup of preexisting non-intercepted containers. " +
                    "The container must be recreated here first - try `docker run <image>` instead."
                );
            }
        }

        if (
            reqPath.match(CONTAINER_LIST_MATCHER) ||
            reqPath.match(EVENTS_MATCHER)
        ) {
            const filterString = reqUrl.searchParams.get('filters') ?? '{}';

            try {
                const filters = JSON.parse(filterString) as {
                    // Docs say only string[] is allowed, but Docker CLI uses bool maps in "docker compose"
                    [key: string]: string[] | { [key: string]: boolean }
                };
                const labelFilters = (
                    _.isArray(filters.label)
                        ? filters.label
                        : Object.keys(filters.label)
                            .filter(key => !!(filters.label as _.Dictionary<boolean>)[key])
                );
                const projectFilter = labelFilters.filter(l => l.startsWith("com.docker.compose.project="))[0];

                if (projectFilter) {
                    const project = projectFilter.slice(projectFilter.indexOf('=') + 1);

                    // This is a request from docker-compose, looking for containers related to a
                    // specific project. Add an extra filter so that it only finds *intercepted*
                    // containers. This ensures it'll recreate any unintercepted containers.
                    reqUrl.searchParams.set('filters', JSON.stringify({
                        ...filters,
                        label: [
                            // Replace the project filter, to ensure that the intercepted & non-intercepted containers
                            // are handled separately. We need to ensure that a) this request only finds intercepted
                            // containers, and b) future non-proxied requests only find non-intercepted containers.
                            // By excluding non-intercepted containers, we force DC to recreate, so we can then
                            // intercept the container creation itself and inject what we need.
                            ...labelFilters.filter((label) => label !== projectFilter),
                            `com.docker.compose.project=${project}_HTK:${proxyPort}`
                        ]
                    }));
                    req.url = reqUrl.toString();
                }
            } catch (e) {
                console.log("Could not parse /containers/json filters param", e);
            }
        }

        let extraDockerCommandCount: Promise<number> | undefined;
        if (reqPath.match(BUILD_IMAGE_MATCHER)) {
            if (reqUrl.searchParams.get('remote')) {
                res.writeHead(400);
                reportError("Build interception failed due to unsupported 'remote' param");

                if (reqUrl.searchParams.get('remote') === 'client-session') {
                    res.end("HTTP Toolkit does not yet support BuildKit-powered builds");
                } else {
                    res.end("HTTP Toolkit does not support intercepting remote build sources");
                }
                return;
            }

            const dockerfileName = reqUrl.searchParams.get('dockerfile')
                ?? 'Dockerfile';

            const streamInjection = await injectIntoBuildStream(dockerfileName, req, {
                certContent: httpsConfig.certContent,
                proxyPort
            });

            requestBodyStream = streamInjection.injectedStream;
            extraDockerCommandCount = streamInjection.totalCommandsAddedPromise;

            // Make sure that host.docker.internal resolves on Linux too:
            if (process.platform === 'linux') {
                reqUrl.searchParams.append(
                    'extrahosts',
                    `${DOCKER_HOST_HOSTNAME}:${getDockerHostIp(
                        process.platform,
                        { apiVersion: dockerApiVersion! }
                    )}`
                );
                req.url = reqUrl.toString();
            }
        }

        const dockerReq = sendToDocker(req, requestBodyStream);
        dockerReq.on('error', (e) => {
            console.error('Docker proxy error', e);
            res.destroy();
        });

        dockerReq.on('response', async (dockerRes) => {
            res.writeHead(
                dockerRes.statusCode!,
                dockerRes.statusMessage,
                dockerRes.headers
            );
            res.on('error', (e) => {
                console.error('Docker proxy conn error', e);
                dockerRes.destroy();
            });

            if (reqPath.match(BUILD_IMAGE_MATCHER) && dockerRes.statusCode === 200) {
                dockerRes.pipe(getBuildOutputPipeline(await extraDockerCommandCount!)).pipe(res);
            } else {
                dockerRes.pipe(res);
            }

            res.flushHeaders(); // Required, or blocking responses (/wait) don't work!
        });
    });

    // Forward all requests & hijacked streams to & from the real docker server:
    server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        if (!await isDockerAvailable()) {
            socket.end(
                "HTTP/1.1 504 Docker not available\r\n\r\n" +
                "HTTP Toolkit could not connect to Docker\r\n"
            );
            return;
        }

        const dockerReq = sendToDocker(req);
        dockerReq.on('error', (e) => {
            console.error('Docker proxy error', e);
            socket.destroy();
        });
        socket.on('error', (e: Error) => {
            console.error('Docker proxy conn error', e);
            dockerReq.destroy();
        });

        const attachMatch = ATTACH_CONTAINER_MATCHER.exec(req.url!);

        // Python Docker compose (every version since 2016 at least) uses its own user agent, and
        // has problems with unexpected closure of attach requests
        const isPythonDockerCompose = (req.headers['user-agent'] ?? '').startsWith('docker-compose/');

        if (attachMatch && process.platform === 'win32' && !isPythonDockerCompose) {
            // On Windows for some reason attach doesn't exit by itself when containers do. To handle
            // that, we watch for exit ourselves, kill the attach shortly afterwards, in case it isn't dead
            // already.

            // This only affects Windows, and it's disabled for Python docker-compose, which doesn't handle
            // clean closure well (throwing pipe errors) but which does know how to clean up attach connections
            // all by itself (it tracks container events to close from the client side).

            const abortController = new AbortController();

            docker.getContainer(attachMatch[1]).wait({
                condition: 'next-exit',
                abortSignal: abortController.signal
            }).then(() => {
                setTimeout(() => {
                    socket.end();
                }, 500); // Slightly delay, in case there's more output/clean close on the way
            }).catch((err) => {
                if (abortController.signal.aborted) return; // If we aborted, we don't care about errors
                console.log("Error waiting for container exit on attach", err);
            });

            socket.on('close', () => {
                // Make sure the wait is shut down if the attach is disconnected for any reason:
                abortController.abort();
            });
        }

        dockerReq.on('upgrade', (dockerRes, dockerSocket, dockerHead) => {
            socket.write(
                `HTTP/1.1 ${dockerRes.statusCode} ${dockerRes.statusMessage}\r\n` +
                Object.keys(dockerRes.headers).map((key) =>
                    `${key}: ${dockerRes.headers[key]}\r\n`
                ).join("") +
                "\r\n"
            );

            // We only write upgrade head data if it's non-empty. For some bizarre reason on
            // Windows, writing empty data to a named pipe here kills the connection entirely.
            if (dockerHead.length) socket.write(dockerHead);
            if (head.length) dockerSocket.write(head);

            dockerSocket.on('error', (e) => {
                console.error('Docker proxy error', e);
                socket.destroy();
            });

            socket.pipe(dockerSocket);
            dockerSocket.pipe(socket);
        });
    });

    const proxyListenPath = getDockerPipePath(proxyPort);
    if (process.platform !== 'win32') {
        // Outside windows, sockets live on the filesystem, and persist. If a server
        // failed to clean up properly, they may still be present, which will
        // break server startup, so we clean up first:
        await deleteFile(proxyListenPath).catch(() => {});
    }

    await new Promise<void>((resolve, reject) => {
        server.listen(proxyListenPath, resolve);
        server.on('error', reject);
    });

    if (process.platform !== 'win32') {
        // This socket lets you directly access Docker with the permissions of the current
        // process, which is pretty powerful - access should be limited to this user only.
        await chmod(proxyListenPath, 0o700);
    }

    return destroyable(server);
};