"""Build restricted routing modules against hash-verified mitmproxy 0.12.11 source.

Requires Rust 1.95+ and MSVC Build Tools. Downloads are confined to build/.
No driver is installed or loaded by this build.
"""
from pathlib import Path
import hashlib
import os
import shutil
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
BUILD = HERE.parent / "build"
COMMIT = "40f1dfb5dca7b03ff7793d3c90f23b8bdf873889"
SHA256 = "81882c66e31451f7d5e1a06c88d5c1940aa35739b9cc9d7a9d8950c0ca1137da"
TARGET = "x86_64-pc-windows-msvc"


def build():
    import mitmproxy_windows
    BUILD.mkdir(exist_ok=True)
    archive = BUILD / "mitmproxy-rs-0.12.11.tar.gz"
    if not archive.exists() and (HERE / archive.name).is_file():
        shutil.copy2(HERE / archive.name, archive)
    if not archive.exists():
        urllib.request.urlretrieve(f"https://codeload.github.com/mitmproxy/mitmproxy_rs/tar.gz/{COMMIT}", archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError("Upstream source SHA256 mismatch")
    source = BUILD / "native" / f"mitmproxy_rs-{COMMIT}"
    patched = {"Cargo.lock", "mitmproxy-windows/redirector/src/main2.rs",
               "mitmproxy-windows/redirector/Cargo.toml", "mitmproxy-windows/redirector/build.rs"}
    originals = {}
    # Preserve unchanged file timestamps so Cargo can reuse verified dependencies.
    # tar's data filter rejects escaping links and paths.
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            relative = member.name.split("/", 1)[1] if "/" in member.name else ""
            if relative in patched:
                originals[relative] = tar.extractfile(member).read().decode()
                continue
            target = BUILD / "native" / member.name
            if member.isfile() and target.is_file() and target.read_bytes() == tar.extractfile(member).read():
                continue
            tar.extract(member, BUILD / "native", filter="data")
    def write_changed(path, content):
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            path.write_text(content, encoding="utf-8")
    crate = source / "mitmproxy-windows" / "redirector"
    main = crate / "src" / "main2.rs"
    write_changed(main, (HERE / 'redirector.rs').read_text(encoding='utf-8'))
    write_changed(crate / 'src' / 'connections.rs', (HERE / 'connections.rs').read_text(encoding='utf-8'))
    write_changed(crate / "src" / "policy.rs", (HERE / "policy.rs").read_text())
    manifest = crate / "Cargo.toml"
    write_changed(manifest, originals['mitmproxy-windows/redirector/Cargo.toml'].replace('prost = "0.14.3"', '''prost = "0.14.3"
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.150"
windows = { version = "=0.62.2", features = ["Win32_Foundation", "Win32_System_Threading", "Win32_System_Memory", "Win32_Security"] }'''))
    resource = crate / "build.rs"
    write_changed(resource, originals['mitmproxy-windows/redirector/build.rs'].replace('    res.set_manifest(', '''    let level = if std::env::var("PROFILE").as_deref() == Ok("release") { "requireAdministrator" } else { "asInvoker" };
    res.set_manifest(''').replace('    </assembly>\n    "#,', '    </assembly>\n    "#.replace("requireAdministrator", level).as_str(),'))
    lock = source / "Cargo.lock"
    block = originals['Cargo.lock']
    start = block.index('name = "windows-redirector"')
    end = block.index('\n[[package]]', start)
    updated = block[start:end].replace(' "prost",', ' "prost",\n "serde",\n "serde_json",\n "windows 0.62.2",')
    write_changed(lock, block[:start] + updated + block[end:])
    env = {key.upper(): value for key, value in os.environ.items()}
    local_cargo = BUILD / "cargo" / "bin" / "cargo.exe"
    cargo = shutil.which("cargo") or (str(local_cargo) if local_cargo.exists() else None)
    if cargo is None:
        raise RuntimeError("Install Rust 1.95+ with the x86_64-pc-windows-msvc target to build the native helper")
    if cargo == str(local_cargo):
        env["CARGO_HOME"], env["RUSTUP_HOME"] = str(BUILD / "cargo"), str(BUILD / "rustup")
    env["WINDIVERT_PATH"] = str(Path(mitmproxy_windows.__file__).parent)
    # Resolve MSVC even when launched from a normal PowerShell session.
    vswhere = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    if vswhere.exists():
        vs = subprocess.check_output([str(vswhere), "-latest", "-products", "*", "-property", "installationPath"], text=True).strip()
        vcvars = Path(vs) / "VC/Auxiliary/Build/vcvarsall.bat"
        if vcvars.exists():
            setup = subprocess.check_output(f'cmd.exe /d /s /c ""{vcvars}" amd64 >nul && set"', env=env, text=True)
            for line in setup.splitlines():
                if "=" in line and not line.startswith("="):
                    key, value = line.split("=", 1)
                    env[key.upper()] = value
    env["PATH"] = env["WINDIVERT_PATH"] + os.pathsep + env.get("PATH", "")
    common = [cargo, "+1.95.0-x86_64-pc-windows-msvc", "--config", 'net.retry=2']
    for args in (["test", "--locked"], ["build", "--locked", "--release"]):
        subprocess.run(common + args + ["-p", "windows-redirector", "--target", TARGET], cwd=source, env=env, check=True)
    executable = source / "target" / TARGET / "release" / "windows-redirector.exe"
    for name in ("WinDivert.dll", "WinDivert64.sys"):
        shutil.copy2(Path(mitmproxy_windows.__file__).parent / name, executable.parent / name)
    return executable


if __name__ == "__main__":
    print(build())
