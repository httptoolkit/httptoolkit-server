import * as _ from 'lodash';
import * as stream from 'stream';
import { LookupFunction } from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';

// We import lots of Mockttp internal passthrough logic, to ensure our
// upstream behaviour matches normal passthrough:
import type * as Mockttp from 'mockttp';
import {
    getDnsLookupFunction,
    shouldUseStrictHttps,
    getUpstreamTlsOptions as getUpstreamMockttpTlsOptions
} from 'mockttp/dist/rules/passthrough-handling';
import { getAgent } from 'mockttp/dist/rules/http-agents';
import { getEffectivePort } from 'mockttp/dist/util/request-utils';

import {
    ClientProxyConfig,
    RawHeaders,
    RequestDefinition,
    RequestOptions,
    RULE_PARAM_REF_KEY
} from './client-types';

export class HttpClient {

    constructor(
        private ruleParameters: {
            [key: string]: Mockttp.ProxySettingCallback | undefined
        }
    ) {}

    getProxyConfig(proxyConfig: ClientProxyConfig): Mockttp.ProxySettingSource {
        if (!proxyConfig) return undefined;

        if (_.isArray(proxyConfig)) {
            return proxyConfig.map((config) => this.getProxyConfig(config));
        }

        if (RULE_PARAM_REF_KEY in proxyConfig) {
            const referencedConfig = this.ruleParameters[proxyConfig[RULE_PARAM_REF_KEY]];
            if (!referencedConfig) {
                throw new Error('Request options referenced unrecognized rule parameter in proxy config');
            }
            return referencedConfig;
        }

        return proxyConfig;
    }

    readonly getDns = _.memoize((dnsServers: string[] | undefined) => {
        if (!dnsServers?.length) return undefined;
        return getDnsLookupFunction({ servers: dnsServers }) as LookupFunction;
    }, (dnsServers: string[] | undefined) =>
        // Quick & easy memoize key:
        JSON.stringify(dnsServers)
    );

    getCaConfig(additionalCAs?: Array<{ cert: string }>) {
        if (!additionalCAs) return {};
        else return {
            ca: tls.rootCertificates.concat(
                additionalCAs.map(({ cert }) => cert)
            )
        };
    }

    async sendRequest(
        requestDefn: RequestDefinition,
        options: RequestOptions
    ): Promise<stream.Readable> {
        const url = new URL(requestDefn.url);

        // Each option here should closely match the behaviour of the passthrough rules. We delegate
        // calculation of option values as much as possible to the UI, even where somewhat possible
        // here, since the UI controls the passthrough options directly already.

        const effectivePort = getEffectivePort(url);

        const strictHttpsChecks = shouldUseStrictHttps(
            url.hostname!,
            effectivePort,
            options.ignoreHostHttpsErrors ?? []
        );
        const caConfig = this.getCaConfig(options.trustAdditionalCAs);

        const agent = await getAgent({
            protocol: url.protocol as 'http:' | 'https:',
            hostname: url.hostname!,
            port: effectivePort,
            proxySettingSource: this.getProxyConfig(options.proxyConfig),
            tryHttp2: false,
            keepAlive: false
        });

        const request = (url.protocol === 'https:' ? https : http).request(requestDefn.url, {
            method: requestDefn.method,
            signal: options.abortSignal,

            // Low-level connection configuration:
            agent,
            lookup: this.getDns(options.lookupOptions?.servers),

            // TLS options (should be effectively identical to Mockttp's passthrough config)
            ...getUpstreamMockttpTlsOptions(strictHttpsChecks),
            ...caConfig,
            ...options.clientCertificate
        });

        options.abortSignal?.addEventListener('abort', () => {
            // In older Node versions, this seems to be required to _actually_ abort the request:
            request.abort();
        });

        // Node supports sending raw headers via [key, value, key, value] array, but if we do
        // so with 'headers' above then we can't removeHeader first (to disable the defaults).
        // Instead we remove headers and then manunally trigger the 'raw' write behaviour.

        request.removeHeader('connection');
        request.removeHeader('transfer-encoding');
        request.removeHeader('content-length');

        (request as any)._storeHeader(
            request.method + ' ' + request.path + ' HTTP/1.1\r\n',
            flattenPairedRawHeaders(requestDefn.headers)
        );

        if (requestDefn.rawBody?.byteLength) {
            request.end(requestDefn.rawBody);
        } else {
            request.end();
        }

        const resultsStream = new stream.Readable({
            objectMode: true,
            read() {} // Can't pull data - we manually fill this with .push() instead.
        });

        resultsStream.push({
            type: 'request-start',
            startTime: Date.now(),
            timestamp: performance.now()
        });

        new Promise<http.IncomingMessage>((resolve, reject) => {
            request.on('error', reject);
            request.on('response', resolve);
        }).then((response) => {
            resultsStream.push({
                type: 'response-head',
                statusCode: response.statusCode!,
                statusMessage: response.statusMessage,
                headers: pairFlatRawHeaders(response.rawHeaders),
                timestamp: performance.now()
            });

            response.on('data', (data) => resultsStream.push({
                type: 'response-body-part',
                rawBody: data,
                timestamp: performance.now()
            }));

            response.on('end', () => {
                resultsStream.push({ type: 'response-end', timestamp: performance.now() });
                resultsStream.push(null);
            });
            response.on('error', (error) => resultsStream.destroy(error));
        }).catch((error) => {
            resultsStream.destroy(error);
            request.destroy();
        });

        return resultsStream;
    }

}

/**
 * Turn node's _very_ raw headers ([k, v, k, v, ...]) into our slightly more convenient
 * pairwise tuples [[k, v], [k, v], ...] RawHeaders structure.
 */
export function pairFlatRawHeaders(flatRawHeaders: string[]): RawHeaders {
    const result: RawHeaders = [];
    for (let i = 0; i < flatRawHeaders.length; i += 2 /* Move two at a time */) {
        result[i/2] = [flatRawHeaders[i], flatRawHeaders[i+1]];
    }
    return result;
}

/**
 * Turn our raw headers [[k, v], [k, v], ...] tuples into Node's very flat
 * [k, v, k, v, ...] structure.
 */
export function flattenPairedRawHeaders(rawHeaders: RawHeaders): string[] {
    return rawHeaders.flat();
}