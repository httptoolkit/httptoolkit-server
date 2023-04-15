import _ from 'lodash';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';

import { findExecutableById } from '@httptoolkit/osx-find-executable';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { reportError, addBreadcrumb } from '../../error-tracking';
import { isErrorLike } from '../../util/error';
import { canAccess, commandExists } from '../../util/fs';
import { spawnToResult } from '../../util/process-management';

import { getTerminalEnvVars } from './terminal-env-overrides';
import { editShellStartupScripts, resetShellStartupScripts } from './terminal-scripts';

const DEFAULT_GIT_BASH_PATH = 'C:/Program Files/git/git-bash.exe';

interface SpawnArgs {
    command: string;
    args?: string[];
    options?: SpawnOptions;
    skipStartupScripts?: true;
}

const getTerminalCommand = _.memoize(async (): Promise<SpawnArgs | null> => {
    let result: Promise<SpawnArgs | null>;

    if (process.platform === 'win32') result = getWindowsTerminalCommand();
    else if (process.platform === 'darwin') result = getOSXTerminalCommand();
    else if (process.platform === 'linux') result = getLinuxTerminalCommand();
    else result = Promise.resolve(null);

    result.then((terminal) => {
        if (terminal) addBreadcrumb('Found terminal', { data: { terminal } });
        else reportError('No terminal could be detected');
    });

    return result;
});

const getWindowsTerminalCommand = async (): Promise<SpawnArgs | null> => {
    if (await canAccess(DEFAULT_GIT_BASH_PATH)) {
        return { command: DEFAULT_GIT_BASH_PATH };
    } else if (await commandExists('git-bash')) {
        return { command: 'git-bash' };
    }

    return { command: 'start', args: ['cmd'], options: { shell: true }, skipStartupScripts: true };
};

const getOSXTerminalCommand = async (): Promise<SpawnArgs | null> => {
    const terminalExecutables = (await Promise.all(
        [
            'co.zeit.hyper',
            'com.googlecode.iterm2',
            'com.googlecode.iterm',
            'com.apple.Terminal'
        ].map(
            (bundleId) => findExecutableById(bundleId).catch(() => null)
        )
    )).filter((executablePath) => !!executablePath);

    const bestAvailableTerminal = terminalExecutables[0];

    if (bestAvailableTerminal) return { command: bestAvailableTerminal };
    else return null;
};

const getLinuxTerminalCommand = async (): Promise<SpawnArgs | null> => {
    // Symlink/wrapper that should indicate the system default
    if (await commandExists('x-terminal-emulator')) return getXTerminalCommand();

    // Check gnome app settings, if available
    if (GSettings.isAvailable()) {
        const gSettingsTerminalKey = GSettings.Key.findById(
            'org.gnome.desktop.default-applications.terminal', 'exec'
        );

        const defaultTerminal = gSettingsTerminalKey && gSettingsTerminalKey.getValue();
        if (defaultTerminal && await commandExists(defaultTerminal)) {
            if (defaultTerminal.includes('gnome-terminal')) return getGnomeTerminalCommand(defaultTerminal);
            if (defaultTerminal.includes('konsole')) return getKonsoleTerminalCommand(defaultTerminal);
            if (defaultTerminal.includes('xfce4-terminal')) return getXfceTerminalCommand(defaultTerminal);
            if (defaultTerminal.includes('x-terminal-emulator')) return getXTerminalCommand(defaultTerminal);
            if (defaultTerminal.includes('terminator')) return { command: 'terminator', args: ['-u'] };
            return { command: defaultTerminal };
        }
    }

    // If a specific term like this is installed, it's probably the preferred one
    if (await commandExists('konsole')) return getKonsoleTerminalCommand();
    if (await commandExists('xfce4-terminal')) return getXfceTerminalCommand();
    if (await commandExists('kitty')) return { command: 'kitty' };
    if (await commandExists('urxvt')) return { command: 'urxvt' };
    if (await commandExists('rxvt')) return { command: 'rxvt' };
    if (await commandExists('termit')) return { command: 'termit' };
    if (await commandExists('terminator')) return { command: 'terminator', args: ['-u'] };
    if (await commandExists('alacritty')) return { command: 'alacritty' };
    if (await commandExists('uxterm')) return { command: 'uxterm' };
    if (await commandExists('xterm')) return { command: 'xterm' };

    return null;
};

const getXTerminalCommand = async (command = 'x-terminal-emulator'): Promise<SpawnArgs> => {
    // x-terminal-emulator is a wrapper/symlink to the terminal of choice.
    // Unfortunately, we need to pass specific args that aren't supported by all terminals (to ensure
    // terminals run in the foreground), and the Debian XTE wrapper at least doesn't pass through
    // any of the args we want to use. To fix this, we parse --help to try and detect the underlying
    // terminal, and run it directly with the args we need.
    try {
        // Run the command with -h to get some output we can use to infer the terminal itself.
        // --version would be nice, but the debian wrapper ignores it. --help isn't supported by xterm.
        const { stdout } = await spawnToResult(command, ['-h']);
        const helpOutput = stdout.toLowerCase().replace(/[^\w\d]+/g, ' ');

        if (helpOutput.includes('gnome terminal') && await commandExists('gnome-terminal')) {
            return getGnomeTerminalCommand();
        } else if (helpOutput.includes('xfce4 terminal') && await commandExists('xfce4-terminal')) {
            return getXfceTerminalCommand();
        } else if (helpOutput.includes('konsole') && await commandExists('konsole')) {
            return getKonsoleTerminalCommand();
        }
    } catch (e) {
        if (isErrorLike(e) && e.message?.includes('rxvt')) {
            // Bizarrely, rxvt -h prints help but always returns a non-zero exit code.
            // Doesn't need any special arguments anyway though, so just ignore it
        } else {
            reportError(e);
        }
    }

    // If there's an error, or we just don't recognize the console, give up & run it directly
    return { command };
};

