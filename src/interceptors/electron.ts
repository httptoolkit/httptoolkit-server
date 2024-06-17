import _ from 'lodash';
import { spawn } from 'child_process';
import * as path from 'path';

import { delay, ErrorLike, isErrorLike } from '@httptoolkit/util';
import { getPortPromise as getPort } from 'portfinder';
import { generateSPKIFingerprint } from 'mockttp';
import ChromeRemoteInterface = require('chrome-remote-interface');

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { canAccess, readFile } from '../util/fs';
import { windowsClose } from '../util/process-management';
import { getInheritableCurrentEnv, getTerminalEnvVars, OVERRIDES_DIR } from './terminal/terminal-env-overrides';
import { logError, addBreadcrumb } from '../error-tracking';
import { findExecutableInApp } from '@httptoolkit/osx-find-executable';

const isAppBundle = (path: string) => {
    return process.platform === "darwin" &&
        path.endsWith(".app");
};

// Returns true if this path is wrong, but path.app is a real app bundle.
const shouldBeAppBundle = async (path: string) => {
    if (process.platform !== 'darwin') return false;
    if (await canAccess(path)) return false;
    return canAccess(path + '.app');
}

export class ElectronInterceptor implements Interceptor {
    readonly id = 'electron';
    readonly version = '1.0.1';

    private debugClients: {
        [port: string]: Array<ChromeRemoteInterface.Client>
     } = {};

    constructor(private config: HtkConfig) { }

    private certData = readFile(this.config.https.certPath, 'utf8')

    async isActivable(): Promise<boolean> {
        return true;
    }

    isActive(proxyPort: number | string) {
        return !!this.debugClients[proxyPort] &&
            !!this.debugClients[proxyPort].length;
    }

    async activate(proxyPort: number, options: {
        pathToApplication: string
    }): Promise<void | {}> {
        const debugPort = await getPort({ port: proxyPort });
        const { pathToApplication } = options;

        // We're very flexible with paths for app bundles, because on Mac in reality most people
        // never see the executable itself, except when developing their own Electron apps.
        const cmd = isAppBundle(pathToApplication)
                ? await findExecutableInApp(pathToApplication)
            : await shouldBeAppBundle(pathToApplication)
                ? await findExecutableInApp(pathToApplication + '.app')
            // Non-darwin, or darwin with a full path to the binary:
                : pathToApplication;

        const currentEnv = getInheritableCurrentEnv();

        const appProcess = spawn(cmd, [`--inspect-brk=127.0.0.1:${debugPort}`], {
            stdio: 'inherit',
            env: {
                ...currentEnv,
                ...getTerminalEnvVars(proxyPort, this.config.https, currentEnv),
                // We have to disable NODE_OPTIONS injection. If set, the Electron
                // app never fires paused(). I suspect because --require changes the
                // startup process somehow. Regardless, we don't need it (we're injecting
                // manually anyway) so we just skip it here.
                NODE_OPTIONS: ''
            }
        });

        let debugClient: ChromeRemoteInterface.Client | undefined;
        let retries = 10;
        let spawnError: ErrorLike | undefined;

        appProcess.on('error', async (e) => {
            logError(e);

            if (debugClient) {
                // Try to close the debug connection if open, but very carefully
                try {
                    await debugClient.close();
                } catch (e) { }
            }

            // If we're still in the process of debugging the app, give up.
            spawnError = e as ErrorLike;
        });

        while (!debugClient && retries >= 0 && !spawnError) {
            try {
                debugClient = await ChromeRemoteInterface({
                    host: '127.0.0.1',
                    port: debugPort
                });
            } catch (error) {
                if ((isErrorLike(error) && error.code !== 'ECONNREFUSED') || retries === 0) {
                    throw error;
                }

                retries = retries - 1;
                await delay(500);
            }
        }

        if (spawnError) throw spawnError;
        if (!debugClient) throw new Error('Could not initialize CDP client');

        this.debugClients[proxyPort] = this.debugClients[proxyPort] || [];
        this.debugClients[proxyPort].push(debugClient);
        debugClient.on('disconnect', () => {
            _.remove(this.debugClients[proxyPort], c => c === debugClient);
        });

        // These allow us to use the APIs below
        await debugClient.Runtime.enable();
        await debugClient.Debugger.enable();

        // This starts watching for the initial pause event, which gives us the
        // inside-electron call frame to inject into (i.e. with require() available)
        const callFramePromise = new Promise<string>((resolve) => {
            debugClient!.Debugger.paused((stack) => {
                resolve(stack.callFrames[0].callFrameId);
            });
        });

        // This confirms we're ready, and triggers pause():
        await debugClient.Runtime.runIfWaitingForDebugger();

        const callFrameId = await callFramePromise;

        console.log("Injecting interception settings into Electron app...");

        // Inside the Electron process, load our electron-intercepting JS.
        const injectionResult = await debugClient.Debugger.evaluateOnCallFrame({
            expression: `require(${
                // Need to stringify to handle chars that need escaping (e.g. windows backslashes)
                JSON.stringify(path.join(OVERRIDES_DIR, 'js', 'prepend-electron.js'))
            })({
                newlineEncodedCertData: "${(await this.certData).replace(/\r\n|\r|\n/g, '\\n')}",
                spkiFingerprint: "${generateSPKIFingerprint(await this.certData)}"
            })`,
            callFrameId
        });

        if (injectionResult.exceptionDetails) {
            const exception = injectionResult.exceptionDetails as any;
            console.log(exception);

            addBreadcrumb("Evaluate error", {
                message: exception && exception.description,
                data: injectionResult.exceptionDetails as { [key: string]: any }
            });

            throw new Error("Failed to inject into Electron app");
        }

        console.log("App intercepted, resuming...");
        await debugClient.Debugger.resume();
        console.log("App resumed, Electron interception complete");
    }

    async deactivate(proxyPort: number | string): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all(
            this.debugClients[proxyPort].map(async (debugClient) => {
                let shutdown = false;
                const disconnectPromise = new Promise<void>((resolve) =>
                    debugClient.on('disconnect', resolve)
                ).then(() => {
                    shutdown = true
                });

                const pidResult = (
                    await debugClient.Runtime.evaluate({
                        expression: 'process.pid'
                    }).catch(() => ({ result: undefined }))
                ).result as { type?: string, value?: unknown } | undefined;

                const pid = pidResult && pidResult.type === 'number'
                    ? pidResult.value as number
                    : undefined;

                // If we can extract the pid, use it to cleanly close the app:
                if (_.isNumber(pid)) {
                    if (process.platform === 'win32') {
                        await windowsClose(pid);
                    } else {
                        process.kill(pid, "SIGTERM");
                    }

                    // Wait up to 1s for a clean shutdown & disconnect
                    await Promise.race([disconnectPromise, delay(1000)]);
                }

                if (!shutdown) {
                    // Didn't shutdown yet? Inject a hard exit.
                    await Promise.race([
                        debugClient.Runtime.evaluate({
                            expression: 'process.exit(0)'
                        }).catch(() => {}), // Ignore errors (there's an inherent race here)
                        disconnectPromise // If we disconnect, evaluate can time out
                    ]);
                };
            })
        );
    }

    async deactivateAll(): Promise<void> {
        await Promise.all<void>(
            Object.keys(this.debugClients).map(port => this.deactivate(port))
        );
    }

}