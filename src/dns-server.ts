import * as _ from 'lodash';
import * as dns2 from 'dns2';
import { MockttpStandalone } from 'mockttp';

class DnsServer extends dns2.UDPServer {

    constructor() {
        super((req, sendResponse) => this.handleQuery(req, sendResponse));
    }

    private hostMaps: {
        [sourceId: string]: {
            [host: string]: string[] | undefined
        }
    } = {};

    setSourceHosts(sourceId: string, hosts: { [hostname: string]: string[] }) {
        this.hostMaps[sourceId] = hosts;
    }

    private getHostAddresses(hostname: string) {
        return _.flatMap(this.hostMaps, (hostMap) => hostMap[hostname])
            .filter(h => !!h) as string[];
    }

    handleQuery(request: dns2.DnsRequest, sendResponse: (response: dns2.DnsResponse) => void) {
        const response = dns2.Packet.createResponseFromRequest(request);

        // Multiple questions are allowed in theory, but apparently nobody
        // supports it, so we don't either.
        const [question] = request.questions;

        const answers = this.getHostAddresses(question.name);

        if (answers.length > 1) {
            console.log(`Multiple hosts in internal DNS for hostname ${question.name}: ${answers}`);
        }

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

const DNS_SERVER_MAP: { [mockServerPort: number]: Promise<DnsServer> | undefined } = {};

export function getDnsServer(mockServerPort: number): Promise<DnsServer> {
    if (DNS_SERVER_MAP[mockServerPort]) return DNS_SERVER_MAP[mockServerPort]!;

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
            (await DNS_SERVER_MAP[port]!).stop();
        }
    });
}