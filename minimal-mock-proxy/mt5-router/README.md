# MT5 Router (Windows x64)

A small portable Start/Stop app that sends MetaTrader 5's TCP connections on
ports **80 and 443** to **minimal-mock-proxy**, default `127.0.0.1:8888`.
It uses mitmproxy's maintained Rust local-capture backend and its signed
WinDivert driver. No full mitmproxy installation, Python installation on the
destination PC, Windows proxy setting changes, or MT5 code changes are needed.

**Requires Intel/AMD x64 Windows. The bundled x64 driver cannot run on Windows
ARM64, including under x64 emulation.** The app checks the native kernel
architecture before requesting administrator elevation.

## Run

1. From the minimal-mock-proxy project directory, build with `npm run build`, then
   start with `npm start -- --rules rules.json --port 8888 --add-default-passthrough`.
2. Disable the Proxifier rule for MT5. Do not route the same application through
   both tools. This app does not stop or reconfigure Proxifier.
3. Close MT5, open `dist/mt5-router/MT5Router/MT5Router.exe`, leave
   `terminal64.exe` and `127.0.0.1:8888` selected, and click **Start**.
4. Accept Windows' administrator prompt for the bundled redirector, wait for
   **Running - TCP 80 / 443**, then start MT5. The native helper acknowledges
   readiness only after its filter and process selection are initialized.
   The log shows each matching PID and each connection routed to the proxy.
5. Click **Stop** before closing/restarting the proxy or switching back to
   Proxifier. Reconnect/restart MT5 after switching interception tools.

Copy/extract the **entire MT5Router folder**, including `_internal`, when moving
the app. The EXE alone is not sufficient. The build output is ignored by Git.
The app matches executable names exactly, ignoring case; all matching running
MT5 instances are included. Other executable names (including tester agents)
are excluded. For each initial TCP SYN, the native helper queries the current
Windows connection owner, including future process instances and reused local
ports. There is no PID discovery polling interval or socket-event ordering dependency.

Validated GUI settings are saved to `%LOCALAPPDATA%/MT5Router/settings.json`.
Command-line values override saved GUI settings. Diagnostic and headless commands
use their own defaults; temporary PIDs are never persisted. Logs are bounded,
and lifecycle events take priority so log bursts cannot starve Stop or failures.

## Start automatically when you log in

The portable folder includes `Install-Startup.ps1` and `Start-Proxy.ps1`.
Keep this folder and the proxy/rules files in their permanent locations first.
Open **PowerShell as administrator using the same Windows account as MT5**, then
run this example (adjust the paths to your installation):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\MT5Proxy\MT5Router\Install-Startup.ps1" -ProxyScript "C:\MT5Proxy\server.js" -Rules "C:\MT5Proxy\rules.json" -ProxyPort 8002
```

At your next login, Task Scheduler starts the proxy in the background, then opens
MT5Router with administrator privileges and starts capture automatically. The
router waits until the proxy accepts HTTP CONNECT, including later scheduled
retries. Its window stays visible while waiting; **Stop** cancels the wait.
Readiness checks use a loopback CONNECT without sending application data or
contacting an external server. No password is stored by
these scripts, and setup does not launch another copy immediately. Both programs
use your existing Windows profile and CA certificate. MT5Router still loads your
saved process name and Direct IPs; the scheduled proxy port overrides its saved port.
Startup runs **at login**, including after a reboot when you log in. It does not
run before login. Disconnecting an RDP session is different from signing out.

By default the proxy's working directory is the folder containing the rules JSON.
If response-file paths are relative to a different folder, add
`-WorkingDirectory "C:\path\to\that\folder"`. Use `-NodeExe` to select a particular
Node installation. Run the installer again after moving files or changing ports.

Add `-Plan` to preview the task definitions without installing anything. The
tasks have user-specific names beginning with `MT5Router-` in Task Scheduler.
The router task uses **Run with highest privileges** and keeps its window visible;
the proxy uses ordinary user privileges. Duplicate task instances are ignored,
and there is no default three-day execution limit. Task Scheduler retries failed
processes up to three times, one minute apart. A capture error inside the open
router window remains visible for manual recovery.

Stop existing manual instances before testing the tasks through Task Scheduler's
**Run** command. Start the proxy task, then the router task, and open MT5 after
capture is ready. An already running MT5 connection is not migrated into capture.
Logs are in `%LOCALAPPDATA%\MT5Router\startup\proxy.log` and `router.log`; each
rotates at approximately 2 MiB with three backups.
Ending the proxy launcher also terminates the Node process it started, including
when the launcher is forcibly terminated. Log output is drained in bounded batches.

To disable login startup, use the same administrator PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\MT5Proxy\MT5Router\Install-Startup.ps1" -Remove
```

Removing startup leaves currently running applications running. Stop capture in
the router before ending the proxy task. Your saved settings, CA and logs remain.
For manual automatic capture without a scheduled task, launch
`MT5Router.exe --start --wait-proxy-until-ready --proxy-port 8002`.
Use `--wait-proxy 120` instead for a two-minute limit. Existing scheduled tasks
must be updated by rerunning the installer after replacing the portable folder.

## HTTPS and broker connections

