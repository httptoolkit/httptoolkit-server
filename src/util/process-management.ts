import _ from 'lodash';
import * as path from 'path';
import { spawn } from 'child_process';

import { delay } from '@httptoolkit/util';

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

export function spawnPowerShellToResult(command: string) {
    return spawnToResult('powershell.exe', [
        '-NoProfile', '-NonInteractive',
        '-Command', command
    ]);
}

type Proc = {
    pid: number,
    command: string, // Process name (often short binary name)
    bin: string | undefined, // Full path to the binary, if available
    args: string | undefined // Arguments as a single string, if available
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
        const pshResult = await spawnPowerShellToResult(
            'Get-CimInstance Win32_Process | ' +
            'ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)|$($_.ExecutablePath)" }'
        );

        if (pshResult.exitCode !== 0) {
            throw new Error(`PowerShell process query exited with unexpected error code ${pshResult.exitCode}`);
        }

        return getOutputLines(pshResult.stdout)
        .map(line => {
            const [pid, command, commandLine, bin] = line.split('|');

            let args: string | undefined;
            if (commandLine.startsWith('"')) {
                // Command line might start with full path or bare binary name:
                if (commandLine.startsWith(`"${bin}"`)) {
                    args = commandLine.substring(bin.length + 3);
                } else if (commandLine.startsWith(`"${command}"`)) {
                    args = commandLine.substring(command.length + 3);
                }
                // There's probably other possibilities, but it's not critical enough that we
                // need to bother trying to be much smarter here.
            } else {
                const firstSpace = commandLine.indexOf(' ');
                if (firstSpace !== -1) {
                    args = commandLine.substring(firstSpace + 1);
                }
            }

            return { pid: parseInt(pid, 10), command, bin, args } as Proc;
        });
    }
}

export async function waitForExit(pid: number, timeout: number = 5000): Promise<void> {
    const startTime = Date.now();

    while (true) {
        try {
            process.kill(pid, 0) as void | boolean;

            // Didn't throw. If we haven't timed out, check again after 250ms:
            if (Date.now() - startTime > timeout) {
                throw new Error("Process did not exit before timeout");
            }
            await delay(250);
        } catch (e) {
            if ((e as Error & { code?: string }).code === 'ESRCH') {
                return; // Process doesn't exist! We're done.
            }
            else throw e;
        }
    }
}

// Cleanly close (simulate closing the main window) on a specific windows process
export async function windowsClose(pid: number) {
    await spawnToResult('taskkill', [
        '/pid', pid.toString(),
    ]);
}

// Harshly kill a windows process by command-line match:
export async function windowsKillByCliMatch(globMatcher: string) {
    await spawnPowerShellToResult(
        'Get-CimInstance Win32_Process | ' +
        `Where-Object { $_.CommandLine -like "${globMatcher}" } | ` +
        'Invoke-CimMethod -Name Terminate'
    );
}
