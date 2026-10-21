const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { tempDirectory, request, secureRequest, origin } = require('./helpers.cjs');

test('standalone bundle runs without node_modules and preserves forwarding and HTTPS trust', { timeout: 30000 }, async t => {
    const directory = await tempDirectory(t);
    const upstream = await origin(t, (_req, res) => { res.writeHead(218); res.end('upstream'); });
    const executable = path.join(directory, 'server.js');
    await fs.copyFile(path.join(__dirname, '..', 'dist', 'standalone', 'server.js'), executable);
    await fs.writeFile(path.join(directory, 'rules.json'), JSON.stringify({ items: [
        { type: 'http', matchers: [{ type: 'simple-path', path: '/mock' }], steps: [{ type: 'simple', data: 'mocked' }] },
        { type: 'http', matchers: [{ type: 'simple-path', path: '/certificate' }], steps: [{ type: 'proxy-certificate' }] }
    ] }));
    const child = spawn(process.execPath, [executable, '--rules', 'rules.json', '--port', '0', '--add-default-passthrough'], {
        cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory }
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
    let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Bundle startup timed out: ${output}`)), 20000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Bundle exited ${code}: ${output}`)); });
        child.stdout.on('data', () => {
            const match = /Mock proxy listening on 127\.0\.0\.1:(\d+)/.exec(output);
            if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
        });
    });
    assert.ok(port > 0);
    const target = `http://127.0.0.1:${upstream.address().port}`;
    assert.equal((await request(port, `${target}/outside`)).status, 218);
    const mocked = await request(port, `${target}/mock`); assert.equal(mocked.status, 200); assert.equal(mocked.body.toString(), 'mocked');
    const cert = (await request(port, 'http://localhost/certificate')).body;
    assert.equal((await secureRequest(port, 'https://localhost/mock', cert)).body.toString(), 'mocked');
    assert.ok(!output.includes('MODULE_NOT_FOUND'));
    const exited = once(child, 'exit'); child.kill(); await exited;
});
