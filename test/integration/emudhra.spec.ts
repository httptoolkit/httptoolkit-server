import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as net from 'net';
import fetch from 'node-fetch';
import getPort from 'get-port';
import { getRemote, Mockttp } from 'mockttp';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { expect } from 'chai';

describe('eMudhra interception port', function () {
    this.timeout(30000);
    let directory: string;
    let apiPort: number;
    let adminPort: number;
    let process: ChildProcess;
    let closed: Promise<unknown>;
    let proxy: Mockttp;
    let secondProxy: Mockttp | undefined;
    const headers = { origin: 'https://app.httptoolkit.tech', 'content-type': 'application/json' };

    const api = async (url: string, body?: object) => {
        const response = await fetch(`http://127.0.0.1:${apiPort}${url}`, {
            method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body)
        });
        expect(response.status).to.equal(200);
        return response.json();
    };
    const request = (port: number, ca: string) => new Promise<string>((resolve, reject) => {
        const agent = new HttpsProxyAgent(`http://localhost:${port}`);
        https.get('https://example.test/', { agent, ca }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => { agent.destroy(); resolve(body); });
            res.on('error', reject);
        }).on('error', error => { agent.destroy(); reject(error); });
    });

    before(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'htk-emudhra-port-'));
        apiPort = await getPort();
        adminPort = await getPort();
        process = spawn(global.process.execPath, [path.join(__dirname, '../../bin/run'), 'start',
            '--config', directory, '--server-port', String(apiPort), '--mockttp-port', String(adminPort)
        ], {
            env: { ...global.process.env, HTTPTOOLKIT_SERVER_DISABLE_AUTOUPDATE: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        closed = new Promise(resolve => process.once('close', resolve));
        await new Promise<void>((resolve, reject) => {
            let output = '';
            process.stdout!.on('data', data => {
                output += data;
                if (output.includes('\nServer started')) resolve();
            });
            process.stderr!.on('data', data => { output += data; });
            process.once('error', reject);
            process.once('close', () => reject(new Error(output)));
        });
        proxy = getRemote({ adminServerUrl: `http://127.0.0.1:${adminPort}`, client: { headers: { origin: headers.origin } } });
        await proxy.start();
    });
    after(async () => {
        await secondProxy?.stop();
        await proxy?.stop();
        process?.kill('SIGTERM');
        await closed;
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('uses the legacy CA on an opt-in port while preserving normal interception', async () => {
        const initial = (await api('/config')).config;
        const localCA = await fs.readFile(initial.certificatePath, 'utf8');
        expect(proxy.extraHttpsNames).to.deep.equal(['emudhra']);

        const [port, repeatedPort] = await Promise.all([proxy.enableExtraHttps('emudhra'), proxy.enableExtraHttps('emudhra')]);
        expect(port).to.equal(repeatedPort);
        expect(port).not.to.equal(proxy.port);
        await proxy.forAnyRequest().thenReply(200, 'same session');
        let requestCount = 0;
        let requestsSeen: () => void;
        const observed = new Promise<void>(resolve => { requestsSeen = resolve; });
        await proxy.on('request', () => {
            if (++requestCount === 2) requestsSeen();
        });
        const root = await fs.readFile(path.join(__dirname, '../fixtures/aaa-certificate-services.pem'), 'utf8');
        expect(await request(proxy.port, localCA)).to.equal('same session');
        expect(await request(port, root)).to.equal('same session');
        await observed;
        expect(requestCount).to.equal(2);
        expect((await api('/config')).config.certificateContent).to.equal(localCA);
        expect(await fs.readFile(initial.certificatePath, 'utf8')).to.equal(localCA);
        expect((await fs.readdir(directory)).some(name => name.includes('emudhra'))).to.equal(false);
    });

    it('keeps additional ports scoped to their session and closes them on shutdown', async () => {
        secondProxy = getRemote({ adminServerUrl: `http://127.0.0.1:${adminPort}`, client: { headers: { origin: headers.origin } } });
        await secondProxy.start();
        await secondProxy.forAnyRequest().thenReply(200, 'second session');
        const port = await secondProxy.enableExtraHttps('emudhra');
        const proxyPort = secondProxy.port;
        const root = await fs.readFile(path.join(__dirname, '../fixtures/aaa-certificate-services.pem'), 'utf8');
        expect(await request(port, root)).to.equal('second session');
        await secondProxy.stop();
        secondProxy = undefined;
        const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
            const socket = net.connect(port, 'localhost');
            socket.once('connect', () => { socket.destroy(); reject(new Error('Port is still open')); });
            socket.once('error', resolve);
        });
        expect(error.code).to.equal('ECONNREFUSED');
        secondProxy = getRemote({ adminServerUrl: `http://127.0.0.1:${adminPort}`, client: { headers: { origin: headers.origin } } });
        await secondProxy.start(proxyPort);
        await secondProxy.forAnyRequest().thenReply(200, 'replacement session');
        expect(await request(await secondProxy.enableExtraHttps('emudhra'), root)).to.equal('replacement session');
        expect(await request(await proxy.enableExtraHttps('emudhra'), root)).to.equal('same session');
    });
});