The relay tunnels the original bytes through HTTP CONNECT for both ports.
It does not decrypt TLS, install certificates, or disable certificate checks.
MT5 must continue to trust the CA used by minimal-mock-proxy, just as when using
Proxifier. MQL5's WebRequest URL allowlist still applies. Certificate-pinned
clients retain their normal rejection behavior.

Routing is based on destination port, not application protocol. **A broker
connection using port 443 will also be sent to the mock proxy.** Add the broker's
destination IP(s) to **Direct IPs**, separated by commas, to keep those connections
direct. These exclusions run before relay interception, for IPv4 and IPv6.
IPv4-mapped IPv6 entries such as `::ffff:203.0.113.20` also exclude the equivalent
IPv4 address.
This excludes all connections to those IPs, including HTTP/HTTPS. If
brokers use changing/shared IP addresses, narrow routing requires a more specific
policy; validate with a demo terminal before using this with live trading.

## Scope and limitations

- Only new connections are supported. Existing connections are whitelisted at
  startup. Restart MT5 after starting capture if those need interception.
- Only outbound TCP 80/443 can enter the relay. Other TCP ports, UDP, and direct
  IPs stay on their original OS network path. Stopping capture does not close
  those connections. The helper queries Windows TCP ownership and reinjects
  unselected web packets without creating relay sockets.
- Backend capture excludes loopback and multicast. MT5 connections to localhost
  bypass interception. The loopback connection from this app to the proxy is
  intentional and prevents capture loops.
- Supports the backend's IPv4/IPv6 TCP capture. HTTP/3/QUIC (UDP) is direct and
  is not intercepted as HTTP. MT5 is used here as a network client; inbound
  servers hosted by the selected process are outside this app's scope.
- Proxy failure closes affected web connections; it never silently retries them
  directly. Other connections keep their direct route.
- Stopping capture closes relayed web connections. It cannot migrate an established
  TCP connection back into MT5. Reconnect after stopping or restarting.
- It is a foreground app, without a service, autostart, persistent firewall rule,
  or permanent proxy configuration. Windows may register the WinDivert driver
  service when capture starts; its handles are released when the backend exits.
- Logs contain PIDs and destination IPs/ports, not request bodies or credentials.
- A named mutex prevents concurrent capture sessions. Change rules by stopping
  and restarting capture. Stop is safe while administrator startup is pending.
  Stop waits for the native helper to exit before releasing that mutex. If shutdown
  takes longer than five seconds, the app logs the delay and continues waiting.
- Idle live connections keep their routing decision. Connections absent from
  Windows' TCP table are retired after a grace period; unresolved packets have
  per-connection, total-memory and age limits.

## Build and test

Requires Python 3.12+ x64, Node 20+, root npm dependencies, MSVC Build Tools 2022
with C++/Windows SDK, and Rust toolchain `1.95.0-x86_64-pc-windows-msvc`
**only on the build PC**:

```powershell
cd mt5-router
.\build.ps1
```

Build dependencies are isolated in `.venv`. Source CLI equivalents:

```powershell
.venv\Scripts\python.exe app.py
.venv\Scripts\python.exe app.py --headless --process terminal64.exe --proxy-port 8888
.venv\Scripts\python.exe app.py --headless --pid 1234 --direct-ip 203.0.113.20
.venv\Scripts\python.exe app.py --check
.venv\Scripts\python.exe -m unittest discover -s tests -v
```

`--check` validates packaging/process discovery without elevation or loading a
driver. For the windowed portable EXE, use `--check --report C:\temp\router-check.json`.
It also reports `native_architecture` and `capture_supported`. A false support
result means the driver cannot run on that PC.
CLI `--pid` selects one process instead of matching an executable name.
Proxy addresses must be loopback IP literals (IPv4 or IPv6). Proxy authentication
is unnecessary for minimal-mock-proxy and is not supported by this app.

From the minimal-mock-proxy root, verify the relay and portable app:

```powershell
node --import tsx --test test/router.test.cjs test/router-bundle.test.cjs test/router-startup.test.cjs
```

For the optional real-driver test, which triggers Windows elevation and selects
only a temporary test client, use:

```powershell
$env:MT5_ROUTER_NATIVE='1'
node --import tsx --test test/router-native.test.cjs
Remove-Item Env:MT5_ROUTER_NATIVE
```

The native test uses a real-PID handshake and waits for acknowledged readiness.
It also checks that an unrelated child process, an excluded IP, another TCP port
and UDP never reach the relay. These negative controls use documentation IPs;
they verify the absence of relay callbacks, without requiring an external server.
The real WinDivert filter is separately evaluated against synthetic packets
without loading the driver.
It skips on ARM64 with an explicit architecture reason. Native MT5 capture and
broker behavior still need validation on supported x64 Windows; they cannot be
proven by relay, filter-compilation, GUI or packaging checks on ARM64.
`--check-ui --report <path>` verifies the hidden window without capture.

The build verifies a pinned upstream source archive, applies the restricted
native policy, and runs its Rust tests. See `native/README.md` for build details.
The modified helper source and exact upstream archive are included in the
portable app's `licenses/native-source.zip`. The signed driver is unchanged.

Backend documentation and source:
https://www.mitmproxy.org/posts/local-capture/windows/
https://github.com/mitmproxy/mitmproxy_rs
See `THIRD-PARTY-NOTICES.txt` for component licenses.
