import * as _ from 'lodash';
import * as dns2 from 'dns2';

const DNS_SERVER_MAP: { [mockServerPort: number]: Promise<DnsServer> | undefined } = {};

export function getDnsServer(mockServerPort: number): Promise<DnsServer> {
    if (!DNS_SERVER_MAP[mockServerPort]) {
        const serverPromise = (async () => {
            const server = new DnsServer();

            server.on('close', () => {
                delete DNS_SERVER_MAP[mockServerPort];
            });

            await server.start();
            return server;
        })();

        DNS_SERVER_MAP[mockServerPort] = serverPromise;
    }
    return DNS_SERVER_MAP[mockServerPort]!;
}

export async function stopDnsServer(mockServerPort: number) {
    const dnsServer = await DNS_SERVER_MAP[mockServerPort]
    if (!dnsServer) return;

    delete DNS_SERVER_MAP[mockServerPort];
    dnsServer.stop();
}

class DnsServer extends dns2.UDPServer {

    constructor() {
        super((req, sendResponse) => this.handleQuery(req, sendResponse));
    }

    private hostMaps: {
        [sourceId: string]: {
            [host: string]: Set<string> | undefined
        }
    } = {};

    setSourceHosts(sourceId: string, hosts: { [hostname: string]: Set<string> }) {
        this.hostMaps[sourceId] = hosts;
    }

    private getHostAddresses(hostname: string): Set<string> {
        return _.flatMap(this.hostMaps, (hostMap) => hostMap[hostname])
            .filter(h => !!h)
            .reduce<Set<string>>((result, set) => new Set([...result!, ...set!]), new Set());
    }

    handleQuery(request: dns2.DnsRequest, sendResponse: (response: dns2.DnsResponse) => void) {
        const response = dns2.Packet.createResponseFromRequest(request);

        // Multiple questions are allowed in theory, but apparently nobody
        // supports it, so we don't either.
        const [question] = request.questions;

        const answers = this.getHostAddresses(question.name);

        if (answers.size > 1) {
            console.log(`Multiple hosts in internal DNS for hostname ${question.name}:`, answers);
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