
import { Mockttp, getLocal } from 'mockttp';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { getTerminalEnvVars } from './terminal-env-overrides';
import { getShellScript } from './terminal-scripts';

export class ExistingTerminalInterceptor implements Interceptor {

    private servers: { [proxyPort: number]: Mockttp } = {};

    id = 'existing-terminal';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActivable(): Promise<boolean> {
        return Promise.resolve(true);
    }

    isActive(proxyPort: number): boolean {
        return !!this.servers[proxyPort];
    }

    async activate(proxyPort: number): Promise<{ port: number }> {
        if (this.servers[proxyPort]) {
            return { port: this.servers[proxyPort].port };
        }

        const server = getLocal();
        await server.start({ startPort: proxyPort + 1, endPort: 65535 });

        const envVars = getTerminalEnvVars(proxyPort, this.config.https, 'runtime-inherit');
        const setupScript = getShellScript(envVars);
        server.get('/setup').thenReply(200, setupScript, { "content-type": "text/x-shellscript" });

        this.servers[proxyPort] = server;

        return { port: server.port };
    }

    async deactivate(proxyPort: number): Promise<void> {
        if (this.isActive(proxyPort)) {
            await this.servers[proxyPort].stop();
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