import _ from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream';
import * as net from 'net';
import * as http from 'http';
import Dockerode from 'dockerode';
import getRawBody from 'raw-body';
import { makeDestroyable, DestroyableServer } from 'destroyable-server';

import { chmod, deleteFile, readDir } from '../../util/fs';
import { rawHeadersToHeaders } from '../../util/http';
import { streamToBuffer } from '../../util/stream';
import { logError } from '../../error-tracking';
import { addShutdownHandler } from '../../shutdown';

import { getDockerAddress } from './docker-utils';
import {
    isInterceptedContainer,
    transformContainerCreationConfig
} from './docker-commands';
import { injectIntoBuildStream, getBuildOutputPipeline } from './docker-build-injection';
import { ensureDockerServicesRunning, isDockerAvailable } from './docker-interception-services';
import { transformComposeResponseLabels } from './docker-compose';

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
const ATTACH_CONTAINER_MATCHER = /^\/[^\/]+\/containers\/([^\/]+)\/attach/;
const CONTAINER_LIST_MATCHER = /^\/[^\/]+\/containers\/json/;
const CONTAINER_INSPECT_MATCHER = /^\/[^\/]+\/containers\/[^\/]+\/json/;

const DOCKER_PROXY_MAP: {
    [mockServerPort: number]: Promise<DestroyableServer<net.Server>> | undefined
} = {};

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

async function createDockerProxy(
    proxyPort: number,
    httpsConfig: { certPath: string, certContent: string }
) {
    const docker = new Dockerode();

    const dockerHostOptions = await getDockerAddress(docker);

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

        ensureDockerServicesRunning(proxyPort);

        // Intercept container creation (e.g. docker run):
        if (reqPath.match(CREATE_CONTAINER_MATCHER)) {
            const body = await getRawBody(req);
            const config = JSON.parse(body.toString('utf8')) as Dockerode.ContainerCreateOptions;

            const imageConfig = await docker.getImage(config.Image!).inspect()
                // We ignore errors - if the image doesn't exist, generally that means that the
                // create will fail, and will be re-run after the image is pulled in a minute.
                .catch(() => undefined);

            const transformedConfig = await transformContainerCreationConfig(
                config,
                imageConfig,
                { proxyPort, certContent: httpsConfig.certContent }
            );
            requestBodyStream = stream.Readable.from(JSON.stringify(transformedConfig));
        }

        // Intercept container creation (e.g. docker start):
        const startContainerMatch = START_CONTAINER_MATCHER.exec(reqPath);
        if (startContainerMatch) {
            const containerId = startContainerMatch[1];
            const containerData = await docker.getContainer(containerId).inspect().catch(() => undefined);

            if (containerData && !isInterceptedContainer(containerData, proxyPort)) {
                res.writeHead(400).end(
                    "HTTP Toolkit cannot intercept startup of preexisting non-intercepted containers. " +
                    "The container must be recreated here first - try `docker run <image>` instead."
                );
            }
        }

        let extraDockerCommandCount: Promise<number> | undefined;
        if (reqPath.match(BUILD_IMAGE_MATCHER)) {
            if (reqUrl.searchParams.get('remote')) {
                res.writeHead(400);
                logError("Build interception failed due to unsupported 'remote' param");

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
        }

        const dockerReq = sendToDocker(req, requestBodyStream);
        dockerReq.on('error', (e) => {
            console.error('Docker proxy error', e);
            res.destroy();
        });

        dockerReq.on('response', async (dockerRes) => {
            res.on('error', (e) => {
                console.error('Docker proxy conn error', e);
                dockerRes.destroy();
            });

            // In any container data responses that might be used by docker-compose, we need to remap some of the
            // content to ensure that intercepted containers are always used:
            const isContainerInspect = reqPath.match(CONTAINER_INSPECT_MATCHER);
            const isComposeContainerQuery = reqPath.match(CONTAINER_LIST_MATCHER) &&
                reqUrl.searchParams.get('filters')?.includes("com.docker.compose");
            const shouldRemapContainerData = isContainerInspect || isComposeContainerQuery;

            if (shouldRemapContainerData) {
                // We're going to mess with the body, so we need to ensure that the content
                // length isn't going to conflict along the way:
                delete dockerRes.headers['content-length'];
            }

            res.writeHead(
                dockerRes.statusCode!,
                dockerRes.statusMessage,
                dockerRes.headers
            );
            res.flushHeaders(); // Required, or blocking responses (/wait) don't work!

            if (reqPath.match(BUILD_IMAGE_MATCHER) && dockerRes.statusCode === 200) {
                // We transform the build output to replace the docker build interception steps with a cleaner
                // & simpler HTTP Toolkit interception message:
                dockerRes.pipe(getBuildOutputPipeline(await extraDockerCommandCount!)).pipe(res);
            } else if (shouldRemapContainerData) {
                // We need to remap container data, to hook all docker-compose behaviour:
                const data = await streamToBuffer(dockerRes);

                try {
                    if (isComposeContainerQuery) {
                        const containerQueryResponse: Dockerode.ContainerInfo[] = JSON.parse(data.toString('utf8'));
                        const modifiedResponse = containerQueryResponse.map((container) => ({
                            ...container,
                            Labels: transformComposeResponseLabels(proxyPort, container.Labels)
                        }));

                        res.end(JSON.stringify(modifiedResponse));
                    } else {
                        const containerInspectResponse: Dockerode.ContainerInspectInfo = JSON.parse(data.toString('utf8'));
                        const modifiedResponse = {
                            ...containerInspectResponse,
                            Config: {
                                ...containerInspectResponse.Config,
                                Labels: transformComposeResponseLabels(proxyPort, containerInspectResponse.Config?.Labels)
                            }
                        };

                        res.end(JSON.stringify(modifiedResponse));
                    }
                } catch (e) {
                    console.error("Failed to parse container data response", e);
                    // Write the raw body back to the response - effectively just do nothing.
                    res.end(data);
                }
            } else {
                dockerRes.pipe(res);
            }
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

        // We have to include initial data in the upstream request. This is especially important for
        // commands like /exec/.../start, which send JSON config {detach:...} in the initial request,
        // which the docker daemon waits before it will accept the upgrade (or 400s, if it's missing).
        req.unshift(head);

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

    if (process.platform === 'win32') {
        // We're using local pipes - we can safely keep connections open forever, and doing so is
        // necessary on Windows, because docker-compose there does not expected connections in its
        // pool to ever be closed by the server, and crashes if they are. Can't use actual Infinity
        // since Node rejects it, but 1 hour should be far more than any client's own timeout.
        server.keepAliveTimeout = 1000 * 60 * 60;
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

    return makeDestroyable(server);
};