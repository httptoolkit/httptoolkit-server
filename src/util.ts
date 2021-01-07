import * as _ from 'lodash';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { spawn } from 'child_process';
import * as ensureCommandExists from 'command-exists';

export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function waitUntil<T extends unknown>(
    delayMs: number,
    tries: number,
    test: () => Promise<T>
): Promise<Exclude<T, false>> {
    let result = tries > 0 && await test()

    while (tries > 0 && !result) {
        tries = tries - 1;
        await delay(delayMs);
        result = await test();
    }

    if (!result) throw new Error(`Wait loop failed`);
    else return result as Exclude<T, false>;
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

type Proc = {
    pid: number,
    command: string,
    bin: string | undefined,
    args: string | undefined
};

const getOutputLines = (stdout: string) =>
    stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => !!line);

/**
 * Attempts to get a list of pid + command + binary + args for every process running
 * on the machine owned by the current user (not *all* processes!).
 *
 * This is best efforts, due to the lack of guarantees on 'ps'. Notably args may be
 * undefined, if we're unable to work out which part of the command is the command
 * and which is args.
 */
export async function listRunningProcesses(): Promise<Array<Proc>> {
    if (process.platform !== 'win32') {
        const [psCommResult, psFullResult] = await Promise.all([
            spawnToResult('ps', ['xo', 'pid=,comm=']), // Prints pid + bin only
            spawnToResult('ps', ['xo', 'pid=,command=']), // Prints pid + command + args
        ]);

        if (psCommResult.exitCode !== 0 || psFullResult.exitCode !== 0) {
            throw new Error(`Could not list running processes, ps exited with code ${
                psCommResult.exitCode || psFullResult.exitCode
            }`);
        }

        const processes = getOutputLines(psCommResult.stdout).map(line => {
                const firstSpaceIndex = line.indexOf(' ');
                if (firstSpaceIndex === -1) {
                    throw new Error('No space in PS output');
                }

                const pid = parseInt(line.substring(0, firstSpaceIndex), 10);
                const command = line.substring(firstSpaceIndex + 1);

                return { pid, command } as Proc;
            });

        const processesByPid = _.keyBy(processes, p => p.pid);

        getOutputLines(psFullResult.stdout).forEach(line => {
            const firstSpaceIndex = line.indexOf(' ');
            if (firstSpaceIndex === -1) throw new Error('No space in PS output');

            const pid = parseInt(line.substring(0, firstSpaceIndex), 10);
            const binAndArgs = line.substring(firstSpaceIndex + 1);

            const proc = processesByPid[pid];
            if (!proc) return;

            if (proc.command.includes(path.sep)) {
                // Proc.command is a fully qualified path (as on Mac)
                if (binAndArgs.startsWith(proc.command)) {
                    proc.bin = proc.command;
                    proc.args = binAndArgs.substring(proc.bin.length + 1);
                }
            } else {
                // Proc.command is a plain binary name (as on Linux)
                const commandMatch = binAndArgs.match(
                    // Best guess: first instance of the command name followed by a space
                    new RegExp(_.escapeRegExp(proc.command) + '( |$)')
                );

                if (!commandMatch) {
                    // We can't work out which bit is the command, don't set args, treat
                    // the whole command line as the command and give up
                    proc.command = binAndArgs;
                    return;
                }

                const commandIndex = commandMatch.index!;
                proc.bin = binAndArgs.substring(0, commandIndex + proc.command.length);
                proc.args = binAndArgs.substring(proc.bin.length + 1);
            }
        });

        return processes;
    } else {
        const wmicOutput = await spawnToResult('wmic', [
            'Process', 'Get', 'processid,commandline'
        ]);

        if (wmicOutput.exitCode !== 0) {
            throw new Error(`WMIC exited with unexpected error code ${wmicOutput.exitCode}`);
        }

        return getOutputLines(wmicOutput.stdout)
            .slice(1) // Skip the header line
            .filter((line) => line.includes(' ')) // Skip lines where the command line isn't available (just pids)
            .map((line) => {
                const pidIndex = line.lastIndexOf(' ') + 1;
                const pid = parseInt(line.substring(pidIndex), 10);

                const command = line.substring(0, pidIndex).trim();
                const bin = command[0] === '"'
                    ? command.substring(1, command.substring(1).indexOf('"') + 1)
                    : command.substring(0, command.indexOf(' '));
                const args = command[0] === '"'
                    ? command.substring(bin.length + 3)
                    : command.substring(bin.length + 1);

                return {
                    pid,
                    command,
                    bin,
                    args
                };
            });
    }
}

// Cleanly close (simulate closing the main window) on a specific windows process
export async function windowsClose(pid: number) {
    await spawnToResult('taskkill', [
        '/pid', pid.toString(),
    ]);
}

// Harshly kill a windows process by some WMIC matching string e.g.
// "processId=..." or "CommandLine Like '%...%'"
export async function windowsKill(processMatcher: string) {
    await spawnToResult('wmic', [
        'Path', 'win32_process',
        'Where', processMatcher,
        'Call', 'Terminate'
    ], { }, true);
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