import * as _ from 'lodash';
import * as stream from 'stream';
import * as net from 'net';
import * as http from 'http';
import * as http2 from 'http2';

import { rawHeadersToHeaders } from '../../util/http';

/**
 * A manager that intercepts BuildKit sessions, when given the corresponding sockets after the initial
 * upgrade, inject given config settings, and exposes methods to intercept build output streams elsewhere
 * to filter that injected config back out of build output.
 *
 * Under the hood, BuildKit uses the /session endpoint to upgrade the Docker CLI client into an HTTP/2 gRPC
 * server, so that the Docker host can query it to load files on demand, rather than taking the whole context
 * blindly every time. This class handles the traffic within that session, and exposes the data required
 * about that interception to handle other related logic
 *
 */
export class BuildkitSessionManager {

    connectBuildSession(
        sessionUuid: string,
        clientSocket: net.Socket,
        dockerSocket: net.Socket,
        clientHead: Buffer,
        dockerHead: Buffer
    ) {
        if (clientHead.length !== 0) {
            // CLI shouldn't send any data yet: it should be waiting for the Docker server (now the 'client')
            // to make requests on the newly upgraded connection.
            throw new Error("Unexpected CLI head data in BuildKit session upgrade");
        }

        // Docker OTOH does often send the HTTP/2 preamble immediately. We need to ensure that's included
        // in the socket's data, or HTTP/2 setup will fail.
        if (dockerHead.length !== 0) dockerSocket.unshift(dockerHead);

        // The incoming client socket is now an outgoing connection to a server:
        const clientConnection = http2.connect('http://localhost', {
            createConnection: () => clientSocket
        });

        // The outgoing Docker socket is now an incoming client connection:
        const server = http2.createServer();

        // Annoyingly, we have to wrap the socket to make unshift() work if there's any dockerHead:
        const wrappedDockerSocket = new SocketWrapper(dockerSocket);

        server.on('session', (dockerSession) => {
            // There will be exactly on session (the connection we inject below). When the CLI h2 connection
            // is closed, we need to mirror that shutdown to the docker h2 connection too:
            clientConnection.on('close', () => dockerSession.destroy());
        });

        // Treat the Docker socket as a new incoming HTTP/2 connection:
        server.emit('connection', wrappedDockerSocket);

        // For each request from Docker, forward it transparently upstream to the Docker CLI:
        server.on('stream', (dockerStream: http2.ServerHttp2Stream, _h: unknown, flags: number, rawRequestHeaders: string[]) => {
            const requestHeaders = rawHeadersToHeaders(rawRequestHeaders);

            const clientStream = clientConnection.request(requestHeaders, {
                endStream: parseHttp2HeaderFlags(flags).endStream,
                waitForTrailers: true
            });

            dockerStream.pipe(clientStream);
            clientStream.pipe(dockerStream);

            clientStream.on('response', (responseHeaders, flags) => {
                dockerStream.respond(responseHeaders, {
                    waitForTrailers: true,
                    endStream: parseHttp2HeaderFlags(flags).endStream
                });
            });

            clientStream.on('headers', (extraHeaders, flags) => {
                dockerStream.respond(extraHeaders, {
                    waitForTrailers: true,
                    endStream: parseHttp2HeaderFlags(flags).endStream
                });
            });

            // Collect and eventually forward trailers on downstream:
            let pendingTrailers: http.OutgoingHttpHeaders = {};

            clientStream.on('trailers', (trailers) => {
                // Not perfectly correct for multiple conflicting trailers, but good enough:
                pendingTrailers = { ...pendingTrailers, ...trailers };
            });

            dockerStream.once('wantTrailers', () => {
                if (!_.isEmpty(pendingTrailers)) {
                    dockerStream.sendTrailers(pendingTrailers);
                } else {
                    dockerStream.close();
                }
            });
        });
    }
}

const parseHttp2HeaderFlags = (flags: number) => ({
    endStream: Boolean(flags & 0x1),
    endHeaders: Boolean(flags & 0x4),
    padded: Boolean(flags & 0x8),
    priority: Boolean(flags & 0x20)
});

// Like Node's (built-in, deprecated) StreamWrap, but not so broken.
class SocketWrapper extends stream.Duplex {
    constructor(
        private socket: net.Socket,
        options?: stream.StreamOptions<SocketWrapper>
    ) {
        super(options);
    }

    _write(chunk: any, encoding: BufferEncoding, cb: (error?: Error | null) => void): boolean {
        if (!Buffer.isBuffer(chunk)) {
            chunk = Buffer.from(chunk, encoding);
        }
        return this.socket.write(chunk, cb);
    }

    _read(size: number) {
        const data = this.socket.read(size);
        if (data && data.length) this.push(data);
        else this.socket.once('data', (d) => {
            this.push(d);
        });
    }
}