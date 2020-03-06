import * as path from 'path';

import { Interceptor } from '.';
import { HtkConfig } from '../config';
import { canAccess, commandExists, sudo } from '../util';

const SYSTEM_ROOT = process.env.SYSTEMROOT as string; // Always defined *ON WINDOWS*

async function getCertUtilPath() {
    const rootPath = path.join(SYSTEM_ROOT, 'system32', 'certutil.exe');
    if (await canAccess(rootPath)) {
        return rootPath;
    } else if (await commandExists('certutil')) {
        return 'certutil';
    } else {
        throw new Error("Could not find certutil command");
    }
}

export class SystemInterceptor implements Interceptor {

    private activePort: number | undefined = undefined;

    id = 'system';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    async isActivable(): Promise<boolean> {
        return process.platform === 'win32';
    }

    isActive(proxyPort: number): boolean {
        return this.activePort === proxyPort;
    }

    async activate(proxyPort: number): Promise<void> {
        // Insert the certificate into the root cert store (this will prompt for admin permissions)
        await sudo(`${await getCertUtilPath()}  -addstore Root "${this.config.https.certPath}"`, {
            name: this.config.appName
        });

        // TODO: automatically set up the proxy in the registry:
        // HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
        // Set ProxyEnable 1, ProxyServer host:port
    }

    async deactivate(): Promise<void> { }
    async deactivateAll(): Promise<void> { }

}