import * as _ from 'lodash';
import * as url from 'url';
import type * as http from 'http';

import type * as Mockttp from 'mockttp';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { PacProxyAgent } from 'pac-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

// We reuse Mockttp's stable proxy-resolution helpers, so that proxy selection here
// matches normal passthrough behaviour exactly:
import { getProxySetting, matchesNoProxy } from 'mockttp/dist/rules/proxy-config';
import { getTrustedCAs } from 'mockttp/dist/rules/passthrough-handling';

import { ClientProxyConfig, RULE_PARAM_REF_KEY } from './client-types';

export type RuleParameters = {
    [key: string]: Mockttp.ProxySettingCallback | undefined
};

/**
 * Resolve the externally-provided proxy config into a Mockttp ProxySettingSource,
 * dereferencing any rule parameter references (used for Docker proxying) against the
 * configured rule parameters.
 */
export function getProxyConfig(
    proxyConfig: ClientProxyConfig,
    ruleParameters: RuleParameters
): Mockttp.ProxySettingSource {
    if (!proxyConfig) return undefined;

    if (_.isArray(proxyConfig)) {
        return proxyConfig.map((config) => getProxyConfig(config, ruleParameters));
    }

    if (RULE_PARAM_REF_KEY in proxyConfig) {
        const referencedConfig = ruleParameters[proxyConfig[RULE_PARAM_REF_KEY]];
        if (!referencedConfig) {
            throw new Error('Request options referenced unrecognized rule parameter in proxy config');
        }
        return referencedConfig;
    }

    return proxyConfig;
}

/**
 * Build the HTTP agent to use for an upstream request, given the proxy configuration.
 *
 * This mirrors Mockttp's passthrough proxy handling, but deliberately omits its
 * per-connection keep-alive agent pooling: those agents are tied to the lifecycle of
 * a downstream proxy connection, which we don't have here. These are one-shot client
 * requests, so we make a fresh proxy agent (or none at all) each time and let the
 * connection close normally afterwards.
 *
 * Returns undefined when no proxy applies, so the request connects directly using
 * Node's default agent.
 */
export async function getUpstreamProxyAgent(options: {
    hostname: string,
    port: number,
    proxyConfig: ClientProxyConfig,
    ruleParameters: RuleParameters
}): Promise<http.Agent | undefined> {
    const { hostname, port } = options;

    const proxySettingSource = getProxyConfig(options.proxyConfig, options.ruleParameters);
    const proxySetting = await getProxySetting(proxySettingSource, { hostname });

    if (
        !proxySetting?.proxyUrl ||
        matchesNoProxy(hostname, port, proxySetting.noProxy)
    ) {
        return undefined;
    }

    const { href, protocol } = url.parse(proxySetting.proxyUrl);

    // If you specify trusted CAs, we override the CAs used for the connection to the
    // proxy itself (e.g. an HTTPS proxy's certificate). This is *not* the CAs trusted
    // for upstream servers on the other side of the proxy - that's configured separately.
    const trustedCAs = await getTrustedCAs(
        proxySetting.trustedCAs,
        proxySetting.additionalTrustedCAs
    );
    const caOptions = trustedCAs ? { ca: trustedCAs } : {};

    switch (protocol) {
        case 'http:':
        case 'https:':
            // HttpsProxyAgent handles both: it CONNECT-tunnels in either case.
            return new HttpsProxyAgent(href!, caOptions);
        case 'pac+http:':
        case 'pac+https:':
            return new PacProxyAgent(href!, caOptions);
        case 'socks:':
        case 'socks4:':
        case 'socks4a:':
        case 'socks5:':
        case 'socks5h:':
            // SOCKS proxies don't do TLS to the proxy, so trusted CAs don't apply.
            return new SocksProxyAgent(href!);
        default:
            throw new Error(`Unsupported proxy protocol: ${protocol}`);
    }
}
