const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const tls = require('node:tls');
const http = require('node:http');
const fs = require('node:fs/promises');
const { generateCACertificate } = require('mockttp');
const { applyHtkRules: applyRules } = require('../rules.ts');
const { proxy, rule, origin } = require('./helpers.cjs');

async function relay(t, proxyPort, destinationPort, destinationIp = '198.51.100.42') {
    const python = path.join(__dirname, '..', 'mt5-router', '.venv', 'Scripts', 'python.exe');
    await fs.access(python); // Run mt5-router/build.ps1 to install the isolated test environment.
    const child = spawn(python, [path.join(__dirname, '..', 'mt5-router', 'tests', 'relay_fixture.py'),
        String(proxyPort), destinationIp, String(destinationPort)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill(); await exited;
        }
    });
    let output = '';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Relay startup timeout: ${output}`)), 10000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.stderr.on('data', data => output += data);
        child.stdout.on('data', data => {
            output += data;
            const match = /^(\d+)\r?$/m.exec(output);
            if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited ${code}: ${output}`)); });
    });
}

function request(port, { secure = false, ca, hostname = 'mock.example.test', route = '/target', payload = '' } = {}) {
    return new Promise((resolve, reject) => {
        const socket = secure ? tls.connect({ host: '127.0.0.1', port, servername: hostname, ca, rejectUnauthorized: true }) : undefined;
        socket?.on('error', reject);
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
            headers: { host: hostname, 'content-length': Buffer.byteLength(payload) },
            ...(secure ? { createConnection: () => socket, agent: undefined } : { agent: false }) }, async res => {
            try {
                const chunks = []; for await (const c of res) chunks.push(c);
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
            } catch (e) { reject(e); }
            finally { socket?.destroy(); }
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Relay request timeout')));
        req.end(payload);
    });
}

test('MT5 relay preserves HTTP hostname matching through an IP CONNECT tunnel', { timeout: 20000 }, async t => {
    const p = await proxy(t, applyRules, [rule({ matchers: [{ type: 'simple-path', path: 'http://mock.example.test/target' }] })]);
    const port = await relay(t, p.port, 80);
    assert.deepEqual(await request(port), { status: 209, body: 'mocked' });
});

test('MT5 relay preserves HTTPS SNI, trusted CA and request body through an IP CONNECT tunnel', { timeout: 20000 }, async t => {
    const ca = await generateCACertificate({ commonName: 'MT5 Relay Test CA' });
    const body = 'hello through the HTTPS relay';
    const p = await proxy(t, applyRules, [rule({ matchers: [
        { type: 'simple-path', path: 'https://mock.example.test/target' }, { type: 'raw-body', content: body }
    ] })], { https: ca });
    const port = await relay(t, p.port, 443);
    assert.deepEqual(await request(port, { secure: true, ca: ca.cert, payload: body }), { status: 209, body: 'mocked' });
});

test('MT5 relay rejects unexpected non-web streams instead of opening new direct connections', { timeout: 20000 }, async t => {
    const upstream = await origin(t, (_req, res) => { res.end('direct broker-like connection'); });
    const p = await proxy(t, applyRules, [rule({ matchers: [{ type: 'wildcard' }], steps: [{ type: 'simple', data: 'wrong proxy route' }] })]);
    const port = await relay(t, p.port, upstream.address().port, '127.0.0.1');
    await assert.rejects(request(port), /socket hang up|ECONNRESET/);
});

test('MT5 relay supports HTTPS passthrough with upstream CA validation', { timeout: 20000 }, async t => {
    const ca = await generateCACertificate();
    const upstream = await proxy(t, applyRules, [rule({ matchers: [{ type: 'wildcard' }], steps: [{ type: 'simple', data: 'HTTPS upstream response' }] })], { https: ca });
    const p = await proxy(t, applyRules, [rule({ matchers: [{ type: 'wildcard' }], steps: [{
        type: 'passthrough', extraCACertificates: [{ cert: ca.cert }],
        forwarding: { targetHost: `localhost:${upstream.port}`, updateHostHeader: true }
    }] })], { https: ca });
    const port = await relay(t, p.port, 443);
    assert.deepEqual(await request(port, { secure: true, ca: ca.cert }), { status: 200, body: 'HTTPS upstream response' });
});
