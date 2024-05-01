import type * as Mockttp from 'mockttp';

// --- Request definition types ---

export type RawHeaders = Mockttp.RawHeaders;
export type RawTrailers = Mockttp.RawTrailers;

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

// --- Request option types ---

export const RULE_PARAM_REF_KEY = '__rule_param_reference__';
type ClientProxyRuleParamReference = { [RULE_PARAM_REF_KEY]: string };

export type ClientProxyConfig =
    | undefined // No Docker, no user or system proxy
    | Mockttp.ProxySetting // User or system proxy
    | ClientProxyRuleParamReference // Docker proxy (must be dereferenced)
    | Array<Mockttp.ProxySetting | ClientProxyRuleParamReference> // Both, ordered

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
     * Each certificate should be an object with a `cert` key containing the PEM
     * certificate as a string.
     */
    trustAdditionalCAs?: Array<{ cert: string }>;

    /**
     * A client certificate that should be used for the connection, if the server
     * requests one during the TLS handshake.
     */
    clientCertificate?: { pfx: Buffer, passphrase?: string };

    /**
     * Proxy configuration, specifying how (if at all) a proxy that should be used
     * for upstream connections.
     */
    proxyConfig?: ClientProxyConfig;

    /**
     * Custom DNS options, to allow configuration of the resolver used when
     * forwarding requests upstream. Passing any option switches from using node's
     * default dns.lookup function to using the cacheable-lookup module, which
     * will cache responses.
     */
    lookupOptions?: { servers?: string[] };

    /**
     * An abort signal, which can be used to cancel the in-process request if
     * required.
     */
    abortSignal?: AbortSignal;
}

// --- Response types ---

export type ResponseStreamEvents =
    | RequestStart
    | ResponseHead
    | ResponseBodyPart
    | ResponseTrailers
    | ResponseEnd;
// Other notable event is errors (via 'error' event)

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

export interface ResponseTrailers {
    type: 'response-trailers';
    trailers: RawTrailers;
    timestamp: number;
}

export interface ResponseEnd {
    type: 'response-end';
    timestamp: number;
}