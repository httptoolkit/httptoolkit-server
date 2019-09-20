import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import { spawn as spawnAsync, SpawnOptions } from 'child_process';

const OUTPUT_DIR = path.join(__dirname, 'build');

const pjson = require(path.join(__dirname, './package.json'));

const spawn = (command: string, args: string[] = [], options?: SpawnOptions) => {
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

const updateRegistryJs = async (platform: string) => {
    // Install registry JS for a given target platform, and copy its native
    // module into our bundle.
    const registryJsDir = path.join(OUTPUT_DIR, 'node_modules', 'registry-js');
    await fs.rmdir(registryJsDir).catch(() => {});
    await spawn('npm', [
        'install',
        'registry-js',
        '--no-save'
    ], {
        cwd: OUTPUT_DIR,
        stdio: 'inherit',
        env: Object.assign({}, process.env, { 'npm_config_platform': platform })
    });
    await fs.copyFile(
        path.join(registryJsDir, 'build', 'Release', 'registry.node'),
        path.join(OUTPUT_DIR, 'bundle', 'registry.node'),
    );
};

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
        path.join('bundle', 'schema.gql')
    ].map((extraFile) =>
        fs.copy(path.join(__dirname, extraFile), path.join(OUTPUT_DIR, extraFile))
    ));

    // Edit the package to replace deps with the bundle:
    pjson.files.push('/bundle');
    pjson.dependencies = _.pick(pjson.dependencies, pjson.oclif.dependenciesToPackage);
    delete pjson.scripts.prepack; // We don't want to rebuild
    await fs.writeJson(path.join(OUTPUT_DIR, 'package.json'), pjson);

    const buildScript = path.join(OUTPUT_DIR, 'build-release.sh');

    // Run build-release in this folder, for each platform:
    console.log('Building for Linux');
    await updateRegistryJs('linux');
    await spawn(buildScript, ['linux'], { cwd: OUTPUT_DIR, stdio: 'inherit' });

    console.log('Building for Darwin');
    await updateRegistryJs('darwin');
    await spawn(buildScript, ['darwin'], { cwd: OUTPUT_DIR, stdio: 'inherit' });

    console.log('Building for Win32');
    await updateRegistryJs('win32');
    await spawn(buildScript, ['win32'], { cwd: OUTPUT_DIR, stdio: 'inherit' });
}

packageApp().catch((error: any) => {
    console.error(error.message);
});
