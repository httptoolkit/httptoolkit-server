const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { generateCACertificate } = require('mockttp');
const { applyHtkRules } = require('../rules.ts');
const { proxy, rule, tempDirectory } = require('./helpers.cjs');

test('Windows driver captures only the isolated test client and relays HTTP and HTTPS', {
    skip: process.env.MT5_ROUTER_NATIVE !== '1' ? 'Opt in with MT5_ROUTER_NATIVE=1; displays Windows UAC' : false,
    timeout: 120000
}, async t => {
    const ca = await generateCACertificate({ commonName: 'MT5 Native Relay Test CA' });
    const p = await proxy(t, applyHtkRules, [rule({ matchers: [{ type: 'simple-path', path: '/target' }] })], { https: ca });
    const directory = await tempDirectory(t);
    const caPath = path.join(directory, 'test-ca.pem');
    await fs.writeFile(caPath, ca.cert);
    const child = spawn(path.join(__dirname, '..', 'mt5-router', '.venv', 'Scripts', 'python.exe'),
        [path.join(__dirname, '..', 'mt5-router', 'tests', 'native_smoke.py'), String(p.port), caPath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill(); await exited;
        }
    });
    const [code] = await once(child, 'exit');
    if (code === 78 && output.includes('NATIVE_UNSUPPORTED:')) {
        t.skip(output.trim());
        return;
    }
    assert.equal(code, 0, output);
    assert.match(output, /"port": 80, "mocked": true/);
    assert.match(output, /"port": 443, "mocked": true/);
    for (const field of ['excluded_ip', 'other_tcp_port', 'udp', 'unrelated_process']) {
        assert.match(output, new RegExp(`"${field}": true`));
    }
    assert.match(output, /"negative_callbacks": 0/);
});
