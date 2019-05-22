import * as _ from 'lodash';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';
import * as ensureCommandExists from 'command-exists';

import findOsxExecutableCb = require('osx-find-executable');
const findOsxExecutable = util.promisify(findOsxExecutableCb);

import { Interceptor } from '.';
import { HtkConfig } from '../config';
import { reportError } from '../error-tracking';

const checkAccess = util.promisify(fs.access);
const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

const commandExists = (path: string): Promise<boolean> => ensureCommandExists(path).then(() => true).catch(() => false);

const DEFAULT_GIT_BASH_PATH = 'C:/Program Files/git/git-bash.exe';
const PATH_VAR_SEPARATOR = process.platform === 'win32' ? ';' : ':';
const SHELL = (process.env.SHELL || '').split('/').slice(-1)[0];

const OVERRIDE_BIN_PATH = path.join(__dirname, 'terminal-wrappers');
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

const getTerminalCommand = _.memoize(async (): Promise<SpawnArgs | null> => {
    if (process.platform === 'win32') {
        if (await commandExists('git-bash')) {
            return { command: 'git-bash' };
        } else if (await canAccess(DEFAULT_GIT_BASH_PATH)) {
            return { command: DEFAULT_GIT_BASH_PATH };
        } else {
            return { command: 'start', args: ['cmd'], options: { shell: true }, skipStartupScripts: true };
        }
    } else if (process.platform === 'linux') {
        if (GSettings.isAvailable()) {
            const gSettingsTerminalKey = GSettings.Key.findById(
                'org.gnome.desktop.default-applications.terminal', 'exec'
            );

            const defaultTerminal = gSettingsTerminalKey && gSettingsTerminalKey.getValue();
            if (defaultTerminal && await commandExists(defaultTerminal)) {
                return { command: defaultTerminal };
            }
        }

        if (await commandExists('xterm')) {
            return { command: 'xterm' };
        }
    } else if (process.platform === 'darwin') {
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
        if (bestAvailableTerminal) {
            return { command: bestAvailableTerminal };
        }
    }

    return null;
});

// Works in bash, zsh, dash, ksh, sh (not fish)
const SH_SHELL_PATH_CONFIG = `
# Do not edit (all lines including $HTTP_TOOLKIT_ACTIVE will be removed automatically)
if [ -n "$HTTP_TOOLKIT_ACTIVE" ]; then export PATH="${OVERRIDE_BIN_PATH}:$PATH"; fi`;
const FISH_SHELL_PATH_CONFIG = `
# Do not edit (all lines including $HTTP_TOOLKIT_ACTIVE will be removed automatically)
[ -n "$HTTP_TOOLKIT_ACTIVE" ]; and set -x PATH "${OVERRIDE_BIN_PATH}" $PATH;`;
// Used to remove these lines from the config later
const SHELL_PATH_CONFIG_MATCHER = /.*\$HTTP_TOOLKIT_ACTIVE.*/;

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

// Find the relevant user shell config file, add the above line to it, so that
// shells launched with HTTP_TOOLKIT_ACTIVE set use the interception PATH.
const editShellStartupScripts = async () => {
    await resetShellStartupScripts();

    // .profile is used by Dash, Bash sometimes, and by Sh:
    appendOrCreateFile(path.join(os.homedir(), '.profile'), SH_SHELL_PATH_CONFIG)
        .catch(reportError);

    // Bash uses some other files by preference, if they exist:
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.bash_profile'),
            path.join(os.homedir(), '.bash_login')
        ],
        false, // Do nothing if they don't exist - it falls back to .profile
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
const removeMatchingInFile = async (path: string, matcher: RegExp) => {
    let fileLines: string[];

    try {
        fileLines = (await readFile(path, 'utf8')).split('\n');
    } catch (e) {
        // Silently skip any files we can't read
        return;
    }

    // Drop all matching lines from the config file
    fileLines = fileLines.filter(line => !matcher.test(line));
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
        removeMatchingInFile(configFile, SHELL_PATH_CONFIG_MATCHER)
        .catch(reportError)
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

    isActive(proxyPort: number): boolean {
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
            env: _.assign({}, process.env, {
                'http_proxy': `http://localhost:${proxyPort}`,
                'HTTP_PROXY': `http://localhost:${proxyPort}`,
                'https_proxy': `http://localhost:${proxyPort}`,
                'HTTPS_PROXY': `http://localhost:${proxyPort}`,
                // Used by some CGI engines to avoid 'httpoxy' vulnerability
                'CGI_HTTP_PROXY': `http://localhost:${proxyPort}`,

                // Trust cert when using OpenSSL with default settings
                'SSL_CERT_FILE': this.config.https.certPath,
                // Trust cert when using Node 7.3.0+
                'NODE_EXTRA_CA_CERTS': this.config.https.certPath,
                // Trust cert when using Requests (Python)
                'REQUESTS_CA_BUNDLE': this.config.https.certPath,
                // Trust cert when using Perl LWP
                'PERL_LWP_SSL_CA_FILE': this.config.https.certPath,
                // Trust cert for HTTPS requests from Git
                'GIT_SSL_CAINFO': this.config.https.certPath,

                'HTTP_TOOLKIT_ACTIVE': 'true',

                // Prepend our bin overrides into $PATH
                'PATH': `${OVERRIDE_BIN_PATH}${PATH_VAR_SEPARATOR}${process.env.PATH}`
            }),
            cwd: process.env.HOME || process.env.USERPROFILE
        }));

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

    async deactivate(proxyPort: number): Promise<void> {
        if (!this.isActive(proxyPort)) return;

        await Promise.all((terminals[proxyPort] || []).map((proc) => {
            return new Promise((resolve) => {
                proc.once('exit', resolve);
                proc.kill();
            });
        }));
    }

}