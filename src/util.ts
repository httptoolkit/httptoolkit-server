import { spawn, SpawnOptions } from 'child_process';

export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const IS_PROD_BUILD = !!process.env.HTTPTOOLKIT_SERVER_BINPATH;

export const ALLOWED_ORIGINS = IS_PROD_BUILD
    ? [
        // Prod builds only allow HTTPS app.httptoolkit.tech usage. This
        // ensures that no other sites/apps can communicate with your server
        // whilst you have the app open. If they could (requires an HTTP mitm),
        // they would be able to start proxies & interceptors.
        /^https:\/\/app\.httptoolkit\.tech$/
    ]
    : [
        // Dev builds can use the main site, or local sites, even if those
        // use HTTP. Note that HTTP here could technically open you to the risk
        // above, but it'd require a DNS MitM too (to stop local.httptoolkit.tech
        // resolving to localhost and never hitting the network).
        /^https?:\/\/localhost(:\d+)?$/,
        /^http:\/\/local\.httptoolkit\.tech(:\d+)?$/,
        /^https:\/\/app\.httptoolkit\.tech$/
    ]

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