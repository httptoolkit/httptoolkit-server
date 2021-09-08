import * as dns2 from 'dns2';
import { MockttpStandalone } from 'mockttp';

import { addShutdownHandler } from './shutdown';

class DnsServer extends dns2.UDPServer {

    constructor() {
        super((req, sendResponse) => this.handleQuery(req, sendResponse));
    }

    private hostMap: { [host: string]: string[] | undefined } = {};

    registerHost(hostname: string, ip: string) {
        if (!this.hostMap[hostname]) {
            this.hostMap[hostname] = [ip];
        } else {
            this.hostMap[hostname]!.push(ip);
        }
    }

    handleQuery(request: dns2.DnsRequest, sendResponse: (response: dns2.DnsResponse) => void) {
        const response = dns2.Packet.createResponseFromRequest(request);

        // Multiple questions are allowed in theory, but apparently nobody
        // supports it, so we don't either.
        const [question] = request.questions;

        const answers = this.hostMap[question.name];

        if (answers) {
            answers.forEach((answer) => {
                response.answers.push({
                    name: question.name,
                    type: dns2.Packet.TYPE.A,
                    class: dns2.Packet.CLASS.IN,
                    ttl: 0,
                    address: answer
                });
            });
        }

        sendResponse(response);
    }

    start() {
        return new Promise<void>((resolve, reject) => {
            this.listen(0, '127.0.0.1');
            this.once('listening', () => resolve());
            this.once('error', reject);
        });
    }

    stop() {
        return new Promise<void>((resolve) => {
            this.once('close', resolve);
            this.close();
        });
    }
}

const DNS_SERVER_MAP: { [mockServerPort: number]: Promise<DnsServer> } = {};

export function getDnsServer(mockServerPort: number): Promise<DnsServer> {
    if (DNS_SERVER_MAP[mockServerPort]) return DNS_SERVER_MAP[mockServerPort];

    const serverPromise = (async () => {
        const server = new DnsServer();

        server.on('close', () => {
            delete DNS_SERVER_MAP[mockServerPort];
        });

        await server.start();
        return server;
    })();

    DNS_SERVER_MAP[mockServerPort] = serverPromise;
    return serverPromise;
};

export function manageDnsServers(standalone: MockttpStandalone) {
    standalone.on('mock-server-started', (server) => getDnsServer(server.port));

    standalone.on('mock-server-stopping', async (server) => {
        const port = server.port;
        if (DNS_SERVER_MAP[port]) { // Might not exist, in some error scenarios
            (await DNS_SERVER_MAP[port]).stop();
        }
    });

    addShutdownHandler(() => Promise.all(
        Object.values(DNS_SERVER_MAP).map(async (server) =>
            (await server).stop()
        )
    ));
}