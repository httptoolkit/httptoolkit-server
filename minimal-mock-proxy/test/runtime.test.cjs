const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { createHash, X509Certificate } = require('node:crypto');
const { getLocal } = require('mockttp');
const { gzipSync } = require('node:zlib');
const { parseArgs, buildLogger, registerLogging, generateHttpsConfig, startBound, startProxy, notifyTelegram, applyHtkRules } = require('../server.ts');
const { tempDirectory, request, secureRequest, proxy, origin, rule, fallback } = require('./helpers.cjs');

test('CLI validates options and defaults to loopback with body previews disabled', () => {
    const defaults = parseArgs(['node', 'server']);
    assert.equal(defaults.host, '127.0.0.1'); assert.equal(defaults.bodyPreview, 0); assert.equal(defaults.maxBodySize, 1024 * 1024);
    assert.equal(parseArgs(['node', 'server', '--port', '0']).port, 0);
    for (const args of [
        ['--port', '80junk'], ['--port', '-1'], ['--port', '65536'], ['--port'],
        ['--body-preview', 'NaN'], ['--body-preview', '-1'], ['--body-preview', '65537'], ['--body-preview', '--add-default-passthrough'],
        ['--max-body-size', '0'], ['--max-body-size', 'Infinity'], ['--host', 'not-an-IP'],
        ['--unknown'], ['--log-level', 'verbose'], ['--telegram-bot-token', 'test-token']
    ]) assert.throws(() => parseArgs(['node', 'server', ...args]));
    const legacy = require('../server.js');
    const flags = legacy.parseArgs(['node', 'server', '--telegram-bot-token', 'test-token', '--telegram-chat-id', 'test-chat']);
    assert.equal(flags.telegramBotToken, 'test-token'); assert.equal(flags.telegramChatId, 'test-chat');
});

test('warn/error logging never subscribes to or decodes response bodies', async () => {
    for (const level of ['warn', 'error']) {
        const callbacks = {};
        const flags = parseArgs(['node', 'server', '--log-level', level]);
        await registerLogging({ on: async (event, callback) => callbacks[event] = callback }, buildLogger(level), flags);
        assert.equal(callbacks.response, undefined); assert.equal(callbacks['request-initiated'], undefined);
    }
});

