const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { getLocal } = require('mockttp');
const { startBound } = require('../server.ts');

const silent = { info() {}, warn() {} };
function rule(overrides = {}) {
    return { type: 'http', activated: true, matchers: [{ type: 'method', method: 0 }, { type: 'simple-path', path: '/target' }],
        steps: [{ type: 'simple', status: 209, data: 'mocked', headers: { 'content-type': 'text/plain' } }], completionChecker: { type: 'always' }, ...overrides };
}
const fallback = () => rule({ matchers: [{ type: 'wildcard' }], steps: [{ type: 'passthrough' }] });

async function tempDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-proxy-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('mock-proxy-test-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return directory;
}

async function proxy(t, apply, items, { https: ca = {}, flag = false, maxBodySize = 1024 * 1024 } = {}) {
    const server = getLocal({ recordTraffic: false, maxBodySize, ...(ca.keyPath || ca.key ? { https: ca } : {}) });
    t.after(() => server.stop());
    await apply(server, { items }, silent, { addDefaultPassthrough: flag, maxBodySize }, ca);
    await startBound(server, 0, '127.0.0.1');
    return server;
}

async function origin(t, handler, options) {
    const server = options ? https.createServer(options, handler) : http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    return server;
}

function request(port, url = 'http://example.test/target', { method = 'GET', body, headers = {}, host = '127.0.0.1', timeout = 3000, agent = false } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: url, method, headers, agent }, async res => {
            try {
                const chunks = [];
                for await (const chunk of res) chunks.push(chunk);
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            } catch (error) { reject(error); }
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => req.destroy(new Error('Request timeout')));
        req.end(body);
    });
}

function secureRequest(port, url, ca, { method = 'GET', body, headers = {} } = {}) {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const connect = http.request({ host: '127.0.0.1', port, path: target.host, method: 'CONNECT', agent: false });
        connect.on('error', reject);
        connect.setTimeout(5000, () => connect.destroy(new Error('CONNECT timeout')));
        connect.on('connect', (res, socket) => {
            if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT returned ${res.statusCode}`)); return; }
            const secure = tls.connect({ socket, servername: target.hostname, ca, rejectUnauthorized: true });
            secure.setTimeout(5000, () => secure.destroy(new Error('TLS handshake timeout')));
            secure.on('error', reject);
            secure.once('secureConnect', () => {
                const req = http.request({ host: target.hostname, path: target.pathname + target.search, method,
                    headers: { host: target.host, ...headers }, createConnection: () => secure, agent: undefined }, async response => {
                    try {
                        const chunks = [];
                        for await (const chunk of response) chunks.push(chunk);
                        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
                    } catch (error) { reject(error); }
                    finally { secure.destroy(); }
                });
                req.on('error', reject);
                req.setTimeout(5000, () => req.destroy(new Error('HTTPS timeout')));
                req.end(body);
            });
        });
        connect.end();
    });
}

module.exports = { silent, rule, fallback, tempDirectory, proxy, origin, request, secureRequest };
