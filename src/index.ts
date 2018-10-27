import { Command, flags } from '@oclif/command'
import { runHTK } from './run-htk';

class HttpToolkitServer extends Command {
    static description = 'run the HTTP Toolkit server'

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
