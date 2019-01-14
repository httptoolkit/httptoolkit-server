import * as Sentry from '@sentry/node';

const packageJson = require('../../package.json');
let { SENTRY_DSN } = process.env;
if (!SENTRY_DSN && process.env.HTTPTOOLKIT_SERVER_BINPATH) {
    // If we're a built binary, use the standard DSN automatically
    SENTRY_DSN = 'https://f6775276f60042bea6d5e951ca1d0e91@sentry.io/1371158';
}

if (SENTRY_DSN) {
    Sentry.init({ dsn: SENTRY_DSN, release: packageJson.version });
}

import { Command, flags } from '@oclif/command'
import { runHTK } from '../index';

class HttpToolkitServer extends Command {
    static description = 'start the HTTP Toolkit server'

    static flags = {
        version: flags.version({char: 'v'}),
        help: flags.help({char: 'h'}),

        config: flags.string({char: 'c', description: 'path in which to store config files'}),
    }

    async run() {
        const { flags } = this.parse(HttpToolkitServer);

        await runHTK({ configPath: flags.config });
    }
}

export = HttpToolkitServer;
