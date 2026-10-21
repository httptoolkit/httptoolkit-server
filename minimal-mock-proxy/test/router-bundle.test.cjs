const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('portable MT5 Router validates its backend outside the repo without Python on PATH', { timeout: 30000 }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mt5-router-bundle-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('mt5-router-bundle-test-'));
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const portable = path.join(directory, 'portable app');
    await fs.cp(path.join(__dirname, '..', 'dist', 'mt5-router', 'MT5Router'), portable, { recursive: true });
    const executable = path.join(portable, 'MT5Router.exe');
    const report = path.join(directory, 'report with spaces.json');
    const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32'), PYTHONPATH: '', PYTHONHOME: '' };
    const run = args => spawn(executable, args, { env, cwd: directory, windowsHide: true, stdio: 'ignore' });
    const child = run(['--check', '--report', report]);
    assert.equal((await once(child, 'close'))[0], 0);
    const result = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.equal(result.backend_version, '0.12.11');
    assert.equal(result.proxy, '127.0.0.1:8888');
    assert.equal(result.driver_started, false);
    assert.deepEqual(result.ports, [80, 443]);
    assert.equal(result.policy_version, 1);
    assert.equal(result.capture_supported, result.native_architecture === 'x64');
    assert.ok(result.backend.startsWith(portable));
    for (const script of ['Install-Startup.ps1', 'Start-Proxy.ps1']) {
        await fs.access(path.join(portable, script));
    }
    for (const name of ['windows-redirector.exe', 'WinDivert.dll', 'WinDivert64.sys']) {
        await fs.access(path.join(path.dirname(result.backend), name));
    }
    const ui = run(['--check-ui', '--start', '--wait-proxy-until-ready', '--report', report]);
    assert.equal((await once(ui, 'close'))[0], 0);
    assert.deepEqual(JSON.parse(await fs.readFile(report, 'utf8')), { gui_started: true, driver_started: false });
    if (!result.capture_supported) {
        const unsupported = run(['--headless', '--report', report]);
        assert.equal((await once(unsupported, 'close'))[0], 1);
        assert.match(JSON.parse(await fs.readFile(report, 'utf8')).error, /requires Intel\/AMD x64 Windows/);
    }
    const invalid = run(['--check', '--proxy-host', '0.0.0.0', '--report', report]);
    assert.equal((await once(invalid, 'close'))[0], 1);
    assert.match(JSON.parse(await fs.readFile(report, 'utf8')).error, /loopback/);
});
