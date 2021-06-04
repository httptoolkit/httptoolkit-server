import { ProxyConfig } from 'mockttp';
import getWindowsProxy = require('@cypress/get-windows-proxy');
import { getMacSystemProxy, MacProxySettings } from 'mac-system-proxy';

import { reportError } from './error-tracking';

export async function getSystemProxyConfig(): Promise<ProxyConfig | undefined> {
    if (process.platform === 'win32') {
        const proxySettings = getWindowsProxy();
        if (!proxySettings || !proxySettings.httpProxy) return undefined;
        else return {
            proxyUrl: proxySettings.httpProxy,
            noProxy: proxySettings.noProxy
                ? proxySettings.noProxy.split(',')
                : []
        };
    } else if (process.platform === 'darwin') {
        const proxySettings = await getMacSystemProxy().catch((e) => {
            reportError(e);
            return {} as MacProxySettings;
        });

        const noProxy = proxySettings.ExceptionsList;

        if (proxySettings.HTTPSEnable && proxySettings.HTTPSProxy && proxySettings.HTTPSPort) {
            return {
                proxyUrl: `https://${proxySettings.HTTPSProxy}:${proxySettings.HTTPSPort}`,
                noProxy
            };
        } else if (proxySettings.HTTPEnable && proxySettings.HTTPProxy && proxySettings.HTTPPort) {
            return {
                proxyUrl: `http://${proxySettings.HTTPProxy}:${proxySettings.HTTPPort}`,
                noProxy
            };
        } else if (proxySettings.SOCKSEnable && proxySettings.SOCKSProxy && proxySettings.SOCKSPort) {
            return {
                proxyUrl: `socks://${proxySettings.SOCKSProxy}:${proxySettings.SOCKSPort}`,
                noProxy
            };
        } else {
            return undefined;
        }
    } else {
        const {
            HTTPS_PROXY,
            https_proxy,
            HTTP_PROXY,
            http_proxy,
            NO_PROXY,
            no_proxy
        } = process.env;

        const proxyUrl = HTTPS_PROXY || HTTP_PROXY || https_proxy || http_proxy;

        if (!proxyUrl) return undefined;

        const noProxy = !!(NO_PROXY || no_proxy)
            ? (NO_PROXY || no_proxy)!.split(',')
            : undefined;

        return {
            proxyUrl,
            noProxy
        };
    }
}