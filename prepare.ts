import * as path from 'path';
import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import klaw from 'klaw';
import { spawn as spawnAsync, SpawnOptions } from 'child_process';

const spawn = (command: string, args: string[] = [], options: SpawnOptions = {}) => {
    return new Promise<void>((resolve, reject) => {
        const proc = spawnAsync(command, args, options);
        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(
                `Spawn ${command} ${args.join(' ')} exited with ${code}`
            ));
        });
    });
}

const collectAsyncIterator = async (asyncIterator: any) => {
    const result: any[] = [];
    for await (const value of asyncIterator) result.push(value);
    return result;
}

const OVERRIDES_DIR = path.join(__dirname, 'overrides');

(async () => {
    console.log('Installing override npm dependencies...');

    await spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--production'], {
        cwd: path.join(OVERRIDES_DIR, 'js'),
        stdio: 'inherit'
    });

    const files: Array<{
        path: string,
        stats: Stats
    }> = await collectAsyncIterator(klaw(OVERRIDES_DIR));

    // For Docker we don't know the user in the container, so all override files must
    // be globally readable (and directories globally executable)
    await files.map(({ path, stats }) =>
        stats.isDirectory()
            ? fs.chmod(path, stats.mode | 0o5) // Set o+rx
            : fs.chmod(path, stats.mode | 0o4) // Set o+r
    );

    console.log('Override dependencies installed');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});