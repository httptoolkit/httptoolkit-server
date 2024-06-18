import _ from 'lodash';
import * as path from 'path';

import { delay, ErrorLike } from '@httptoolkit/util';

import { Interceptor } from '.';

import { HtkConfig } from '../config';
import { spawnToResult, waitForExit } from '../util/process-management';
import { OVERRIDE_JAVA_AGENT } from './terminal/terminal-env-overrides';
import { logError } from '../error-tracking';
import { commandExists, canAccess } from '../util/fs';

type JvmTarget = { pid: string, name: string, interceptedByProxy: number | undefined };

// Check that Java is present, and that it's compatible with agent attachment:
const javaBinPromise: Promise<string | false> = (async () => {
    // Check what Java binaries might exist:
    const javaBinPaths = [
        // $JAVA_HOME/bin/java is the way to explicitly configure this
        !!process.env.JAVA_HOME &&
            path.join(process.env.JAVA_HOME!!, 'bin', 'java'),

        // Magic Mac helper for exactly this, used if available
        await getMacJavaHome(),

        // Fallback to $PATH, but not on Mac, where by default this is a "Install Java" dialog warning
        (await commandExists('java')) && process.platform !== "darwin" &&
            'java'

        // In future, we could improve this by also finding & using the JVM from Android Studio. See
        // Flutter's implementation of logic required to do this:
        // https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/android/android_studio.dart
    ].filter(p => !!p) as string[];

    // Run a self test in parallel with each of them:
    const javaTestResults = await Promise.all(javaBinPaths.map(async (possibleJavaBin) => ({
        javaBin: possibleJavaBin,
        output: await testJavaBin(possibleJavaBin)
            .catch((e) => ({
                exitCode: -1,
                spawnError: e as ErrorLike,
                stdout: '',
                stderr: ''
            }))
    })))

    // Use the first Java in the list that succeeds:
    const bestJava = javaTestResults.filter(({ output }) =>
        output.exitCode === 0
    )[0];

    if (javaTestResults.length && !bestJava) {
        // Some Java binaries are present, but none are usable. Log the error output for debugging:
        javaTestResults.forEach((testResult) => {
            console.log(`Running ${testResult.javaBin}:`);

            const { stdout, stderr } = testResult.output;
            if (stdout) console.log(stdout);
            if (stderr) console.log(stderr);
            if (!stdout && !stderr) console.log('[No output]');

            if ('spawnError' in testResult.output) {
                const { spawnError } = testResult.output;
                console.log(spawnError.message || spawnError);
            }
        });

        // The most common reason for this is that outdated Java versions (most notably Java 8) don't include
        // the necessary APIs to attach to remote JVMs. That's inconvenient, but unavoidable & not unusual.
        // Fortunately, I think most active Java developers do have a recent version of Java installed.
        const unusualJavaErrors = javaTestResults.filter(({ output }) => {
            const outputText = output.stderr + '\n' + output.stdout;

            // Ignore any errors that we know definitely aren't recoverable/aren't our problem:
            return !hasUnsupportedJvmError(outputText) && // Not caused by a known incompatible JVM issue
                !hasJvmOomError(outputText) && // Not caused by a simple OOM
                !hasBrokenJvmError(outputText) && // Not a corrupted JVM
                // And not caused by ENOENT for an invalid Java path:
                !('spawnError' in output && output.spawnError.code === 'ENOENT')
        });

        if (unusualJavaErrors.length === 0) {
            console.warn('=> Java attach APIs are not available');
        } else {
            // If we find any other unexpected Java errors, we report them, to aid with debugging and
            // detecting issues with unusual JVMs.
            logError(new Error(`JVM attach test failed unusually - exited with ${unusualJavaErrors[0].output.exitCode}`));
        }
        return false;
    } else if (bestJava) {
        return bestJava.javaBin;
    } else {
        // No Java available anywhere - we just give up
        return false;
    }
})().catch((e) => {
    logError(e);
    return false;
});

// Try to use use Mac's java_home helper (available since 10.5 apparently)
async function getMacJavaHome() {
    if (!await canAccess('/usr/libexec/java_home')) return;

    const result = await spawnToResult('/usr/libexec/java_home', ['-v', '1.9+']);
    if (result.exitCode != 0) return;
    else return path.join(result.stdout.trim(), 'bin', 'java');
}

// Test a single binary, with a timeout:
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
        delay(30000, { unref: true }).then(() => {
            throw new Error(`Java bin test for ${possibleJavaBin} timed out`);
        })
    ]);
}

const hasUnsupportedJvmError = (testOutput: string) =>
    testOutput.includes('com/sun/tools/attach/AgentLoadException') || // Old Java missing Attach classes
    testOutput.includes('com.sun.tools.attach.AgentLoadException') || // Old Java missing Attach classes
    testOutput.includes('java.lang.UnsatisfiedLinkError: no attach in java.library.path') || // Similar
    testOutput.includes('Are we running in a JRE instead of a JDK') || // JREs aren't sufficient
    testOutput.includes('Unsupported major.minor version 52.0'); // Pre Java 8(!)

const hasBrokenJvmError = (testOutput: string) =>
    testOutput.includes('jvm.cfg'); // Somehow it seems that JVMs 'lose' this file and can't start?

const hasJvmOomError = (testOutput: string) =>
    testOutput.includes('insufficient memory') ||
    testOutput.includes('Could not reserve enough space for object heap');

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

    activableTimeout = 2000; // Increase the timeout slightly for this

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
        const targets = await this.targetsPromise;

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
            logError(`JVM target lookup failed with status ${listTargetsOutput.exitCode}`);
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