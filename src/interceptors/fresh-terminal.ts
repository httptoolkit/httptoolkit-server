import * as _ from 'lodash';
import * as fs from 'fs';
import * as util from 'util';
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';
import * as commandExists from 'command-exists';

import findOsxExecutableCb = require('osx-find-executable');
const findOsxExecutable = util.promisify(findOsxExecutableCb);

import { Interceptor } from '.';
import { HtkConfig } from '../config';

const checkAccess = util.promisify(fs.access);
const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

const DEFAULT_GIT_BASH_PATH = 'C:/Program Files/git/git-bash.exe';

interface SpawnArgs {
    command: string;
    args?: string[];
    options?: SpawnOptions;
}

const getTerminalCommand = _.memoize(async (): Promise<SpawnArgs | null> => {
    if (process.platform === 'win32') {
        if (await commandExists('git-bash').catch(() => false)) {
            return { command: 'git-bash' };
        } else if (await canAccess(DEFAULT_GIT_BASH_PATH)) {
            return { command: DEFAULT_GIT_BASH_PATH };
        } else {
            return { command: 'start', args: ['cmd'], options: { shell: true } };
        }
    } else if (process.platform === 'linux') {
        if (GSettings.isAvailable()) {
            const gSettingsTerminalKey = GSettings.Key.findById(
                'org.gnome.desktop.default-applications.terminal', 'exec'
            );

            const defaultTerminal = gSettingsTerminalKey && gSettingsTerminalKey.getValue();
            if (defaultTerminal) return { command: defaultTerminal };
        }

        if (await commandExists('xterm').catch(() => false)) {
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

        const { command, args, options } = terminalSpawnArgs;

        const childProc = spawn(command, args || [], _.assign(options || {}, {
            env: _.assign({
                'http_proxy': `http://localhost:${proxyPort}`,
                'HTTP_PROXY': `http://localhost:${proxyPort}`,
                'https_proxy': `http://localhost:${proxyPort}`,
                'HTTPS_PROXY': `http://localhost:${proxyPort}`,

                // Trust cert when using OpenSSL with default settings
                'SSL_CERT_FILE': this.config.https.certPath,
                // Trust cert when using Node 7.3.0+
                'NODE_EXTRA_CA_CERTS': this.config.https.certPath,
                // Trust cert when using Requests (Python)
                'REQUESTS_CA_BUNDLE': this.config.https.certPath,
                // Trust cert when using Perl LWP
                'PERL_LWP_SSL_CA_FILE': this.config.https.certPath,
                // Trust cert for HTTPS requests from Git
                'GIT_SSL_CAINFO': this.config.https.certPath
            }, process.env),
            cwd: process.env.HOME || process.env.USERPROFILE
        }));

        terminals[proxyPort] = (terminals[proxyPort] || []).concat(childProc);

        childProc.once('exit', () => {
            terminals[proxyPort] = _.reject(terminals[proxyPort], childProc);
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