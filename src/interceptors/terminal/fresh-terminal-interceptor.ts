import _ from 'lodash';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';

import { isErrorLike } from '@httptoolkit/util';
import { findExecutableById } from '@httptoolkit/osx-find-executable';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { logError, addBreadcrumb } from '../../error-tracking';
import { canAccess, commandExists, getRealPath, resolveCommandPath } from '../../util/fs';
import { spawnToResult } from '../../util/process-management';

import { getInheritableCurrentEnv, getTerminalEnvVars } from './terminal-env-overrides';
import { editShellStartupScripts, resetShellStartupScripts } from './terminal-scripts';

const DEFAULT_GIT_BASH_PATH = 'C:/Program Files/git/git-bash.exe';

interface SpawnArgs {
    command: string;
    args?: string[];
    options?: SpawnOptions;
    skipStartupScripts?: true;
    envVars?: {
        [key: string]: string;
    };
}

const getTerminalCommand = _.memoize(async (): Promise<SpawnArgs | null> => {
    let result: Promise<SpawnArgs | null>;

    if (process.platform === 'win32') result = getWindowsTerminalCommand();
    else if (process.platform === 'darwin') result = getOSXTerminalCommand();
    else if (process.platform === 'linux') result = getLinuxTerminalCommand();
    else result = Promise.resolve(null);

    result.then((terminal) => {
        if (terminal) {
            console.log(`Detected terminal command: ${terminal.command}`);
            addBreadcrumb('Found terminal', { data: { terminal } });
        }
        else logError('No terminal could be detected');
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
            if (defaultTerminal.includes('kgx')) return getKgxCommand(defaultTerminal);
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
    if (await commandExists('kgx')) return getKgxCommand();
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

const getKgxCommand = async (command = 'kgx'): Promise<SpawnArgs> => {
    return { command, envVars: { DBUS_SESSION_BUS_ADDRESS: '' } };
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

const X_TERMINAL_MATCHERS = [
    { helpString: 'gnome terminal', command: 'gnome-terminal', commandBuilder: getGnomeTerminalCommand },
    { helpString: 'xfce4 terminal', command: 'xfce4-terminal', commandBuilder: getXfceTerminalCommand },
    { helpString: 'konsole', command: 'konsole', commandBuilder: getKonsoleTerminalCommand },
    { helpString: 'kgx', command: 'kgx', commandBuilder: getKgxCommand }
] as const;

const getXTerminalCommand = async (command = 'x-terminal-emulator'): Promise<SpawnArgs> => {
    // x-terminal-emulator is a wrapper/symlink to the terminal of choice.
    // Unfortunately, we need to pass specific args that aren't supported by all terminals (to ensure
    // terminals run in the foreground), and the Debian XTE wrapper at least doesn't pass through
    // any of the args we want to use. To fix this, we parse --help to try and detect the underlying
    // terminal, and run it directly with the args we need.
    try {
        // In parallel, get the command's help output, and its real resolved path on disk:
        const [helpOutput, commandPath] = await Promise.all([
            // Run the command with -h to get some output we can use to infer the terminal itself.
            // --version would be nice, but the debian wrapper ignores it. --help isn't supported by xterm.
            spawnToResult(command, ['-h'])
                .then(({ stdout }) => stdout.toLowerCase().replace(/[^\w\d]+/g, ' ')),
            // We find the command in PATH, and then follow any symbolic links, and see what the real
            // underlying path is:
            resolveCommandPath(command)
                .then((path) => { if (path) return getRealPath(path) })
        ]);

        for (let terminalPattern of X_TERMINAL_MATCHERS) {
            // We match the help output or command path for known strings:
            if (
                !helpOutput.includes(terminalPattern.helpString) &&
                !commandPath?.includes(command)
            ) continue;

            // If found, we use the terminal _if_ it exists globally with our expected command.
            // We can't use 'command' directly, because some terms (gnome-terminal, Debian generally)
            // use weird wrappers that don't behave properly.
            if (await commandExists(terminalPattern.command)) {
                return terminalPattern.commandBuilder();
            }
        }
    } catch (e) {
        if (isErrorLike(e) && e.message?.includes('rxvt')) {
            // Bizarrely, rxvt -h prints help but always returns a non-zero exit code.
            // Doesn't need any special arguments anyway though, so just ignore it
        } else {
            logError(e);
        }
    }

    // If there's an error, or we just don't recognize the console, give up & run it directly:
    return { command };
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

        const { command, args, options, skipStartupScripts, envVars } = terminalSpawnArgs;

        // Our PATH override below may not work, e.g. because OSX's path_helper always prepends
        // the real paths over the top, and git-bash ignore env var paths overrides. To fix this,
        // we (very carefully!) rewrite shell startup scripts, to reset the PATH in our shell.
        // This gets reset on exit, and is behind a flag so it won't affect other shells anyway.
        if (!skipStartupScripts) await editShellStartupScripts();

        const currentEnv = getInheritableCurrentEnv();

        const childProc = spawn(
            command,
            (args || []),
            _.assign(options || {}, {
                env: {
                    ...currentEnv,
                    ...getTerminalEnvVars(proxyPort, this.config.https, currentEnv),
                    ...envVars,
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
            logError(e);
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
