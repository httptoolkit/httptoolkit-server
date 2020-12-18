import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import { spawn as spawnAsync, SpawnOptions } from 'child_process';

const OUTPUT_DIR = path.join(__dirname, 'build');

const pjson = require(path.join(__dirname, './package.json'));

const spawn = (command: string, args: string[] = [], options: SpawnOptions = {}) => {
    return new Promise((resolve, reject) => {
        const proc = spawnAsync(command, args, options);
        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(
                `Spawn ${command} ${args.join(' ')} exited with ${code}`
            ));
        });
    });
}

const packageApp = async () => {
    console.log('Preparing packaging directory');
    await fs.emptyDir(OUTPUT_DIR);

    // Copy all normally deployable files:
    const filesToCopy = pjson.files;
    await Promise.all(filesToCopy.map((file: string) =>
        fs.copy(
            path.join(__dirname, file),
            path.join('build', file)
        )
    ));

    await Promise.all([
        // Include the packaging & build scripts:
        'build-release.sh',
        // Include package-lock.json, to keep dependencies locked:
        'package-lock.json',
        // Add the fully bundled source (not normally packaged by npm):
        path.join('bundle', 'index.js'),
        path.join('bundle', 'error-tracking.js'),
        path.join('bundle', 'schema.gql'),
        // Static resources normally stored in browser-launcher
        path.join('bundle', 'bl-resources')
    ].map((extraFile) =>
        fs.copy(path.join(__dirname, extraFile), path.join(OUTPUT_DIR, extraFile))
    ));

    // Edit the package to replace deps with the bundle:
    pjson.files.push('/bundle');
    pjson.files.push('/nss');
    pjson.dependencies = _.pick(pjson.dependencies, pjson.oclif.dependenciesToPackage);
    delete pjson.scripts.prepack; // We don't want to rebuild
    await fs.writeJson(path.join(OUTPUT_DIR, 'package.json'), pjson);

    const buildScript = path.join(OUTPUT_DIR, 'build-release.sh');

    // Run build-release in this folder, for each platform. For each bundle, we copy in
    // only the relevant platform-specific NSS files.
    console.log('Building for Linux');
    await fs.mkdir(path.join(OUTPUT_DIR, 'nss'));
    await fs.copy(path.join(__dirname, 'nss', 'linux'), path.join(OUTPUT_DIR, 'nss', 'linux'));
    await spawn(buildScript, ['linux'], { cwd: OUTPUT_DIR, stdio: 'inherit' });

    console.log('Building for Darwin');
    await fs.remove(path.join(OUTPUT_DIR, 'nss', 'linux'));
    await fs.copy(path.join(__dirname, 'nss', 'darwin'), path.join(OUTPUT_DIR, 'nss', 'darwin'));
    await spawn(buildScript, ['darwin'], { cwd: OUTPUT_DIR, stdio: 'inherit' });

    console.log('Building for Win32');
    await fs.remove(path.join(OUTPUT_DIR, 'nss', 'darwin'));
    await fs.copy(path.join(__dirname, 'nss', 'win32'), path.join(OUTPUT_DIR, 'nss', 'win32'));
    await spawn(buildScript, ['win32'], { cwd: OUTPUT_DIR, stdio: 'inherit' });

    // Oclif builds a nodeless platform-agnostic bundle too (although in our case, nothing is
    // really platform agnostic). Not necessary, probably won't work - drop it.
    await fs.remove(path.join(
        OUTPUT_DIR,
        'dist',
        `v${pjson.version}`,
        `httptoolkit-server-v${pjson.version}.tar.gz`
    ));
}

packageApp().catch(e => {
    console.error(e);
    process.exit(1);
});
