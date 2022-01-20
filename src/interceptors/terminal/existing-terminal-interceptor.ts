
import { Mockttp, getLocal } from 'mockttp';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { getTerminalEnvVars } from './terminal-env-overrides';
import { getShellScript } from './terminal-scripts';

interface ServerState {
    server: Mockttp;
    isActive: boolean;
}

export class ExistingTerminalInterceptor implements Interceptor {

    private servers: {
        [proxyPort: number]: ServerState
    } = {};

    id = 'existing-terminal';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActivable(): Promise<boolean> {
        // Not supported on Windows, for now. Doesn't work in cmd or powershell of course (needs bash),
        // and doesn't work in git bash/WSL due to path transforms. Fixable, I think, but not easily.
        return Promise.resolve(process.platform !== 'win32');
    }

    isActive(proxyPort: number): boolean {
        const serverState = this.servers[proxyPort];
        return !!serverState && serverState.isActive;
    }

    async activate(proxyPort: number): Promise<{ port: number }> {
        if (this.servers[proxyPort]) {
            // Reset isActive, so we wait again for a new request
            this.servers[proxyPort].isActive = false;
            return { port: this.servers[proxyPort].server.port };
        }

        const server = getLocal();
        await server.start({ startPort: proxyPort + 1, endPort: 65535 });

        const envVars = getTerminalEnvVars(proxyPort, this.config.https, 'runtime-inherit', {});
        const setupScript = getShellScript(server.urlFor('/success'), envVars);

        const serverState = { server, isActive: false };

        await server.get('/setup').thenCallback(() => {
            return {
                status: 200,
                headers: { "content-type": "text/x-shellscript" },
                body: setupScript
            };
        });

        await server.post('/success').thenCallback(() => {
            serverState.isActive = true;
            return { status: 200 };
        });

        this.servers[proxyPort] = serverState;
        return { port: server.port };
    }

    async deactivate(proxyPort: number): Promise<void> {
        if (this.servers[proxyPort]) {
            await this.servers[proxyPort].server.stop();
            delete this.servers[proxyPort];
        }
    }

    deactivateAll(): Promise<void> {
        return Promise.all(
            Object.keys(this.servers).map((port) =>
                this.deactivate(parseInt(port, 10))
            )
        ).then(() => {});
    }

}