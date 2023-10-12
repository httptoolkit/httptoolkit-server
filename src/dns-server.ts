import _ from 'lodash';
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

const EMPTY_SET: ReadonlySet<string> = new Set();

class DnsServer extends dns2.UDPServer {

    constructor() {
        super((req, sendResponse) => this.handleQuery(req, sendResponse));
    }

    private hosts: {
        [host: string]: ReadonlySet<string> | undefined
    } = {};

    setHosts(hosts: { [hostname: string]: ReadonlySet<string> }) {
        this.hosts = hosts;
    }

    private getHostAddresses(hostname: string): ReadonlySet<string> {
        return this.hosts[hostname] ?? EMPTY_SET;
    }

    handleQuery(request: dns2.DnsRequest, sendResponse: (response: dns2.DnsResponse) => void) {
        const response = dns2.Packet.createResponseFromRequest(request);

        // Multiple questions are allowed in theory, but apparently nobody
        // supports it, so we don't either.
        const [question] = request.questions;
        if (!question) return sendResponse(response); // Send an empty response

        const answers = this.getHostAddresses(question.name);

        if (answers.size > 1) {
            console.log(`Multiple hosts in internal DNS for hostname ${question.name}:`, answers);
        }

        answers.forEach((answer) => {
            response.answers.push({
                name: question.name,
                type: dns2.Packet.TYPE.A,
                class: dns2.Packet.CLASS.IN,
                ttl: 0,
                address: answer
            });
        });

        sendResponse(response);
    }

    start() {
        return new Promise<void>((resolve, reject) => {
            // Only listens on localhost, only used by Mockttp itself.
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