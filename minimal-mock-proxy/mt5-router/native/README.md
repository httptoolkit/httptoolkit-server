# Restricted Windows redirector

This is a small LGPL-3.0-or-later modification of mitmproxy's Windows redirector
at commit `40f1dfb5dca7b03ff7793d3c90f23b8bdf873889` (0.12.11).
The signed WinDivert driver is unchanged.

`build_native.py` verifies the upstream source archive's SHA256, replaces its
redirector entry point with `redirector.rs`, and adds `policy.rs` and
`connections.rs`. Upstream Cargo.lock dependency versions are
retained; Cargo builds and tests with `--locked`. Source, the patching script and
this README are included in the portable app's `licenses/native-source.zip`.
The archive hash is
`81882c66e31451f7d5e1a06c88d5c1940aa35739b9cc9d7a9d8950c0ca1137da`.

Build requirements: Rust toolchain `1.95.0-x86_64-pc-windows-msvc`, MSVC Build
Tools 2022 with the C++ and Windows SDK components, and Python build dependencies
from `../requirements-build.txt`. No driver is loaded by the native unit tests.

From mt5-router, run `.venv\Scripts\python.exe native\build_native.py`.
For a local toolchain, the script also recognizes `build/cargo` and `build/rustup`.
From an unpacked `native-source.zip`, install the Python requirements from the
main repository and run `python build_native.py` in the unpacked directory.
The adjacent upstream archive is reused without downloading it again.

The helper receives one immutable hex-encoded JSON policy over the existing
mitmproxy IPC before opening capture handles. Every initial TCP SYN is classified
using its current Windows TCP-table owner, rather than cached socket notifications.
Executable basenames match exactly ignoring case. A driver-level filter restricts
diversion to outbound non-loopback TCP ports 80/443 and omits direct IPs.
UDP and other TCP ports do not enter the userspace TCP stack.

Existing connections are whitelisted at startup. A parent-owned Windows event
acknowledges that capture and classification are initialized. Empty subsequent
configuration disables interception for shutdown; changes require a new session.
Live connections have no idle expiry. Cleanup reconciles against Windows' TCP
table every 15 seconds and retains absent connections for a 60-second grace period.
Unresolved ownership is retried for two seconds, bounded to 256 pending flows,
64 packets per flow and 4 MiB total. Unresolved packets are dropped on expiry or
overflow; they never fall back to a new direct connection. Capture and IPC packet
queues are also bounded.

Before connecting to IPC, the helper publishes its PID to a parent-owned named
mapping. The parent opens a synchronization handle and waits for actual process
exit as well as backend shutdown before releasing the capture mutex. If Stop
precedes the helper's pipe connection, the parent wakes the pending IPC accept
with a connect-and-close. A five-second delay logs a warning and keeps monitoring.

Only the user-mode helper changes. Building an ARM64 helper cannot make an x64
kernel driver load on Windows ARM64. Runtime checks reject that combination.
