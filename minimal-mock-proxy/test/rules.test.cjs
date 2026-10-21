const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const http2 = require('node:http2');
const WebSocket = require('ws');
const { once } = require('node:events');
const { X509Certificate } = require('node:crypto');
const { rule, fallback, proxy, origin, request, tempDirectory, silent } = require('./helpers.cjs');
const { generateHttpsConfig } = require('../server.ts');

for (const entry of ['server.ts', 'server.js']) {
    const { applyHtkRules: apply } = require(path.join('..', entry));
    const name = text => `${entry}: ${text}`;

    for (const [type, extra, rejected, accepted] of [
        ['header', { type: 'header', headers: { 'x-required': 'yes' } }, {}, { headers: { 'x-required': 'yes' } }],
        ['query', { type: 'query', queryObject: { mode: 'mock' } }, { query: '?mode=live' }, { query: '?mode=mock' }],
        ['exact query', { type: 'exact-query-string', query: '?a=1&a=2' }, { query: '?a=2&a=1' }, { query: '?a=1&a=2' }],
        ['host', { type: 'hostname', hostname: 'allowed.test' }, { hostUrl: 'other.test' }, { hostUrl: 'allowed.test' }]
    ]) {
        test(name(`${type} constraints must match`), async t => {
            const server = await proxy(t, apply, [rule({ matchers: [...rule().matchers, extra] })]);
            const send = options => request(server.port, `http://${options.hostUrl || 'example.test'}/target${options.query || ''}`, options);
            assert.equal((await send(rejected)).status, 503);
            assert.equal((await send(accepted)).status, 209);
        });
    }

    for (const matcher of [
        { type: 'raw-body', content: 'expected' },
        { type: 'raw-body-includes', content: 'expected' },
        { type: 'raw-body-regexp', regexString: '^expected$', regexFlags: 'i' },
        { type: 'json-body', body: ['expected'] },
        { type: 'json-body-matching', body: { answer: 'expected' } },
        { type: 'form-data', formData: { answer: 'expected' } }
    ]) {
        test(name(`${matcher.type} is enforced`), async t => {
            const server = await proxy(t, apply, [rule({ matchers: [{ type: 'method', method: 1 }, rule().matchers[1], matcher] })]);
            const correct = matcher.type === 'json-body' ? '["expected"]' : matcher.type === 'json-body-matching' ? '{"answer":"expected","extra":true}' : matcher.type === 'form-data' ? 'answer=expected' : 'expected';
            const headers = { 'content-type': matcher.type === 'form-data' ? 'application/x-www-form-urlencoded' : 'application/json' };
            assert.equal((await request(server.port, undefined, { method: 'POST', body: 'wrong', headers })).status, 503);
            assert.equal((await request(server.port, undefined, { method: 'POST', body: correct, headers })).status, 209);
        });
    }

    test(name('protocol constraints are not discarded'), async t => {
        const server = await proxy(t, apply, [rule({ matchers: [...rule().matchers, { type: 'protocol', protocol: 'https' }] })]);
        assert.equal((await request(server.port)).status, 503);
    });

    test(name('scoped passthrough preserves all constraints and binary bodies'), async t => {
        const hits = [];
        const upstream = await origin(t, async (req, res) => {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            res.writeHead(218, { 'x-upstream': 'yes' }); res.end(hits.at(-1).body);
        });
        const target = `http://127.0.0.1:${upstream.address().port}/target?x=1&x=2`;
        const server = await proxy(t, apply, [rule({ matchers: [{ type: 'method', method: 1 }, rule().matchers[1], { type: 'wildcard' }], steps: [{ type: 'passthrough' }] })]);
        assert.equal((await request(server.port, target.replace('/target', '/outside'), { method: 'POST' })).status, 503);
        assert.equal((await request(server.port, target)).status, 503);
        const body = Buffer.from([0, 1, 127, 128, 255]);
        const response = await request(server.port, target, { method: 'POST', body, headers: { 'x-test': 'preserved' } });
        assert.equal(response.status, 218); assert.deepEqual(response.body, body);
        assert.equal(response.headers['x-upstream'], 'yes'); assert.equal(hits.length, 1);
        assert.equal(hits[0].url, '/target?x=1&x=2'); assert.equal(hits[0].headers['x-test'], 'preserved');
    });

    test(name('forwarding options are honored on scoped passthrough'), async t => {
        const upstream = await origin(t, (_req, res) => { res.writeHead(218); res.end('forwarded'); });
        const server = await proxy(t, apply, [rule({ steps: [{ type: 'passthrough', forwarding: { targetHost: `127.0.0.1:${upstream.address().port}` } }] })]);
        const response = await request(server.port);
        assert.equal(response.status, 218); assert.equal(response.body.toString(), 'forwarded');
    });

    test(name('delay runs before the final response'), async t => {
        const server = await proxy(t, apply, [rule({ steps: [{ type: 'delay', delayMs: 50 }, ...rule().steps] })]);
        const start = performance.now(); const response = await request(server.port);
        assert.equal(response.status, 209); assert.ok(performance.now() - start >= 35);
    });

    test(name('close and timeout actions do not turn into successful replies'), async t => {
        const closed = await proxy(t, apply, [rule({ steps: [{ type: 'close-connection' }] })]);
        await assert.rejects(request(closed.port), /socket hang up|ECONNRESET/);
        const held = await proxy(t, apply, [rule({ steps: [{ type: 'timeout' }] })]);
        await assert.rejects(request(held.port, undefined, { timeout: 100 }), /Request timeout/);
    });

    test(name('priority and always completion remain effective on repeated requests'), async t => {
        const server = await proxy(t, apply, [rule({ priority: 1, steps: [{ type: 'simple', status: 210 }] }), rule({ priority: 2 })]);
        for (let i = 0; i < 3; i++) assert.equal((await request(server.port)).status, 209);
    });

    for (const checker of [{ type: 'once' }, { type: 'times', count: 2 }]) {
        test(name(`${checker.type} completion yields to fallback after the limit`), async t => {
            const upstream = await origin(t, (_req, res) => { res.writeHead(218); res.end('upstream'); });
            const target = `http://127.0.0.1:${upstream.address().port}/target`;
            const server = await proxy(t, apply, [rule({ completionChecker: checker }), fallback()]);
            for (let i = 0; i < (checker.count || 1); i++) assert.equal((await request(server.port, target)).status, 209);
            for (let i = 0; i < 2; i++) assert.equal((await request(server.port, target)).status, 218);
        });
    }

    test(name('nested groups preserve displayed order and default rules repeat'), async t => {
        const server = await proxy(t, apply, [{ items: [rule({ completionChecker: undefined })] }, rule({ steps: [{ type: 'simple', status: 210 }] })]);
        for (let i = 0; i < 3; i++) assert.equal((await request(server.port)).status, 209);
    });

    test(name('inactive groups disable their children'), async t => {
        const server = await proxy(t, apply, [{ activated: false, items: [rule()] }]);
        assert.equal((await request(server.port)).status, 503);
    });

    for (const [description, matchers] of [
        ['method-free paths', [rule().matchers[1]]], ['wildcard replies', [{ type: 'wildcard' }]],
        ['regex URLs', [{ type: 'regex-url', regexSource: '^http://example\\.test/target$', regexFlags: '' }]],
        ['regex paths', [{ type: 'regex-path', regexSource: '^/target$', regexFlags: '' }]]
    ]) {
        test(name(`${description} are loaded`), async t => {
            const server = await proxy(t, apply, [rule({ matchers })]);
            assert.equal((await request(server.port)).status, 209);
        });
    }

    test(name('invalid trees and unsupported features fail before registration'), async () => {
        const malformed = [
            [null, rule()], [rule({ id: 'broken', matchers: [{ type: 'regex-path', regexSource: '[' }] })],
            [rule({ id: 'broken', matchers: [{ type: 'callback' }] })],
            [rule({ id: 'broken', steps: [{ type: 'not-a-step' }] })],
            [rule({ id: 'broken', steps: [{ type: 'simple', status: 200, unsupported: true }] })],
            [rule({ id: 'broken', steps: [{ type: 'passthrough', transformRequest: { setMethod: 'POST' } }] })],
            [rule({ id: 'broken', steps: [{ type: 'delay', delayMs: 10 }] })],
            [rule({ id: 'broken', steps: [...rule().steps, { type: 'delay', delayMs: 10 }] })],
            [rule({ id: 'broken', completionChecker: { type: 'unknown' } })]
        ];
        for (const items of malformed) {
            let registered = 0;
            const fake = { async addRequestRules() { registered++; }, async addWebSocketRules() { registered++; } };
            await assert.rejects(apply(fake, { items: [rule(), ...items] }, silent, { addDefaultPassthrough: true }, {}));
            assert.equal(registered, 0);
        }
    });

    test(name('files fail startup when missing, reload, and return 500 if removed'), async t => {
        const directory = await tempDirectory(t); const filePath = path.join(directory, 'response.txt');
        const fileRule = rule({ steps: [{ type: 'file', filePath, status: 209, headers: { 'content-length': '999' } }] });
        const fake = { async addRequestRules() { assert.fail('missing file registered'); } };
        await assert.rejects(apply(fake, { items: [fileRule] }, silent, { addDefaultPassthrough: false }, {}), /Invalid rule.*ENOENT/);
        await fs.writeFile(filePath, 'original');
        const server = await proxy(t, apply, [fileRule]);
        await fs.writeFile(filePath, 'updated content');
        const response = await request(server.port);
        assert.equal(response.body.toString(), 'updated content'); assert.equal(response.headers['content-length'], '15');
        await fs.unlink(filePath); assert.equal((await request(server.port)).status, 500);
    });

    test(name('default certificate imports serve this proxy CA even if the old file exists'), async t => {
        const directory = await tempDirectory(t); const ca = await generateHttpsConfig(path.join(directory, 'config'));
        const wrong = path.join(directory, 'wrong.pem'); await fs.writeFile(wrong, 'old certificate');
        const certificate = rule({ id: 'default-certificate', matchers: [{ type: 'method', method: 0 }, { type: 'simple-path', path: 'amiusing.httptoolkit.tech/certificate' }], steps: [{ type: 'file', status: 200, filePath: wrong }] });
        const server = await proxy(t, apply, [certificate], { https: ca });
        const response = await request(server.port, 'http://amiusing.httptoolkit.tech/certificate');
        assert.equal(new X509Certificate(response.body).fingerprint256, new X509Certificate(ca.cert).fingerprint256);
    });

    test(name('captured response headers work over HTTP/1 and HTTP/2'), async t => {
        const directory = await tempDirectory(t); const ca = await generateHttpsConfig(directory);
        const headers = { connection: 'keep-alive, x-hop', 'transfer-encoding': 'chunked', 'x-hop': 'drop', 'content-length': '999', 'content-type': 'text/plain' };
        const server = await proxy(t, apply, [rule({ steps: [{ type: 'simple', status: 200, data: 'OK', headers }] })], { https: ca });
        const http1 = await request(server.port);
        assert.equal(http1.body.toString(), 'OK'); assert.equal(http1.headers['content-length'], '2'); assert.equal(http1.headers['x-hop'], undefined);
        const client = http2.connect(`https://localhost:${server.port}`, { ca: ca.cert });
        t.after(() => client.destroy());
        const result = await new Promise((resolve, reject) => {
            client.on('error', reject);
            const req = client.request({ ':path': '/target' }); let received;
            req.on('response', headers => received = headers); const chunks = [];
            req.on('data', chunk => chunks.push(chunk)); req.on('error', reject);
            req.setTimeout(3000, () => req.destroy(new Error('HTTP/2 timeout')));
            req.on('end', () => resolve({ headers: received, body: Buffer.concat(chunks).toString() })); req.end();
        });
        assert.equal(result.headers[':status'], 200); assert.equal(result.body, 'OK');
        assert.equal(result.headers['transfer-encoding'], undefined); assert.equal(result.headers.connection, undefined);
        client.destroy();
    });

    test(name('WebSocket passthrough relays messages to the upstream server'), async t => {
        const upstream = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
        await once(upstream, 'listening');
        t.after(async () => { for (const client of upstream.clients) client.terminate(); await new Promise(resolve => upstream.close(resolve)); });
        upstream.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
        const server = await proxy(t, apply, [{ type: 'websocket', activated: true, matchers: [{ type: 'wildcard' }], steps: [{ type: 'ws-passthrough' }] }]);
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/echo`, { headers: { host: `127.0.0.1:${upstream.address().port}` }, handshakeTimeout: 3000 });
        t.after(() => socket.terminate()); await once(socket, 'open');
        const received = once(socket, 'message'); const bytes = Buffer.from([0, 128, 255]); socket.send(bytes);
        assert.deepEqual((await received)[0], bytes);
        socket.close(); await once(socket, 'close');
    });
}
