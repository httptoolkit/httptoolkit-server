import { promisify } from 'util';
import * as fs from 'fs';
import * as rimraf from 'rimraf';
import { spawn } from 'child_process';

export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function windowsKill(processMatcher: string) {
    await spawn('wmic', [
        'Path', 'win32_process',
        'Where', processMatcher,
        'Call', 'Terminate'
    ], {
        stdio: 'inherit'
    });
}

// Spawn a command, and resolve with all output as strings when it terminates
export function spawnToResult(command: string, args: string[] = [], inheritOutput = false): Promise<{
    exitCode?: number,
    stdout: string,
    stderr: string
}> {
    return new Promise((resolve, reject) => {
        const childProc = spawn(command, args, { stdio: 'pipe' });
        const { stdout, stderr } = childProc;

        const stdoutData: Buffer[] = [];
        stdout.on('data', (d) => stdoutData.push(d));
        const stderrData: Buffer[] = [];
        stderr.on('data', (d) => stderrData.push(d));

        if (inheritOutput) {
            stdout.pipe(process.stdout);
            stderr.pipe(process.stderr);
        }

        childProc.once('error', reject);
        childProc.once('close', (code?: number) => {
            // Note that we do _not_ check the error code, we just return it
            resolve({
                exitCode: code,
                stdout: Buffer.concat(stdoutData).toString(),
                stderr: Buffer.concat(stderrData).toString()
            });
        });
    });
};

export const statFile = promisify(fs.stat);
export const readFile = promisify(fs.readFile);
export const readDir = promisify(fs.readdir);
export const deleteFile = promisify(fs.unlink);
export const checkAccess = promisify(fs.access);
export const mkDir = promisify(fs.mkdir);
export const writeFile = promisify(fs.writeFile);
export const renameFile = promisify(fs.rename);

export const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

export const deleteFolder = promisify(rimraf);

export const ensureDirectoryExists = (path: string) =>
    checkAccess(path).catch(() => mkDir(path, { recursive: true }));