import { initErrorTracking } from '../error-tracking';
initErrorTracking();

import { IS_PROD_BUILD } from '../util';

import { Command, flags } from '@oclif/command'

import { runHTK as runHTKFunction } from '../index';

let runHTK: typeof runHTKFunction;
if (IS_PROD_BUILD || process.env.OCLIF_TS_NODE === '0') {
    // Full package: try to explicitly load the bundle
    try {
        ({ runHTK } = require('../../bundle/index'));
    } catch (e) {
        // Fallback (bundle is not yet included in real package)
        console.log('Could not load bundle, loading raw');
        ({ runHTK } = require('../index'));
    }
} else {
    // Npm or dev: run the raw code
    ({ runHTK } = require('../index'));
}

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
