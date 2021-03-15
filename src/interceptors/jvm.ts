import * as _ from 'lodash';

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { spawnToResult, waitForExit } from '../process-management';
import { OVERRIDE_JAVA_AGENT } from './terminal/terminal-env-overrides';
import { reportError } from '../error-tracking';
import { commandExists } from '../util';

type JvmTarget = { pid: string, name: string, interceptedByProxy: number | undefined };

// Check that Java is present, and that it's possible to run list-targets
const isJavaAvailable = commandExists('java').then(async (isAvailable) => {
    if (!isAvailable) return false;

    const result = await spawnToResult(
        'java', [
            '-jar', OVERRIDE_JAVA_AGENT,
            'list-targets'
        ]
    );

    return result.exitCode === 0;
}).catch((e) => {
    // This is expected to happen occasionally, e.g. when using Java 8 (which doesn't support
    // the VM attachment APIs we need).
    console.log("Error checking for JVM targets", e);
    return false;
});

export class JvmInterceptor implements Interceptor {
    readonly id = 'attach-jvm';
    readonly version = '1.0.0';

    private interceptedProcesses: {
        [pid: string]: number // PID -> proxy port
    } = {};

    constructor(private config: HtkConfig) { }

    async isActivable(): Promise<boolean> {
        return await isJavaAvailable;
    }

    isActive(proxyPort: number | string) {
        return _.some(this.interceptedProcesses, (port) => port === proxyPort);
    }

    async getMetadata(type: 'summary' | 'detailed'): Promise<{
        jvmTargets?: { [pid: string]: JvmTarget }
    }> {
        // We only poll the targets available when explicitly requested,
        // since it's a bit expensive.
        if (type === 'summary') return {};

        if (!this.targetsPromise) {
            // We cache the targets lookup whilst it's active, so that concurrent calls
            // all just run one lookup and return the same result.
            this.targetsPromise = this.getTargets()
                .finally(() => { this.targetsPromise = undefined; });
        }
        const targets = await this.targetsPromise

        return {
            jvmTargets: _.keyBy(targets, 'pid')
        };
    }

    private targetsPromise: Promise<JvmTarget[]> | undefined;

    private async getTargets(): Promise<JvmTarget[]> {
        const listTargetsOutput = await spawnToResult(
            'java', [
                '-jar', OVERRIDE_JAVA_AGENT,
                'list-targets'
            ]
        );

        if (listTargetsOutput.exitCode !== 0) {
            reportError(`JVM target lookup failed with status ${listTargetsOutput.exitCode}`);
            return [];
        }

        return listTargetsOutput.stdout
            .split('\n')
            .filter(line => line.includes(':'))
            .map((line) => {
                const nameIndex = line.indexOf(':') + 1;

                const pid = line.substring(0, nameIndex - 1);

                return {
                    pid,
                    name: line.substring(nameIndex),
                    interceptedByProxy: this.interceptedProcesses[pid]
                };
            })
            .filter((target) =>
                // Exclude our own attacher and/or list-target queries from this list
                !target.name.includes(OVERRIDE_JAVA_AGENT)
            );
    }

    async activate(proxyPort: number, options: {
        targetPid: string
    }): Promise<void> {
        const interceptionResult = await spawnToResult(
            'java', [
                '-jar', OVERRIDE_JAVA_AGENT,
                options.targetPid,
                '127.0.0.1',
                proxyPort.toString(),
                this.config.https.certPath
            ],
            {},
            true // Inherit IO, so we can see output easily, if any
        );

        if (interceptionResult.exitCode !== 0) {
            throw new Error(`Failed to attach to JVM, exit code ${interceptionResult.exitCode}`);
        } else {
            this.interceptedProcesses[options.targetPid] = proxyPort;

            // Poll the status of this pid every 250ms - remove it once it disappears.
            waitForExit(parseInt(options.targetPid, 10), Infinity)
            .then(() => {
                delete this.interceptedProcesses[options.targetPid];
            });
        }
    }

    // Nothing we can do to deactivate, unfortunately. In theory the agent could do this, unwriting all
    // it's changes, but it's *super* complicated to do for limited benefit.
    async deactivate(proxyPort: number | string): Promise<void> {}
    async deactivateAll(): Promise<void> {}

}