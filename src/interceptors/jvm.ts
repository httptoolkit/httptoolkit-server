import * as _ from 'lodash';
import * as path from 'path';

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { spawnToResult, waitForExit } from '../process-management';
import { OVERRIDE_JAVA_AGENT } from './terminal/terminal-env-overrides';
import { reportError } from '../error-tracking';
import { commandExists, delay } from '../util';

type JvmTarget = { pid: string, name: string, interceptedByProxy: number | undefined };

// Check that Java is present, and that it's compatible with agent attachment:
const javaBinPromise: Promise<string | false> = (async () => {
    const javaBinPaths = [
        // Check what Java binaries might exist:
        ...(!!process.env.JAVA_HOME // $JAVA_HOME/bin/java is preferable
            ? [path.join(process.env.JAVA_HOME!!, 'bin', 'java')]
            : []
        ),
        ...(await commandExists('java') // but any other Java in $PATH will do
            ? ['java']
            : []
        )
    ];

    // Run a self test in parallel with each of them:
    const javaTestResults = await Promise.all(javaBinPaths.map(async (possibleJavaBin) => ({
        javaBin: possibleJavaBin,
        output: await testJavaBin(possibleJavaBin)
    })))

    // Use the first Java in the list that succeeds:
    const bestJava = javaTestResults.filter(({ output }) =>
        output.exitCode === 0
    )[0];

    if (javaTestResults.length && !bestJava) {
        // If some Java is present, but none are working, we report the failures. Hoping that this will hunt
        // down some specific incompatibilities that we can better work around/detect.
        javaTestResults.forEach((testResult) => {
            console.log(`Running ${testResult.javaBin}:`);
            console.log(testResult.output.stdout);
            console.log(testResult.output.stderr);
        });

        throw new Error(`JVM attach not available, exited with ${javaTestResults[0].output.exitCode}`);
    } else if (bestJava) {
        return bestJava.javaBin;
    } else {
        // No Java available anywhere - we just give up
        return false;
    }
})().catch((e) => {
    reportError(e);
    return false;
});

function testJavaBin(possibleJavaBin: string) {
    return Promise.race([
        spawnToResult(
            possibleJavaBin, [
                '-Djdk.attach.allowAttachSelf=true', // Required for self-test
                '-jar', OVERRIDE_JAVA_AGENT,
                'self-test'
            ]
        ),
        // Time out permanently after 30 seconds - this only runs once max anyway
        delay(30000).then(() => {
            throw new Error(`Java bin test for ${possibleJavaBin} timed out`);
        })
    ]);
}

export class JvmInterceptor implements Interceptor {
    readonly id = 'attach-jvm';
    readonly version = '1.0.1';

    private interceptedProcesses: {
        [pid: string]: number // PID -> proxy port
    } = {};

    constructor(private config: HtkConfig) { }

    async isActivable(): Promise<boolean> {
        return !!await javaBinPromise;
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
        const javaBin = await javaBinPromise;
        if (!javaBin) throw new Error("Attach activated but no Java available");

        const listTargetsOutput = await spawnToResult(
            javaBin, [
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
            {}
        );

        if (interceptionResult.exitCode !== 0) {
            console.log(interceptionResult.stdout);
            console.log(interceptionResult.stderr);
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