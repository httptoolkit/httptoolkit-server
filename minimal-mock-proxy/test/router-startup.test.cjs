const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const execute = promisify(execFile);
const scripts = path.join(__dirname, '..', 'mt5-router');

async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mt5-router-startup-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('mt5-router-startup-test-'));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const spaced = path.join(root, 'portable app with spaces');
    await fs.mkdir(spaced);
    return spaced;
}
function powershell(script, args, env) {
    return execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(scripts, script), ...args], { windowsHide: true, env, timeout: 20000 });
}

test('login startup plan preserves account, elevation, quoted paths and port without registering tasks', { timeout: 30000 }, async t => {
    const root = await directory(t);
    const proxy = path.join(root, 'proxy server.js');
    const rules = path.join(root, 'proxy rules.json');
    const router = path.join(root, 'MT5Router.exe');
    await Promise.all([fs.writeFile(proxy, ''), fs.writeFile(rules, '{}'), fs.writeFile(router, '')]);
    const env = { ...process.env, LOCALAPPDATA: root };
    const { stdout } = await powershell('Install-Startup.ps1', ['-ProxyScript', proxy, '-Rules', rules,
        '-RouterExe', router, '-NodeExe', process.execPath, '-Plan'], env);
    const plan = JSON.parse(stdout);
    assert.equal(plan.trigger, 'AtLogOn');
    assert.equal(plan.proxyPort, 8002);
    assert.equal(plan.tasks.length, 2);
    const [p, r] = plan.tasks;
    assert.equal(p.runLevel, 'Limited');
    assert.equal(r.runLevel, 'Highest');
    assert.equal(p.logonType, 3); // TASK_LOGON_INTERACTIVE_TOKEN
    assert.equal(r.logonType, 3);
    assert.equal(p.principalSid, r.principalSid);
    assert.equal(p.delay, 'PT5S');
    assert.equal(r.delay, 'PT10S');
    assert.equal(plan.settings.executionTimeLimit, 'PT0S');
    assert.equal(plan.settings.multipleInstances, 2); // IgnoreNew
    assert.equal(plan.settings.restartCount, 3);
    assert.equal(p.workingDirectory, root);
    assert.equal(r.executable, router);
    assert.match(r.arguments, /--start --wait-proxy-until-ready/);
    assert.match(r.arguments, /--proxy-port 8002/);
    assert.match(r.arguments, /--log-file ".*portable app with spaces.*router\.log"/);
    assert.match(p.arguments, /-WindowStyle Hidden/);
    assert.ok(p.arguments.includes(`"${plan.configuration}"`));
    await assert.rejects(fs.access(plan.logDirectory));
    const removal = JSON.parse((await powershell('Install-Startup.ps1', ['-Remove', '-Plan'], env)).stdout);
    assert.equal(removal.operation, 'Remove');
    assert.equal(removal.stopsRunningApplications, false);
});

test('proxy startup runner handles spaced paths, drains both streams, rotates logs and preserves exit status', { timeout: 30000 }, async t => {
    const root = await directory(t);
    const proxy = path.join(root, 'proxy server.js');
    const rules = path.join(root, 'proxy rules.json');
    const config = path.join(root, 'startup config.json');
    const log = path.join(root, 'proxy.log');
    await fs.writeFile(proxy, `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
console.error('startup stderr captured'); process.exitCode = 7;`);
    await fs.writeFile(rules, '{}');
    await fs.writeFile(log, 'x'.repeat(2 * 1024 * 1024 + 1));
    await fs.writeFile(`${log}.1`, 'older');
    await fs.writeFile(`${log}.2`, 'older2');
    await fs.writeFile(`${log}.3`, 'oldest');
    await fs.writeFile(config, JSON.stringify({ node: process.execPath, script: proxy, rules, port: 8002,
        workingDirectory: root, log }));
    await assert.rejects(powershell('Start-Proxy.ps1', ['-StartupConfigPath', config], process.env), error => error.code === 7);
    const contents = await fs.readFile(log, 'utf8');
    assert.match(contents, /startup stderr captured/);
    assert.match(contents, /Proxy exited with code 7/);
    const entry = contents.split(/\r?\n/).find(line => line.includes('"args"'));
    const result = JSON.parse(entry.slice(entry.indexOf('{')));
    assert.equal(result.cwd, root);
    assert.deepEqual(result.args, ['--host', '127.0.0.1', '--port', '8002', '--rules', rules,
        '--add-default-passthrough', '--log-level', 'info']);
    assert.equal(await fs.readFile(`${log}.2`, 'utf8'), 'older');
    assert.equal(await fs.readFile(`${log}.3`, 'utf8'), 'older2');
    assert.equal((await fs.stat(`${log}.1`)).size, 2 * 1024 * 1024 + 1);
});

test('proxy log bursts drain promptly and preserve every line from both streams', { timeout: 30000 }, async t => {
    const root = await directory(t);
    const proxy = path.join(root, 'burst.js');
    const marker = path.join(root, 'printed.json');
    const config = path.join(root, 'config.json');
    const log = path.join(root, 'proxy.log');
    const rules = path.join(root, 'rules.json');
    await fs.writeFile(rules, '{}');
    await fs.writeFile(proxy, `for (let i = 0; i < 1000; i++) {
        console.log('stdout-' + i); console.error('stderr-' + i);
    }
    require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(Date.now()));`);
    await fs.writeFile(config, JSON.stringify({ node: process.execPath, script: proxy, rules, port: 8002,
        workingDirectory: root, log }));
    await powershell('Start-Proxy.ps1', ['-StartupConfigPath', config], process.env);
    const finished = Date.now();
    const printed = JSON.parse(await fs.readFile(marker, 'utf8'));
    assert.ok(finished - printed < 5000, `Output drain took ${finished - printed}ms after printing`);
    const contents = await fs.readFile(log, 'utf8');
    assert.equal((contents.match(/ stdout-\d+\r?$/gm) || []).length, 1000);
    assert.equal((contents.match(/ ERROR stderr-\d+\r?$/gm) || []).length, 1000);
});

