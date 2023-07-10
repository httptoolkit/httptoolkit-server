import * as stream from 'stream';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import {
    shouldUseStrictHttps,
    UPSTREAM_TLS_OPTIONS
} from 'mockttp/dist/rules/passthrough-handling';

export type RawHeaders = Array<[key: string, value: string]>;

export interface RequestDefinition {
    method: string;
    url: string;

    /**
     * The raw headers to send. These will be sent exactly as provided - no headers
     * will be added automatically.
     *
     * Note that this means omitting the 'Host' header may cause problems, as will
     * omitting both 'Content-Length' and 'Transfer-Encoding' on requests with
     * bodies.
     */
    headers: RawHeaders;
    rawBody?: Uint8Array;
}

export interface RequestOptions {
    /**
     * A list of hostnames for which server certificate and TLS version errors
     * should be ignored (none, by default).
     *
     * If set to 'true', HTTPS errors will be ignored for all hosts. WARNING:
     * Use this at your own risk. Setting this to `true` can open your
     * application to MITM attacks and should never be used over any network
     * that is not completed trusted end-to-end.
     */
    ignoreHostHttpsErrors?: string[] | boolean;

    /**
     * An array of additional certificates, which should be trusted as certificate
     * authorities for upstream hosts, in addition to Node.js's built-in certificate
     * authorities.
     *
     * Each certificate should be an object with either a `cert` key and a string
     * or buffer value containing the PEM certificate, or a `certPath` key and a
     * string value containing the local path to the PEM certificate.
     */
    trustAdditionalCAs?: Array<{ cert: Buffer }>;

    /**
     * A client certificate that should be used for the connection, if the server
     * requests one during the TLS handshake.
     */
    clientCertificate?: { pfx: Buffer, passphrase?: string };

    /**
     * An abort signal, which can be used to cancel the in-process request if
     * required.
     */
    abortSignal?: AbortSignal;
}

export type ResponseStreamEvents =
    | RequestStart
    | ResponseHead
    | ResponseBodyPart
    | ResponseEnd;
// Other notable events: errors (via 'error' event) and clean closure (via 'end').

export interface RequestStart {
    type: 'request-start';
    startTime: number; // Unix timestamp
    timestamp: number; // High precision timer (for relative calculations on later events)
}

export interface ResponseHead {
    type: 'response-head';
    statusCode: number;
    statusMessage?: string;
    headers: RawHeaders;
    timestamp: number;
}

export interface ResponseBodyPart {
    type: 'response-body-part';
    rawBody: Buffer;
    timestamp: number;
}

export interface ResponseEnd {
    type: 'response-end';
    timestamp: number;
}

export function sendRequest(
    requestDefn: RequestDefinition,
    options: RequestOptions
): stream.Readable {
    const url = new URL(requestDefn.url);

    const strictHttpsChecks = shouldUseStrictHttps(url.hostname!, url.port!, options.ignoreHostHttpsErrors ?? []);
    const caConfig = options.trustAdditionalCAs
        ? {
            ca: tls.rootCertificates.concat(
                options.trustAdditionalCAs.map(({ cert }) => cert.toString('utf8'))
            )
        }
        : {};

    const request = (url.protocol === 'https' ? https : http).request(requestDefn.url, {
        method: requestDefn.method,
        signal: options.abortSignal,

        // TLS options (should be effectively identical to Mockttp's passthrough config)
        ...UPSTREAM_TLS_OPTIONS,
        minVersion: strictHttpsChecks
            ? tls.DEFAULT_MIN_VERSION
            : 'TLSv1', // Allow TLSv1, if !strict
        rejectUnauthorized: strictHttpsChecks,
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