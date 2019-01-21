import * as _ from 'lodash';
import { spawn, ChildProcess } from 'child_process';
import * as GSettings from 'node-gsettings-wrapper';
import * as commandExists from 'command-exists';

import { Interceptor } from '.';
import { HtkConfig } from '../config';

const getTerminalCommand = _.memoize(async (): Promise<string | null> => {
    if (process.platform === 'win32') {
        return null; // Coming soon
    } else if (process.platform === 'linux') {
        if (GSettings.isAvailable()) {
            const defaultTerminal = GSettings.Key.findById('org.gnome.desktop.default-applications.terminal', 'exec').getValue();

            if (defaultTerminal) return defaultTerminal;
        } else if (await commandExists('xterm').catch(() => false)) {
            return 'xterm';
        }
    } else if (process.platform === 'darwin') {
        return null; // Coming soon
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
        const terminalCommand = await getTerminalCommand();
        if (!terminalCommand) throw new Error('Could not find a suitable terminal');

        const childProc = spawn(terminalCommand, [], {
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
        });

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