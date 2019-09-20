// Import types only from TS
import * as ErrorTrackingModule from '../error-tracking';
import * as IndexTypeModule from '../index';

import { IS_PROD_BUILD } from '../util';

function maybeBundleImport<T>(moduleName: string): T {
    if (IS_PROD_BUILD || process.env.OCLIF_TS_NODE === '0') {
        // Full package: try to explicitly load the bundle
        try {
            return require('../../bundle/' + moduleName);
        } catch (e) {
            // Fallback (bundle is included in real package)
            console.log(`Could not load bundle ${moduleName}, loading raw`);
            return require('../' + moduleName);
        }
    } else {
        // Npm or dev: run the raw code
        return require('../' + moduleName);
    }
}
const { initErrorTracking } = maybeBundleImport<typeof ErrorTrackingModule>('error-tracking');
initErrorTracking();

import { Command, flags } from '@oclif/command'

const { runHTK } = maybeBundleImport<typeof IndexTypeModule>('index');

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
