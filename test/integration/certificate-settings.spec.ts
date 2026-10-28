import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { expect } from 'chai';
import fetch from 'node-fetch';
import getPort from 'get-port';
import { getRemote, Mockttp } from 'mockttp';
import { HttpsProxyAgent } from 'https-proxy-agent';

// REST settings and proxy-session reloads used by the app.
describe('TLS certificate settings API', function () {
    this.timeout(30000);
    let directory: string;
    let apiPort: number;
    let adminPort: number;
    let process: ChildProcess | undefined;
    let closed: Promise<unknown>;
    let proxy: Mockttp | undefined;
    const headers = { origin: 'https://app.httptoolkit.tech', 'content-type': 'application/json' };

    async function start(args: string[] = []) {
        process = spawn(global.process.execPath, [path.join(__dirname, '../../bin/run'), 'start',
            '--config', directory, '--server-port', String(apiPort), '--mockttp-port', String(adminPort), ...args], {
            env: { ...global.process.env, HTTPTOOLKIT_SERVER_DISABLE_AUTOUPDATE: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        closed = new Promise(resolve => process!.once('close', resolve));
        await new Promise<void>((resolve, reject) => {
            let output = '';
            process!.stdout!.on('data', data => {
                output += data;
                if (output.includes('\nServer started')) resolve();
            });
            process!.stderr!.on('data', data => { output += data; });
            process!.once('error', reject);
            process!.once('close', () => reject(new Error(output)));
        });
    }
    async function stop() {
        if (proxy) await proxy.stop();
        proxy = undefined;
        process?.kill('SIGTERM');
        await closed;
        process = undefined;
    }
    const api = (url: string, body?: object) => fetch(`http://127.0.0.1:${apiPort}${url}`, {
        method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body)
    });
    const config = async () => (await (await api('/config')).json()).config;

    before(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htk-certificate-api-'));
        apiPort = await getPort();
        adminPort = await getPort();
        await start();
    });
    after(async () => {
        await stop();
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('advertises support and rejects invalid choices without changing the CA', async () => {
        const initial = await config();
        expect(initial.certificateModes).to.deep.equal(['local', 'emudhra', 'emudhra-old']);
        expect(initial.certificateMode).to.equal('local');
        const response = await api('/config/certificate', { certificateMode: 'invalid' });
        expect(response.status).to.equal(400);
        expect((await config()).certificateFingerprint).to.equal(initial.certificateFingerprint);
    });

    for (const mode of ['emudhra', 'emudhra-old'] as const) {
        it(`selects ${mode} from settings and signs new proxy sessions with its full chain`, async () => {
            const response = await api('/config/certificate', { certificateMode: mode });
            expect(response.status).to.equal(200);
            expect((await config()).certificateMode).to.equal(mode);
            proxy = getRemote({ adminServerUrl: `http://127.0.0.1:${adminPort}`, client: { headers: { origin: headers.origin } } });
            await proxy.start();
            await proxy.forGet('https://example.test/').thenReply(200, 'settings-enabled interception');
            const root = await fs.readFile(path.join(__dirname, '../fixtures', mode === 'emudhra-old' ? 'aaa-certificate-services.pem' : 'emsign-ecc-root-g3.pem'), 'utf8');
            const agent = new HttpsProxyAgent(proxy.url.replace('https:', 'http:'));
            try {
                const text = await new Promise<string>((resolve, reject) => {
                    https.get('https://example.test/', { agent, ca: root, rejectUnauthorized: true }, res => {
                        let body = '';
                        res.on('data', chunk => { body += chunk; });
                        res.on('end', () => resolve(body));
                        res.on('error', reject);
                    }).on('error', reject);
                });
                expect(text).to.equal('settings-enabled interception');
            } finally {
                agent.destroy();
                await proxy.stop();
                proxy = undefined;
            }
        });
    }

    it('persists across server restarts and can restore the original local CA', async () => {
        const localCert = await fs.readFile(path.join(directory, 'ca.pem'), 'utf8');
        await stop();
        await start();
        expect((await config()).certificateMode).to.equal('emudhra-old');
        expect((await api('/config/certificate', { certificateMode: 'local' })).status).to.equal(200);
        expect((await config()).certificateContent).to.equal(localCert);
        await stop();
        await start();
        expect((await config()).certificateMode).to.equal('local');
        expect((await config()).certificateContent).to.equal(localCert);
    });

    it('honors both CLI flags with legacy taking priority, without overwriting the saved choice', async () => {
        await stop();
        await start(['--emudhra', '--emudhra-old']);
        expect((await config()).certificateMode).to.equal('emudhra-old');
        await stop();
        await start(['--emudhra']);
        expect((await config()).certificateMode).to.equal('emudhra');
        await stop();
        await start();
        expect((await config()).certificateMode).to.equal('local');
    });
});