test('logging bounds raw text previews, avoids decompression and redacts URLs', async () => {
    const lines = []; const callbacks = {};
    const flags = parseArgs(['node', 'server', '--body-preview', '5']);
    const logger = buildLogger('info', { log: line => lines.push(line), warn() {}, error() {} });
    await registerLogging({ on: async (event, callback) => callbacks[event] = callback }, logger, flags);
    callbacks['request-initiated']({ method: 'GET', url: 'http://user:secret@example.test/target?token=secret-value&token=other-value' });
    assert.ok(!lines[0].includes('secret')); assert.ok(!lines[0].includes('other-value')); assert.ok(lines[0].includes('redacted'));
    const body = { buffer: Buffer.from('0123456789'), getText() { assert.fail('must not decode the full body'); } };
    callbacks.response({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body });
    assert.ok(lines.at(-1).includes('"01234"')); assert.ok(!lines.at(-1).includes('012345'));
    for (const headers of [{ 'content-type': 'application/octet-stream' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' }]) {
        callbacks.response({ statusCode: 200, headers, body });
        assert.ok(lines.at(-1).includes('body-bytes=10')); assert.ok(!lines.at(-1).includes('01234'));
    }
});

test('loopback binding rejects non-loopback connections; explicit network binding works', async t => {
    const local = getLocal(); t.after(() => local.stop());
    await local.forAnyRequest().thenReply(200, 'bound'); await startBound(local, 0, '127.0.0.1');
    assert.equal(local.server.address().address, '127.0.0.1'); assert.equal((await request(local.port)).status, 200);
    const lan = Object.values(os.networkInterfaces()).flat().find(value => value && value.family === 'IPv4' && !value.internal);
    if (lan) {
        await assert.rejects(request(local.port, undefined, { host: lan.address }), /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|timeout/);
        const network = getLocal(); t.after(() => network.stop());
        await network.forAnyRequest().thenReply(200, 'bound'); await startBound(network, 0, '0.0.0.0');
        assert.equal(network.server.address().address, '0.0.0.0'); assert.equal((await request(network.port, undefined, { host: lan.address })).status, 200);
    }
    await assert.rejects(startBound({ start() { assert.fail('must fail before starting'); } }, 0, '127.0.0.1'), /cannot enforce/);
});

test('IPv6 loopback binding is supported when available', async t => {
    const server = getLocal(); t.after(() => server.stop());
    await server.forAnyRequest().thenReply(200);
    try { await startBound(server, 0, '::1'); }
    catch (error) { if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) { t.skip(error.code); return; } throw error; }
    assert.equal(server.server.address().address, '::1'); assert.equal((await request(server.port, undefined, { host: '::1' })).status, 200);
});

test('concurrent CA initialization reuses one pair and refuses mismatched existing material', async t => {
    const directory = await tempDirectory(t);
    const [first, second] = await Promise.all([generateHttpsConfig(directory), generateHttpsConfig(directory)]);
    assert.equal(first.cert, second.cert); assert.equal(first.key, second.key);
    await fs.writeFile(first.keyPath, 'invalid key');
    await assert.rejects(generateHttpsConfig(directory));
    assert.equal(await fs.readFile(first.certPath, 'utf8'), first.cert);
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.tmp') || name === 'ca.lock'), false);
});

test('downloaded proxy CA verifies an actual intercepted HTTPS connection', async t => {
    const directory = await tempDirectory(t); const rules = path.join(directory, 'rules.json');
    await fs.writeFile(rules, JSON.stringify({ items: [
        { id: 'cert', type: 'http', activated: true, matchers: [{ type: 'simple-path', path: '/certificate' }], steps: [{ type: 'proxy-certificate', headers: { 'content-type': 'application/x-x509-ca-cert' } }] },
        { type: 'http', activated: true, matchers: [{ type: 'simple-path', path: '/secure' }], steps: [{ type: 'simple', data: 'trusted' }] }
    ] }));
    const flags = parseArgs(['node', 'server', '--rules', rules, '--port', '0', '--log-level', 'error']);
    const running = await startProxy(flags, path.join(directory, 'config')); t.after(() => running.stop());
    const downloaded = await request(running.server.port, 'http://localhost/certificate');
    assert.equal(new X509Certificate(downloaded.body).fingerprint256, new X509Certificate(running.https.cert).fingerprint256);
    await fs.writeFile(running.https.certPath, 'certificate replaced on disk');
    const stillActive = await request(running.server.port, 'http://localhost/certificate');
    assert.deepEqual(stillActive.body, downloaded.body);
    const response = await secureRequest(running.server.port, 'https://localhost/secure', stillActive.body);
    assert.equal(response.status, 200); assert.equal(response.body.toString(), 'trusted');
});

test('HTTPS passthrough validates upstream certificates and preserves binary traffic', async t => {
    const directory = await tempDirectory(t); const ca = await generateHttpsConfig(directory);
    // A second Mockttp server supplies a correctly signed localhost leaf.
    const upstream = getLocal({ https: ca, recordTraffic: false }); t.after(() => upstream.stop());
    const bytes = Buffer.from([0, 128, 255]);
    await upstream.forPost('/echo').thenCallback(req => ({ statusCode: 218, rawBody: req.body.buffer, headers: { 'x-upstream': 'yes' } }));
    await startBound(upstream, 0, '127.0.0.1');
    const server = await proxy(t, applyHtkRules, [{ type: 'http', activated: true, matchers: [{ type: 'wildcard' }], steps: [{ type: 'passthrough', extraCACertificates: [{ cert: ca.cert }] }] }], { https: ca });
    const response = await secureRequest(server.port, `https://localhost:${upstream.port}/echo`, ca.cert, { method: 'POST', body: bytes });
    assert.equal(response.status, 218); assert.deepEqual(response.body, bytes); assert.equal(response.headers['x-upstream'], 'yes');
});

test('bounded capture does not truncate large passthrough responses', async t => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0xa5);
    const upstream = await origin(t, (_req, res) => { res.setHeader('content-type', 'application/octet-stream'); res.end(bytes); });
    const server = await proxy(t, applyHtkRules, [], { flag: true, maxBodySize: 16384 });
    let logged = false;
    await registerLogging(server, buildLogger('info', { log() { logged = true; }, warn() {}, error() {} }), parseArgs(['node', 'server']));
    const response = await request(server.port, `http://127.0.0.1:${upstream.address().port}/large`);
    assert.equal(response.body.length, bytes.length);
    assert.equal(createHash('sha256').update(response.body).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(logged, true);
});

test('oversized bodies never masquerade as empty bodies and remain intact upstream', async t => {
    const upstream = await origin(t, async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.end(Buffer.concat(chunks));
    });
    const empty = priority => rule({ priority, matchers: [{ type: 'method', method: 1 }, { type: 'raw-body', content: '' }] });
    const server = await proxy(t, applyHtkRules, [empty(2), empty(1), fallback()], { maxBodySize: 1024 });
    const target = `http://127.0.0.1:${upstream.address().port}/target`;
    const bytes = Buffer.alloc(8192, 'x');
    for (const headers of [{ 'content-length': String(bytes.length) }, { 'transfer-encoding': 'chunked' }]) {
        const response = await request(server.port, target, { method: 'POST', body: bytes, headers });
        assert.equal(response.status, 200); assert.deepEqual(response.body, bytes);
    }
    const large = Buffer.alloc(2 * 1024 * 1024, 'y');
    const response = await request(server.port, target, { method: 'POST', body: large, headers: { 'content-length': String(large.length) } });
    assert.deepEqual(response.body, large);
    assert.equal((await request(server.port, target, { method: 'POST', body: '' })).status, 209);
});

