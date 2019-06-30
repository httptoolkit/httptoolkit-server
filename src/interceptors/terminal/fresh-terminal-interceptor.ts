import * as _ from 'lodash';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { spawn, exec, ChildProcess, SpawnOptions } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';
import * as ensureCommandExists from 'command-exists';

import findOsxExecutableCb = require('osx-find-executable');
const findOsxExecutable = util.promisify(findOsxExecutableCb);

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { reportError } from '../../error-tracking';
import { OVERRIDE_BIN_PATH, getTerminalEnvVars } from './terminal-env-overrides';

const checkAccess = util.promisify(fs.access);
const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

const commandExists = (path: string): Promise<boolean> => ensureCommandExists(path).then(() => true).catch(() => false);

const DEFAULT_GIT_BASH_PATH = 'C:/Program Files/git/git-bash.exe';
const SHELL = (process.env.SHELL || '').split('/').slice(-1)[0];

// Generate POSIX paths for git-bash on Windows (or use the normal path everywhere where)
const POSIX_OVERRIDE_BIN_PATH = process.platform === 'win32'
    ? OVERRIDE_BIN_PATH.replace(/\\/g, '/').replace(/^(\w+):/, (_all, driveLetter) => `/${driveLetter.toLowerCase()}`)
    : OVERRIDE_BIN_PATH;

interface SpawnArgs {
    command: string;
    args?: string[];
    options?: SpawnOptions;
    skipStartupScripts?: true;
}

const execAsync = (command: string): Promise<{ stdout: string, stderr: string }> => {
    return new Promise((resolve, reject) => {
        const childProc = exec(command, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
        childProc.once('error', reject);
    });
};

const getTerminalCommand = _.memoize(async (): Promise<SpawnArgs | null> => {
    if (process.platform === 'win32') return getWindowsTerminalCommand();
    else if (process.platform === 'darwin') return getOSXTerminalCommand();
    else if (process.platform === 'linux') return getLinuxTerminalCommand();
    else return null;
});

const getWindowsTerminalCommand = async (): Promise<SpawnArgs | null> => {
    if (await commandExists('git-bash')) {
        return { command: 'git-bash' };
    } else if (await canAccess(DEFAULT_GIT_BASH_PATH)) {
        return { command: DEFAULT_GIT_BASH_PATH };
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
            (bundleId) => findOsxExecutable(bundleId).catch(() => null)
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
            return { command: defaultTerminal };
        }
    }

    // If a specific term like this is installed, it's probably the preferred one
    if (await commandExists('konsole')) return getKonsoleTerminalCommand();
    if (await commandExists('xfce4-terminal')) return getXfceTerminalCommand();
    if (await commandExists('rxvt')) return { command: 'rxvt' };
    if (await commandExists('xterm')) return { command: 'xterm' };

    return null;
}

const getXTerminalCommand = async (command = 'x-terminal-emulator'): Promise<SpawnArgs> => {
    // x-terminal-emulator is a wrapper/symlink to the terminal of choice.
    // Unfortunately, we need to pass specific args that aren't supported by all terminals (to ensure
    // terminals run in the foreground), and the Debian XTE wrapper at least doesn't pass through
    // any of the args we want to use. To fix this, we parse --help to try and detect the underlying
    // terminal, and run it directly with the args we need.
    try {
        // Run the command with -h to get some output we can use to infer the terminal itself.
        // --version would be nice, but the debian wrapper ignores it. --help isn't supported by xterm.
        const { stdout } = await execAsync(`${command} -h`);
        const helpOutput = stdout.toLowerCase().replace(/[^\w\d]+/g, ' ');

        if (helpOutput.includes('gnome terminal') && await commandExists('gnome-terminal')) {
            return getGnomeTerminalCommand();
        } else if (helpOutput.includes('xfce4 terminal') && await commandExists('xfce4-terminal')) {
            return getXfceTerminalCommand();
        } else if (helpOutput.includes('konsole') && await commandExists('konsole')) {
            return getKonsoleTerminalCommand();
        }
    } catch (e) {
        if (e.message.includes('rxvt')) {
            // Bizarrely, rxvt -h prints help but always returns a non-zero exit code.
            // Doesn't need any special arguments anyway though, so just ignore it
        } else {
            reportError(e);
        }
    }

    // If there's an error, or we just don't recognize the console, give up & run it directly
    return { command: 'x-terminal-emulator' };
};

const getKonsoleTerminalCommand = async (command = 'konsole'): Promise<SpawnArgs> => {
    let extraArgs: string[] = [];

    const { stdout } = await execAsync(`${command} --help`);

    // Forces Konsole to run in the foreground, with no separate process
    // Seems to be well supported for a long time, but check just in case
    if (stdout.includes('--nofork')) {
        extraArgs = ['--nofork'];
    }

    return { command, args: extraArgs };
};

const getGnomeTerminalCommand = async (command = 'gnome-terminal'): Promise<SpawnArgs> => {
    let extraArgs: string[] = [];

    const { stdout } = await execAsync(`${command} --help-all`);

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

    const { stdout } = await execAsync(`${command} --help`);

    // Disables the XFCE terminal server for this terminal, so it runs in the foreground.
    // Seems to be well supported for a long time, but check just in case
    if (stdout.includes('--disable-server')) {
        extraArgs = ['--disable-server'];
    }

    return { command, args: extraArgs };
};

const appendOrCreateFile = util.promisify(fs.appendFile);
const appendToFirstExisting = async (paths: string[], forceWrite: boolean, contents: string) => {
    for (let path of paths) {
        // Small race here, but end result is ok either way
        if (await canAccess(path)) {
            return appendOrCreateFile(path, contents);
        }
    }

    if (forceWrite) {
        // If force write is set, write the last file anyway
        return appendOrCreateFile(paths.slice(-1)[0], contents);
    }
};

