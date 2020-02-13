import * as _ from 'lodash';
import { spawn } from 'child_process';
import * as path from 'path';

import { getPortPromise as getPort } from 'portfinder';
import { generateSPKIFingerprint } from 'mockttp';
import ChromeRemoteInterface = require('chrome-remote-interface');

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { delay, readFile } from '../util';
import { getTerminalEnvVars, OVERRIDES_DIR } from './terminal/terminal-env-overrides';
import { reportError, addBreadcrumb } from '../error-tracking';
import { findExecutableInApp } from '@httptoolkit/osx-find-executable';

const isAppBundle = (path: string) => {
    return process.platform === "darwin" &&
        path.endsWith(".app");
};

export class ElectronInterceptor implements Interceptor {
    readonly id = 'electron';
    readonly version = '1.0.1';

    private debugClients: {
        [port: string]: Array<ChromeRemoteInterface.CdpClient>
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

        const cmd = isAppBundle(pathToApplication)
            ? await findExecutableInApp(pathToApplication)
            : pathToApplication;

        const appProcess = spawn(cmd, [`--inspect-brk=${debugPort}`], {
            stdio: 'inherit',
            env: Object.assign({},
                process.env,
                getTerminalEnvVars(proxyPort, this.config.https, process.env)
            )
        });

        let debugClient: ChromeRemoteInterface.CdpClient | undefined;
        let retries = 10;

        appProcess.on('error', async (e) => {
            reportError(e);

            if (debugClient) {
                // Try to close the debug connection if open, but very carefully
                try {
                    await debugClient.close();
                } catch (e) { }
            }

            // If we're still in the process of debugging the app, give up.
            retries = -1;
        });

        while (!debugClient && retries >= 0) {
            try {
                debugClient = await ChromeRemoteInterface({ port: debugPort });
            } catch (error) {
                if (error.code !== 'ECONNREFUSED' || retries === 0) {
                    throw error;
                }

                retries = retries - 1;
                await delay(500);
            }
        }
        if (!debugClient) throw new Error('Could not initialize CDP client');

        this.debugClients[proxyPort] = this.debugClients[proxyPort] || [];
        this.debugClients[proxyPort].push(debugClient);
        debugClient.once('disconnect', () => {
            _.remove(this.debugClients[proxyPort], c => c === debugClient);
        });

        const callFramePromise = new Promise<string>((resolve) => {
            debugClient!.Debugger.paused((stack) => {
                resolve(stack.callFrames[0].callFrameId);
            });
        });

        debugClient.Runtime.runIfWaitingForDebugger();
        await debugClient.Runtime.enable();
        await debugClient.Debugger.enable();

        const callFrameId = await callFramePromise;

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

            addBreadcrumb("Evaluate error", {
                message: exception && exception.description,
                data: injectionResult.exceptionDetails as { [key: string]: any }
            });

            throw new Error("Failed to inject into Electron app");
        }

        debugClient.Debugger.resume();
    }

    async deactivate(proxyPort: number | string): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all(
            this.debugClients[proxyPort].map(async (debugClient) => {
                // Politely signal self to shutdown cleanly
                await debugClient.Runtime.evaluate({
                    expression: 'process.kill(process.pid, "SIGTERM")'
                });

                // Wait up to 1s for a clean shutdown & disconnect
                const cleanShutdown = await Promise.race([
                    new Promise((resolve) =>
                        debugClient.once('disconnect', () => resolve(true))
                    ),
                    delay(1000).then(() => false)
                ]);

                if (!cleanShutdown) {
                    // Didn't shutdown? Inject a hard exit.
                    await debugClient.Runtime.evaluate({
                        expression: 'process.exit(0)'
                    }).catch(() => {}) // Ignore errors (there's an inherent race here)
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