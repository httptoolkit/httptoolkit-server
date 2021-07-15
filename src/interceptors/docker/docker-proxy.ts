import * as http from 'http';
import * as Modem from 'docker-modem';
import { getPortPromise as getPort } from 'portfinder';

export const createDockerProxy = async () => {
    // Hacky logic to reuse docker-modem's internal env + OS parsing logic to
    // work out where the local Docker host is:
    const dockerModem = (new Modem() as any);
    const dockerHostOptions = dockerModem.socketPath
        ? { socketPath: dockerModem.socketPath }
        : { host: dockerModem.host, port: dockerModem.port };


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

    const port = await getPort();
    await new Promise<void>((resolve, reject) => {
        server.listen(port, '127.0.0.1', resolve);
        server.on('error', reject);
    });
    return server;
};