const START_CONFIG_SECTION = '# --httptoolkit--';
const END_CONFIG_SECTION = '# --httptoolkit-end--';

// Works in bash, zsh, dash, ksh, sh (not fish)
const SH_SHELL_PATH_CONFIG = `
${START_CONFIG_SECTION}
# This section will be reset each time a HTTP Toolkit terminal is opened
if [ -n "$HTTP_TOOLKIT_ACTIVE" ]; then
    # When HTTP Toolkit is active, we inject various overrides into PATH
    export PATH="${POSIX_OVERRIDE_BIN_PATH}:$PATH"

    if command -v winpty >/dev/null 2>&1; then
        # Work around for winpty's hijacking of certain commands
        alias php=php
    fi
fi
${END_CONFIG_SECTION}`;
const FISH_SHELL_PATH_CONFIG = `
${START_CONFIG_SECTION}
# This section will be reset each time a HTTP Toolkit terminal is opened
if [ -n "$HTTP_TOOLKIT_ACTIVE" ]
    # When HTTP Toolkit is active, we inject various overrides into PATH
    set -x PATH "${POSIX_OVERRIDE_BIN_PATH}" $PATH;

    if command -v winpty >/dev/null 2>&1
        # Work around for winpty's hijacking of certain commands
        alias php=php
    end
end
${END_CONFIG_SECTION}`;

// Find the relevant user shell config file, add the above line to it, so that
// shells launched with HTTP_TOOLKIT_ACTIVE set use the interception PATH.
const editShellStartupScripts = async () => {
    await resetShellStartupScripts();

    // The key risk here is that one of these scripts (or some other process) will be
    // overriding PATH itself, so we need to append some PATH reset logic. The main
    // offenders are: nvm config's in .bashrc/.bash_profile, OSX's path_helper and
    // git-bash ignoring the inherited $PATH.

    // .profile is used by Dash, Bash sometimes, and by Sh:
    appendOrCreateFile(path.join(os.homedir(), '.profile'), SH_SHELL_PATH_CONFIG)
        .catch(reportError);

    // Bash login shells use some other files by preference, if they exist.
    // Note that on OSX, all shells are login - elsewhere they only are at actual login time.
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.bash_profile'),
            path.join(os.homedir(), '.bash_login')
        ],
        false, // Do nothing if they don't exist - it falls back to .profile
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Bash non-login shells use .bashrc, if it exists:
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.bashrc')
        ],
        SHELL === 'bash', // If you use bash, we _always_ want to set this
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Zsh has its own files (both are actually used)
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.zshenv'),
            path.join(os.homedir(), '.zshrc')
        ],
        SHELL === 'zsh', // If you use zsh, we _always_ write a config file
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Fish always uses the same config file
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.config', 'fish', 'config.fish'),
        ],
        SHELL === 'fish' || await canAccess(path.join(os.homedir(), '.config', 'fish')),
        FISH_SHELL_PATH_CONFIG
    ).catch(reportError);
};

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const renameFile = util.promisify(fs.rename);
const removeConfigSectionsFromFile = async (path: string) => {
    let fileLines: string[];

    try {
        fileLines = (await readFile(path, 'utf8')).split('\n');
    } catch (e) {
        // Silently skip any files we can't read
        return;
    }

    // Remove everything between each pair of start/end section markers
    let sectionStart = _.findIndex(fileLines, (l) => l.startsWith(START_CONFIG_SECTION));
    while (sectionStart !== -1) {
        let sectionEnd = _.findIndex(fileLines, (l) => l.startsWith(END_CONFIG_SECTION));

        if (sectionEnd === -1 || sectionEnd <= sectionStart) return; // Odd config file state - don't edit it
        fileLines.splice(sectionStart, (sectionEnd - sectionStart) + 1);
        sectionStart = _.findIndex(fileLines, (l) => l.startsWith(START_CONFIG_SECTION));
    }

    // Write & rename to ensure this is atomic, and avoid races here
    // as much as we reasonably can.
    const tempFile = path + Date.now() + '.temp';
    await writeFile(tempFile, fileLines.join('\n'));
    return renameFile(tempFile, path);
};

// Cleanup: strip our extra config line from all config files
// Good to do for tidiness, not strictly necessary (the config does nothing
// unless HTTP_TOOLKIT_ACTIVE is set anyway).
const resetShellStartupScripts = () => {
    // For each possible config file, remove our magic line, if present
    return Promise.all([
        path.join(os.homedir(), '.profile'),
        path.join(os.homedir(), '.bash_profile'),
        path.join(os.homedir(), '.bash_login'),
        path.join(os.homedir(), '.zshenv'),
        path.join(os.homedir(), '.zshrc'),
        path.join(os.homedir(), '.config', 'fish', 'config.fish'),
    ].map((configFile) =>
        removeConfigSectionsFromFile(configFile).catch(reportError)
    ));
};

const terminals: _.Dictionary<ChildProcess[] | undefined> = {}

export class TerminalInterceptor implements Interceptor {

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

        const childProc = spawn(
            command,
            (args || []),
            _.assign(options || {}, {
                env: _.assign({}, process.env, getTerminalEnvVars(proxyPort, this.config.https)),
                cwd: process.env.HOME || process.env.USERPROFILE
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
        childProc.once('exit', onTerminalClosed);
        childProc.once('error', (e) => {
            reportError(e);
            onTerminalClosed();
        });
    }

    async deactivate(proxyPort: number | string): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all((terminals[proxyPort] || []).map((proc) => {
            return new Promise((resolve) => {
                proc.once('exit', resolve);
                proc.kill();
            });
        }));
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(terminals).map((proxyPort) => this.deactivate(proxyPort))
        );
    }

}