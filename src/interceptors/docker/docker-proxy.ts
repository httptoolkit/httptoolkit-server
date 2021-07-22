import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as Dockerode from 'dockerode';

import { deleteFile } from '../../util';
import { destroyable } from '../../destroyable-server';

export const getDockerPipePath = (proxyPort: number, targetPlatform: NodeJS.Platform = process.platform) => {
    if (targetPlatform === 'win32') {
        return `\\\\.\\pipe\\httptoolkit-${proxyPort}-docker`;
    } else {
        return path.join(os.tmpdir(), `httptoolkit-${proxyPort}-docker.sock`);
    }
};

const docker = new Dockerode();

export const createDockerProxy = async (proxyPort: number, httpsConfig: { certPath: string }) => {
    // Hacky logic to reuse docker-modem's internal env + OS parsing logic to
    // work out where the local Docker host is:
    const dockerHostOptions = docker.modem.socketPath
        ? { socketPath: docker.modem.socketPath }
        : { host: docker.modem.host, port: docker.modem.port };

    const agent = new http.Agent({ keepAlive: true });

    const sendToDocker = (req: http.IncomingMessage) => {
        const url = req.url!.replace(/^\/qwe/, '');

        const dockerReq = http.request({
            ...dockerHostOptions,
            agent: agent,

            method: req.method,
            headers: { ...req.headers },
            path: url,
        });
        req.pipe(dockerReq);

        return dockerReq;
    };

    // Forward all requests & responses to & from the real docker server:
    const server = http.createServer((req, res) => {
        const dockerReq = sendToDocker(req);

        dockerReq.on('response', (dockerRes) => {
            res.writeHead(
                dockerRes.statusCode!,
                dockerRes.statusMessage,
                dockerRes.headers
            );

            dockerRes.pipe(res);
            res.flushHeaders(); // Required, or blocking responses (/wait) don't work!
        });
    });

    // Forward all requests & hijacked streams to & from the real docker server:
    server.on('upgrade', (req, socket, head) => {
        const dockerReq = sendToDocker(req);

        dockerReq.on('upgrade', (dockerRes, dockerSocket, dockerHead) => {
            socket.write(
                `HTTP/1.1 ${dockerRes.statusCode} ${dockerRes.statusMessage}\r\n` +
                Object.keys(dockerRes.headers).map((key) =>
                    `${key}: ${dockerRes.headers[key]}\r\n`
                ).join("") +
                "\r\n"
            );

            socket.write(dockerHead);
            dockerSocket.write(head);

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