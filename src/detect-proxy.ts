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
        } else if (proxySettings.SOCKSEnable && proxySettings.SOCKSProxy && proxySettings.SOCKSProxy) {
            return {
                proxyUrl: `socks://${proxySettings.SOCKSProxy}:${proxySettings.SOCKSProxy}`,
                noProxy
            };
        } else {
            return undefined;
        }
    } else {
        const proxyUrl = process.env.HTTPS_PROXY ||
            process.env.HTTP_PROXY ||
            process.env.https_proxy ||
            process.env.http_proxy;

        if (!proxyUrl) return undefined;

        const noProxy = process.env.NO_PROXY
            ? process.env.NO_PROXY.split(',')
            : undefined;

        return {
            proxyUrl,
            noProxy
        };
    }
}