test('hard termination of the proxy launcher terminates its owned Node process', { timeout: 30000 }, async t => {
    const root = await directory(t);
    const proxy = path.join(root, 'server.js');
    const marker = path.join(root, 'pid.json');
    const rules = path.join(root, 'rules.json');
    const config = path.join(root, 'config.json');
    await fs.writeFile(rules, '{}');
    await fs.writeFile(proxy, `const server = require('net').createServer();
        server.listen(0, '127.0.0.1', () => require('fs').writeFileSync(${JSON.stringify(marker)},
            JSON.stringify({ pid: process.pid, port: server.address().port })));`);
    await fs.writeFile(config, JSON.stringify({ node: process.execPath, script: proxy, rules, port: 8002,
        workingDirectory: root, log: path.join(root, 'proxy.log') }));
    const harness = path.join(root, 'terminate.ps1');
    await fs.writeFile(harness, `param($Runner, $Config, $Marker)
$ErrorActionPreference = 'Stop'
$owner = $null; $owned = $null
try {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Runner + '" -StartupConfigPath "' + $Config + '"'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $owner = [Diagnostics.Process]::Start($info)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $Marker)) {
        if ($owner.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Child did not start' }
        Start-Sleep -Milliseconds 25
    }
    $data = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
    $owned = [Diagnostics.Process]::GetProcessById($data.pid)
    $null = $owned.Handle # Pin the owned process before termination; no PID reuse risk.
    $socket = [Net.Sockets.TcpClient]::new()
    try { $socket.Connect('127.0.0.1', [int]$data.port) } finally { $socket.Dispose() }
    $owner.Kill(); $owner.WaitForExit()
    if (-not $owned.WaitForExit(5000)) { throw 'Owned Node survived launcher termination' }
} finally {
    if ($null -ne $owner) {
        if (-not $owner.HasExited) { $owner.Kill(); $owner.WaitForExit() }
        $owner.Dispose()
    }
    if ($null -ne $owned) {
        if (-not $owned.HasExited) { $owned.Kill(); $owned.WaitForExit() }
        $owned.Dispose()
    }
}
`);
    await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness,
        '-Runner', path.join(scripts, 'Start-Proxy.ps1'), '-Config', config, '-Marker', marker],
        { windowsHide: true, timeout: 20000 });
});

test('installer rollback attempts all cleanup and preserves the original registration error', { timeout: 30000 }, async t => {
    const root = await directory(t);
    const harness = path.join(root, 'rollback.ps1');
    // Extract executable AST nodes: exercise the real rollback without running
    // the installer's administrator gate or changing any scheduled tasks.
    await fs.writeFile(harness, `param($Installer, $Config)
$ErrorActionPreference = 'Stop'
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$null, [ref]$null)
$write = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-StartupConfig'}, $true)
. ([scriptblock]::Create($write.Extent.Text))
$rollback = $ast.Find({param($n) $n -is [Management.Automation.Language.CatchClauseAst] -and $n.Body.Extent.Text.Contains('$failure = $_')}, $true)
$action = [scriptblock]::Create('try { throw "Original registration error" } catch ' + $rollback.Body.Extent.Text)
$registered = @('old-task', 'new-task')
$existing = @{ 'old-task' = 'old XML' }
$startupConfigPath = $Config
$script:calls = [Collections.Generic.List[string]]::new()
function Register-ScheduledTask { param($TaskName, $TaskPath, $Xml, [switch]$Force)
    $script:calls.Add('restore:' + $TaskName); throw 'Scheduler unavailable during restore'
}
function Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm)
    $script:calls.Add('remove:' + $TaskName); throw 'Scheduler unavailable during removal'
}
foreach ($scenario in @('existing', 'new', 'config-failure')) {
    $script:calls.Clear()
    [IO.File]::WriteAllText($Config, 'NEW CONFIG')
    $previousConfig = if ($scenario -eq 'new') { $null } else { 'OLD CONFIG' }
    if ($scenario -eq 'config-failure') { function Write-StartupConfig { throw 'Config restore unavailable' } }
    $observed = ''
    try { & $action } catch { $observed = $_.Exception.Message }
    if ($observed -ne 'Original registration error') { throw "Original error was hidden: $observed" }
    if (($script:calls -join ',') -ne 'restore:old-task,remove:new-task') { throw 'Cleanup stopped early' }
    if ($scenario -eq 'existing' -and [IO.File]::ReadAllText($Config) -ne 'OLD CONFIG') { throw 'Config was not restored' }
    if ($scenario -eq 'new' -and (Test-Path -LiteralPath $Config)) { throw 'Created config was not removed' }
}
`);
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness,
        '-Installer', path.join(scripts, 'Install-Startup.ps1'), '-Config', path.join(root, 'startup.json')],
        { windowsHide: true, timeout: 20000 });
    assert.match(stdout, /Rollback failed for task old-task/);
    assert.match(stdout, /Rollback failed for task new-task/);
    assert.match(stdout, /Rollback failed for startup configuration/);
});
