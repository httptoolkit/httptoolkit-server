"""Build a folder distribution: native driver remains replaceable, never onefile."""
import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile
import hashlib
import urllib.request
from native.build_native import build as build_native

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "dist" / "mt5-router"


def package_driver_source(licenses):
    archive = HERE / "build/WinDivert-source.zip"
    if not archive.exists():
        urllib.request.urlretrieve("https://codeload.github.com/basil00/WinDivert/zip/refs/tags/v2.2.2", archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != "65ec79c9e6afa99f648a3f4d1f6db794640b40d0b65bd438770ea503ee14ecb7":
        raise RuntimeError("WinDivert source SHA256 mismatch")
    shutil.copy2(archive, licenses / archive.name)


def main():
    import mitmproxy_windows
    # PyInstaller replaces its generated output directory on a rebuild.
    if not OUTPUT.resolve().is_relative_to((HERE.parent / "dist").resolve()):
        raise RuntimeError("Build output must remain inside this project's dist directory.")
    backend_directory = Path(mitmproxy_windows.__file__).parent
    native_executable = build_native()
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--windowed",
            "--name", "MT5Router", "--distpath", str(OUTPUT), "--workpath", str(HERE / "build"),
            "--specpath", str(HERE / "build"),
            "--add-binary", f"{backend_directory / 'WinDivert.dll'};mitmproxy_windows",
            "--add-data", f"{native_executable};mt5_native",
            "--add-binary", f"{backend_directory / 'WinDivert.dll'};mt5_native",
            "--add-data", f"{backend_directory / 'WinDivert64.sys'};mt5_native",
            "--copy-metadata", "mitmproxy-rs", "--copy-metadata", "mitmproxy-windows",
            str(HERE / "app.py")]
    subprocess.run(args, check=True, cwd=HERE)
    destination = OUTPUT / "MT5Router"
    shutil.copy2(HERE / "README.md", destination / "README.md")
    for script in ("Install-Startup.ps1", "Start-Proxy.ps1"):
        shutil.copy2(HERE / script, destination / script)
    licenses = destination / "licenses"
    licenses.mkdir(exist_ok=True)
    shutil.copy2(Path(mitmproxy_windows.__file__).parent / "LICENSE", licenses / "WinDivert.txt")
    shutil.copy2(HERE / "THIRD-PARTY-NOTICES.txt", licenses / "THIRD-PARTY-NOTICES.txt")
    package_driver_source(licenses)
    with zipfile.ZipFile(licenses / "native-source.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for source in (HERE / "native/policy.rs", HERE / "native/redirector.rs", HERE / "native/connections.rs",
                       HERE / "native/build_native.py", HERE / "native/README.md",
                       HERE / "build/mitmproxy-rs-0.12.11.tar.gz"):
            archive.write(source, source.name)
    # Keep the exact wheels' metadata/notices and interpreter license in the artifact.
    shutil.copy2(Path(sys.base_prefix) / "LICENSE.txt", licenses / "Python.txt")
    for package in ("mitmproxy-rs", "mitmproxy-windows"):
        dist = importlib.metadata.distribution(package)
        for item in dist.files or ():
            if "license" in str(item).lower() and "dist-info" in str(item):
                source = Path(dist.locate_file(item))
                if source.is_file():
                    shutil.copy2(source, licenses / f"{package}-{source.name}")
    shutil.make_archive(str(OUTPUT / "MT5Router-windows-x64"), "zip", OUTPUT, "MT5Router")
    print(destination / "MT5Router.exe")


if __name__ == "__main__":
    main()
