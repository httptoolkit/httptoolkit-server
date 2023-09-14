
import { Mockttp, getLocal } from 'mockttp';

import { Interceptor } from '..';
import { HtkConfig } from '../../config';
import { getTerminalEnvVars } from './terminal-env-overrides';
import { getBashShellScript, getFishShellScript, getGitBashShellScript, getPowerShellScript } from './terminal-scripts';

interface ServerState {
    server: Mockttp;
    isActive: boolean;
}

type ShellDefinition = { command: string, description: string };

const getBashDefinition = (port: number) => ({
    description: "Bash-compatible",
    command: `eval "$(curl -sS localhost:${port}/setup)"`
});

const getGitBashDefinition = (port: number) => ({
    description: "Git Bash",
    command: `eval "$(curl -sS localhost:${port}/gb-setup)"`
});

const getFishDefinition = (port: number) => ({
    description: "Fish",
    command: `curl -sS localhost:${port}/fish-setup | source`
});

const getPowershellDefinition = (port: number) => ({
    description: "Powershell",
    command: `Invoke-Expression (Invoke-WebRequest http://localhost:${port}/ps-setup).Content`
});

function getShellCommands(port: number): { [shellName: string]: ShellDefinition } {
    if (process.platform === 'win32') {
        return {
            'Powershell': getPowershellDefinition(port),
            'Git Bash': getGitBashDefinition(port)
        }
    } else {
        return {
            'Bash': getBashDefinition(port),
            'Fish': getFishDefinition(port),
            'Powershell': getPowershellDefinition(port)
        };
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
        return Promise.resolve(true);
    }

    isActive(proxyPort: number): boolean {
        return this.servers[proxyPort]?.isActive ?? false;
    }

    async activate(proxyPort: number): Promise<{ port: number, commands: { [shellName: string]: ShellDefinition } }> {
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

        const serverState = { server, isActive: false };

        const posixEnvVars = getTerminalEnvVars(proxyPort, this.config.https, 'posix-runtime-inherit');

        // Endpoints for each of the various setup scripts:
        await server.forGet('/setup').thenReply(200,
            getBashShellScript(server.urlFor('/success'), posixEnvVars),
            { "content-type": "text/x-shellscript" }
        );
        await server.forGet('/gb-setup').thenReply(200,
            getGitBashShellScript(server.urlFor('/success'), posixEnvVars),
            { "content-type": "text/x-shellscript" }
        );
        await server.forGet('/fish-setup').thenReply(200,
            getFishShellScript(server.urlFor('/success'), posixEnvVars),
            { "content-type": "application/x-fish" }
        );

        const powerShellEnvVars = getTerminalEnvVars(proxyPort, this.config.https, 'powershell-runtime-inherit');
        await server.forGet('/ps-setup').thenReply(200,
            getPowerShellScript(server.urlFor('/success'), powerShellEnvVars),
            { "content-type": "text/plain" }
        );

        // A success endpoint, so we can mark this as active (which provides some helpful UX on the frontend)
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