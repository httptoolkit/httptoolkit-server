
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
        return Promise.resolve(true);
    }

    isActive(proxyPort: number): boolean {
        const serverState = this.servers[proxyPort];
        return !!serverState && serverState.isActive;
    }

    async activate(proxyPort: number): Promise<{ port: number }> {
        if (this.servers[proxyPort]) {
            return { port: this.servers[proxyPort].server.port };
        }

        const server = getLocal();
        await server.start({ startPort: proxyPort + 1, endPort: 65535 });

        const envVars = getTerminalEnvVars(proxyPort, this.config.https, 'runtime-inherit');
        const setupScript = getShellScript(envVars);

        const serverState = { server, isActive: false };
        await server
            .get('/setup')
            .thenCallback(() => {
                serverState.isActive = true;
                return {
                    status: 200,
                    headers: { "content-type": "text/x-shellscript" },
                    body: setupScript
                };
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