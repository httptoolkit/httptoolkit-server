# NSS & Certutil

This folder contains prebuilt binaries of the NSS tools and corresponding libs, including `certutil`. The folder are named to match Node.js's `process.platform` on the corresponding OSs.

`certutil` is used to preconfigure Firefox profile's certificate database to trust the HTTP Toolkit certificate authority. We attempt to use any existing `certutil` binary in PATH first, and fall back to the bundled binary if it's not available, or mark Firefox as unavailable if neither work. These binaries aren't included in the npm package for size reasons - in that case, you'll need to ensure certutil is available on your system some other way (for example, download the binaries here and put them in your PATH).

The files here were downloaded directly from https://tor.eff.org/dist/torbrowser/9.0.9/, in the mar-tools-{linux64,mac64,win64}.zip. They're used unmodified, under the Tor license also in this folder.