test('oversized body replay survives delays before a selected passthrough', async t => {
    const upstream = await origin(t, async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.end(Buffer.concat(chunks));
    });
    const limited = rule({ priority: 2, matchers: [{ type: 'raw-body', content: '' }] });
    const delayed = rule({ matchers: [{ type: 'wildcard' }], steps: [{ type: 'delay', delayMs: 50 }, { type: 'passthrough' }] });
    const server = await proxy(t, applyHtkRules, [limited, delayed], { maxBodySize: 1024 });
    const body = Buffer.alloc(32768, 'z');
    const response = await request(server.port, `http://127.0.0.1:${upstream.address().port}/target`, { method: 'POST', body });
    assert.deepEqual(response.body, body);
});

test('an unmatched oversized body drains and leaves its keepalive connection usable', async t => {
    const empty = rule({ matchers: [{ type: 'method', method: 1 }, { type: 'raw-body', content: '' }] });
    const healthy = rule({ matchers: [{ type: 'method', method: 0 }, { type: 'simple-path', path: '/healthy' }] });
    const server = await proxy(t, applyHtkRules, [empty, healthy], { maxBodySize: 1024 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
    const first = await request(server.port, undefined, { method: 'POST', body: Buffer.alloc(32768, 'x'), headers: { 'transfer-encoding': 'chunked' }, agent });
    assert.equal(first.status, 503);
    await new Promise(resolve => setImmediate(resolve));
    const socket = Object.values(agent.freeSockets).flat()[0]; assert.ok(socket);
    const second = await request(server.port, 'http://example.test/healthy', { agent });
    assert.equal(second.status, 209);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(Object.values(agent.freeSockets).flat()[0], socket);
});

test('decoded body matching is bounded and valid compressed matches still work', async t => {
    const upstream = await origin(t, async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        res.end(Buffer.concat(chunks));
    });
    const match = rule({ matchers: [{ type: 'method', method: 1 }, { type: 'raw-body-regexp', regexString: '^x+$' }] });
    const server = await proxy(t, applyHtkRules, [match, fallback()], { maxBodySize: 1024 });
    const target = `http://127.0.0.1:${upstream.address().port}/target`;
    const headers = { 'content-encoding': 'gzip' };
    assert.equal((await request(server.port, target, { method: 'POST', body: gzipSync(Buffer.alloc(32, 'x')), headers })).status, 209);
    const oversized = gzipSync(Buffer.alloc(8192, 'x'));
    const response = await request(server.port, target, { method: 'POST', body: oversized, headers });
    assert.equal(response.status, 200); assert.deepEqual(response.body, oversized);
});

test('Telegram notifications use bounded plain-text requests without exposing tokens in errors', async () => {
    let sent;
    await notifyTelegram({ telegramBotToken: 'test-only', telegramChatId: 'test-only' }, 'error <with> & text', async (url, init) => {
        sent = init; assert.ok(url.endsWith('/sendMessage')); return { ok: true };
    });
    const form = new URLSearchParams(sent.body);
    assert.equal(form.get('text'), 'error <with> & text'); assert.equal(form.has('parse_mode'), false);
    assert.ok(sent.signal instanceof AbortSignal);
});

test('included rules keep their mock bodies and load the certificate and WebSocket defaults', async t => {
    const directory = await tempDirectory(t); const ca = await generateHttpsConfig(directory);
    const rules = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'rules.json'), 'utf8'));
    const stack = [...rules.items]; const staticRules = [];
    while (stack.length) {
        const node = stack.shift(); if (node.items) stack.push(...node.items);
        if (node.type === 'http' && node.steps?.[0]?.type === 'simple' && node.matchers.some(m => m.type === 'simple-path')) staticRules.push(node);
    }
    // Leave passthrough out of this fixture so an unexpected mismatch cannot
    // contact an external host.
    const server = await proxy(t, applyHtkRules, staticRules, { https: ca });
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    for (const item of staticRules) {
        const url = item.matchers.find(m => m.type === 'simple-path').path;
        const method = methods[item.matchers.find(m => m.type === 'method').method];
        const response = await request(server.port, url, { method });
        const expected = item.steps[0].data;
        assert.equal(response.status, item.steps[0].status);
        assert.deepEqual(response.body, typeof expected === 'string' ? Buffer.from(expected) : Buffer.from(expected.data));
    }
    let capturedHttp, capturedWs;
    await applyHtkRules({ async addRequestRules(...items) { capturedHttp = items; }, async addWebSocketRules(...items) { capturedWs = items; } }, rules, { info() {} }, { addDefaultPassthrough: false }, ca);
    assert.equal(capturedWs.length, 1); assert.equal(capturedWs[0].steps[0].type, 'ws-passthrough');
    assert.ok(capturedHttp.some(item => item.id === 'default-certificate'));
});
