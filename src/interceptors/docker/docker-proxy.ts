import * as _ from 'lodash';
import * as os from 'os';
import * as path from 'path';
import * as stream from 'stream';
import * as net from 'net';
import * as http from 'http';
import * as Dockerode from 'dockerode';
import * as getRawBody from 'raw-body';

import { deleteFile } from '../../util';
import { transformContainerCreationConfig } from './docker-commands';
import { injectIntoBuildStream, getBuildOutputPipeline } from './docker-build-injection';
import { destroyable } from '../../destroyable-server';
import { reportError } from '../../error-tracking';

export const getDockerPipePath = (proxyPort: number, targetPlatform: NodeJS.Platform = process.platform) => {
    if (targetPlatform === 'win32') {
        return `//./pipe/httptoolkit-${proxyPort}-docker`;
    } else {
        return path.join(os.tmpdir(), `httptoolkit-${proxyPort}-docker.sock`);
    }
};

const CREATE_CONTAINER_MATCHER = /^\/[^\/]+\/containers\/create/;
const BUILD_IMAGE_MATCHER = /^\/[^\/]+\/build/;

const docker = new Dockerode();

export const createDockerProxy = async (proxyPort: number, httpsConfig: { certPath: string, certContent: string }) => {
    // Hacky logic to reuse docker-modem's internal env + OS parsing logic to
    // work out where the local Docker host is:
    const dockerHostOptions = docker.modem.socketPath
        ? { socketPath: docker.modem.socketPath }
        : { host: docker.modem.host, port: docker.modem.port };

    const agent = new http.Agent({ keepAlive: true });

    const sendToDocker = (req: http.IncomingMessage, bodyStream: stream.Readable = req) => {
        const url = req.url!.replace(/^\/qwe/, '');

        const dockerReq = http.request({
            ...dockerHostOptions,
            agent: agent,

            method: req.method,
            headers: { ..._.omit(req.headers, 'content-length') },
            path: url,
        });


        bodyStream.pipe(dockerReq);

        return dockerReq;
    };

    // Forward all requests & responses to & from the real docker server:
    const server = http.createServer(async (req, res) => {
        let requestBodyStream: stream.Readable = req;

        const reqUrl = new URL(req.url!, 'http://localhost');
        const reqPath = reqUrl.pathname;

        // Intercept container creation (e.g. docker run):
        if (reqPath.match(CREATE_CONTAINER_MATCHER)) {
            const body = await getRawBody(req);
            const config = JSON.parse(body.toString('utf8')) as Dockerode.ContainerCreateOptions;

            const imageConfig = await docker.getImage(config.Image!).inspect()
                // We ignore errors - if the image doesn't exist, generally that means that the
                // create will fail, and will be re-run after the image is pulled in a minute.
                .catch(() => undefined);

            const transformedConfig = transformContainerCreationConfig(
                config,
                imageConfig,
                {
                    interceptionType: 'mount',
                    certPath: httpsConfig.certPath,
                    proxyPort
                }
            );
            requestBodyStream = stream.Readable.from(JSON.stringify(transformedConfig));
        }

        let extraDockerCommandCount = 0;
        if (reqPath.match(BUILD_IMAGE_MATCHER)) {
            if (reqUrl.searchParams.get('remote')) {
                res.writeHead(400, "Remote parameter is not supported").end();
                reportError("Build intercepcion failed due to unsupported 'remote' param");
                // Note that this also blocks buildkit (which passes 'remote=client-session;, then opens
                // a gRPC session, and streams context on-demand). That's OK - that's not supported either.
                return;
            }

            const dockerfileName = reqUrl.searchParams.get('dockerfile')
                ?? 'Dockerfile';

            const streamInjection = await injectIntoBuildStream(dockerfileName, req, {
                certContent: httpsConfig.certContent,
                proxyPort
            });

            requestBodyStream = streamInjection.injectedStream;
            extraDockerCommandCount = streamInjection.commandsAddedToDockerfile;
        }

        const dockerReq = sendToDocker(req, requestBodyStream);
        dockerReq.on('error', (e) => {
            console.error('Docker proxy error', e);
            res.destroy();
        });

        dockerReq.on('response', (dockerRes) => {
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
                dockerRes.pipe(getBuildOutputPipeline(extraDockerCommandCount)).pipe(res);
            } else {
                dockerRes.pipe(res);
            }

            res.flushHeaders(); // Required, or blocking responses (/wait) don't work!
        });
    });

    // Forward all requests & hijacked streams to & from the real docker server:
    server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
        const dockerReq = sendToDocker(req);
        dockerReq.on('error', (e) => {
            console.error('Docker proxy error', e);
            socket.destroy();
        });
        socket.on('error', (e: Error) => {
            console.error('Docker proxy conn error', e);
            dockerReq.destroy();
        });

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

    return destroyable(server);
};