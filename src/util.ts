import { promisify } from 'util';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { spawn } from 'child_process';
import * as ensureCommandExists from 'command-exists';

export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export interface Deferred<T> {
    resolve: (arg: T) => void,
    reject: (e?: Error) => void,
    promise: Promise<T>
}

export function getDeferred<T = void>(): Deferred<T> {
    let resolve: undefined | ((arg: T) => void) = undefined;
    let reject: undefined | ((e?: Error) => void) = undefined;

    let promise = new Promise<T>((resolveCb, rejectCb) => {
        resolve = resolveCb;
        reject = rejectCb;
    });

    // TS thinks we're using these before they're assigned, which is why
    // we need the undefined types, and the any here.
    return { resolve, reject, promise } as any;
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
export function spawnToResult(command: string, args: string[] = [], options = {}, inheritOutput = false): Promise<{
    exitCode?: number,
    stdout: string,
    stderr: string
}> {
    return new Promise((resolve, reject) => {
        const childProc = spawn(command, args, Object.assign({ stdio: 'pipe' } as const, options));
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
export const copyFile = promisify(fs.copyFile);

export const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

export const deleteFolder = promisify(rimraf);

export const ensureDirectoryExists = (path: string) =>
    checkAccess(path).catch(() => mkDir(path, { recursive: true }));

export const commandExists = (path: string): Promise<boolean> =>
    ensureCommandExists(path).then(() => true).catch(() => false);

export const createTmp = (options: tmp.Options = {}) => new Promise<{
    path: string,
    fd: number,
    cleanupCallback: () => void
}>((resolve, reject) => {
    tmp.file(options, (err, path, fd, cleanupCallback) => {
        if (err) return reject(err);
        resolve({ path, fd, cleanupCallback });
    });
});

export const moveFile = async (oldPath: string, newPath: string) => {
    try {
        await renameFile(oldPath, newPath);
    } catch (e) {
        if (e.code === 'EXDEV') {
            // Cross-device - can't rename files across partions etc.
            // In that case, we fallback to copy then delete:
            await copyFile(oldPath, newPath);
            await deleteFile(oldPath);
        }
    }
};