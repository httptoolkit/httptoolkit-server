
import { Mockttp, getLocal } from 'mockttp';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { getTerminalEnvVars } from './terminal-env-overrides';
import { getBashShellScript, getFishShellScript } from './terminal-scripts';

interface ServerState {
    server: Mockttp;
    isActive: boolean;
}

function getShellCommands(port: number) {
    return {
        'Bash': { command: `eval "$(curl -sS localhost:${port}/setup)"`, description: "Bash-compatible" },
        'Fish': { command: `curl -sS localhost:${port}/fish-setup | source`, description: "Fish" }
    }
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
        return this.servers[proxyPort]?.isActive ?? false;
    }

    async activate(proxyPort: number): Promise<{ port: number, commands: { [shellName: string]: { command: string, description: string } } }> {
        if (this.servers[proxyPort]) {
            // Reset isActive, so we wait again for a new request
            this.servers[proxyPort].isActive = false;
            const serverPort = this.servers[proxyPort].server.port;
            return {
                port: serverPort,
                commands: getShellCommands(serverPort)
            };
        }

        const server = getLocal();
        await server.start({ startPort: proxyPort + 1, endPort: 65535 });

        const envVars = getTerminalEnvVars(proxyPort, this.config.https, 'runtime-inherit', {});

        const serverState = { server, isActive: false };

        await server.forGet('/setup').thenReply(200,
            getBashShellScript(server.urlFor('/success'), envVars),
            { "content-type": "text/x-shellscript" }
        );
        await server.forGet('/fish-setup').thenReply(200,
            getFishShellScript(server.urlFor('/success'), envVars),
            { "content-type": "application/x-fish" }
        );

        await server.forPost('/success').thenCallback(() => {
            serverState.isActive = true;
            return { status: 200 };
        });

        this.servers[proxyPort] = serverState;
        return {
            port: server.port,
            commands: getShellCommands(server.port)
        };
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