const getKonsoleTerminalCommand = async (command = 'konsole'): Promise<SpawnArgs> => {
    let extraArgs: string[] = [];

    const { stdout } = await spawnToResult(command, ['--help']);

    // Forces Konsole to run in the foreground, with no separate process
    // Seems to be well supported for a long time, but check just in case
    if (stdout.includes('--nofork')) {
        extraArgs = ['--nofork'];
    }

    return { command, args: extraArgs };
};

const getGnomeTerminalCommand = async (command = 'gnome-terminal'): Promise<SpawnArgs> => {
    let extraArgs: string[] = [];

    const { stdout } = await spawnToResult(command, ['--help-all']);

    // Officially supported option, but only supported in v3.28+
    if (stdout.includes('--wait')) {
        extraArgs = ['--wait'];
    } else {
        // Debugging option - works back to v3.7 (2012), but not officially supported
        // Documented at https://wiki.gnome.org/Apps/Terminal/Debugging
        const randomId = Math.round((Math.random() * 100000));
        extraArgs = ['--app-id', `com.httptoolkit.${randomId}`];
    }

    // We're assuming here that nobody is developing in a pre-2012 un-updated gnome-terminal.
    // If they are then gnome-terminal is not going to recognize --app-id, and will fail to
    // start. Hard to avoid, rare case, so c'est la vie.

    return { command, args: extraArgs };
};

const getXfceTerminalCommand = async (command = 'xfce4-terminal'): Promise<SpawnArgs> => {
    let extraArgs: string[] = [];

    const { stdout } = await spawnToResult(command, ['--help']);

    // Disables the XFCE terminal server for this terminal, so it runs in the foreground.
    // Seems to be well supported for a long time, but check just in case
    if (stdout.includes('--disable-server')) {
        extraArgs = ['--disable-server'];
    }

    return { command, args: extraArgs };
};

const terminals: _.Dictionary<ChildProcess[] | undefined> = {}

export class FreshTerminalInterceptor implements Interceptor {

    id = 'fresh-terminal';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    async isActivable(): Promise<boolean> {
        return !!(await getTerminalCommand());
    }

    isActive(proxyPort: number | string): boolean {
        return !!(terminals[proxyPort] && terminals[proxyPort]!.length);
    }

    async activate(proxyPort: number): Promise<void> {
        const terminalSpawnArgs = await getTerminalCommand();
        if (!terminalSpawnArgs) throw new Error('Could not find a suitable terminal');

        const { command, args, options, skipStartupScripts } = terminalSpawnArgs;

        // Our PATH override below may not work, e.g. because OSX's path_helper always prepends
        // the real paths over the top, and git-bash ignore env var paths overrides. To fix this,
        // we (very carefully!) rewrite shell startup scripts, to reset the PATH in our shell.
        // This gets reset on exit, and is behind a flag so it won't affect other shells anyway.
        if (!skipStartupScripts) await editShellStartupScripts();

        const currentEnv = (process.platform === 'win32')
            // Windows env var behaviour is very odd. Windows env vars are case-insensitive, and node
            // simulates this for process.env accesses, but when used in an object they become
            // case-*sensitive* object keys, and it's easy to end up with duplicates.
            // To fix this, on Windows we enforce here that all env var input keys are uppercase.
            ? _.mapKeys(process.env, (_value, key) => key.toUpperCase())
            : process.env;

        const childProc = spawn(
            command,
            (args || []),
            _.assign(options || {}, {
                env: {
                    ...currentEnv,
                    ...getTerminalEnvVars(proxyPort, this.config.https, currentEnv, {}),
                },
                cwd: currentEnv.HOME || currentEnv.USERPROFILE
            })
        );

        terminals[proxyPort] = (terminals[proxyPort] || []).concat(childProc);

        const onTerminalClosed = () => {
            terminals[proxyPort] = _.reject(terminals[proxyPort], childProc);

            // Delay slightly as some terminals (gnome-terminal) exit immediately,
            // and start the terminal elsewhere, so it may not have started yet.
            setTimeout(() => {
                if (_.every(terminals, ts => _.isEmpty(ts))) resetShellStartupScripts();
            }, 500);
        };
        childProc.once('close', onTerminalClosed);
        childProc.once('error', (e) => {
            reportError(e);
            onTerminalClosed();
        });

        // Watch for spawn errors immediately after startup to judge whether the
        // terminal launch was actually successful:
        return new Promise((resolve, reject) => {
            setTimeout(resolve, 500); // If it doesn't crash within 500ms, it's probably good
            childProc.once('error', reject) // If it does crash, it's definitely not.
        });
    }

    async deactivate(proxyPort: number | string): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all((terminals[proxyPort] || []).map((proc) => {
            return new Promise((resolve) => {
                proc.once('close', resolve);
                proc.kill();
            });
        }));
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(terminals).map((proxyPort) => this.deactivate(proxyPort))
        );

        await resetShellStartupScripts();
    }
}