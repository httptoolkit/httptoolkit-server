import * as path from 'path';

import { Interceptor } from '.';
import { HtkConfig } from '../config';
import { canAccess, commandExists, sudo } from '../util';
import { markProxySettingsChanged } from '../windows';

const SYSTEM_ROOT = process.env.SYSTEMROOT as string; // Always defined *ON WINDOWS*
const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

async function getSystemCommand(name: string) {
    const rootPath = path.join(SYSTEM_ROOT, 'system32', `${name}.exe`);
    if (await canAccess(rootPath)) {
        return rootPath;
    } else if (await commandExists(name)) {
        return name;
    } else {
        throw new Error(`Could not find ${name} command`);
    }
}

const hasSystemCommand = (name: string) => getSystemCommand(name).then(() => true).catch(() => false);

export class SystemInterceptor implements Interceptor {

    private activePort: number | undefined = undefined;

    id = 'system';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    async isActivable(): Promise<boolean> {
        return process.platform === 'win32' && (await hasSystemCommand('certutil')) && (await hasSystemCommand('reg'));
    }

    isActive(proxyPort: number): boolean {
        return this.activePort === proxyPort;
    }

    async activate(proxyPort: number): Promise<void> {
        const [certUtil, reg, netSh] = await Promise.all([
            'certUtil', 'reg', 'netsh'
        ].map(getSystemCommand));

        // Insert the certificate into the root cert store (this will prompt for admin permissions)
        // Set the proxy address in the registry, drop any proxy-excluded addresses, then activate the proxy
        await sudo([
            `${certUtil} -addstore Root "${this.config.https.certPath}"`,
            `${reg} add "${REG_KEY}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${proxyPort}" /f`,
            `${reg} delete "${REG_KEY}" /v ProxyOverride /f`,
            `${reg} add "${REG_KEY}" /v ProxyEnable /t REG_DWORD /d 1 /f`,
            `${netSh} winhttp import proxy source=ie`
        ].join(" & "), {
            name: this.config.appName
        });

        await markProxySettingsChanged();
    }

    async deactivate(): Promise<void> { }
    async deactivateAll(): Promise<void> { }

}