import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as querystring from 'querystring';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import {
    Mockttp, RequestRuleData, WebSocketRuleData, RequestStep, WebSocketStep,
    matchers as m, requestSteps as s, webSocketSteps as ws, completionCheckers as c
} from 'mockttp';

type JsonObject = Record<string, any>;
type RuleLog = { info(message: string): unknown; warn?(message: string): unknown };

const decompress = {
    gzip: promisify(zlib.gunzip), 'x-gzip': promisify(zlib.gunzip),
    deflate: promisify(zlib.inflate), br: promisify(zlib.brotliDecompress)
};

function boundedBodyMatchers(matchers: m.RequestMatcher[], limit: number, bodies: WeakMap<object, Promise<Buffer | undefined>>, passthroughIds: Set<string>) {
    for (const matcher of matchers) {
        if (!['raw-body', 'raw-body-includes', 'raw-body-regexp', 'json-body', 'json-body-matching', 'form-data', 'multipart-form-data'].includes(matcher.type)) continue;
        const original = matcher.matches.bind(matcher);
        matcher.matches = async request => {
            let captured = bodies.get(request);
            if (!captured) {
                // Mockttp signals dropped capture through its buffer promise.
                // Treat a dropped body as unavailable, never as an empty body.
                const buffering = request.body.asBuffer() as Promise<Buffer> & { events?: NodeJS.EventEmitter };
                let truncated = false;
                let preserved: Readable | undefined;
                let selected = false;
                let selectedId: string | undefined;
                // matchedRuleId is assigned by Mockttp after choosing a rule.
                // A non-passthrough response must drain, rather than leave the
                // preserved request applying backpressure to a keepalive socket.
                Object.defineProperty(request, 'matchedRuleId', {
                    configurable: true, enumerable: true,
                    get: () => selectedId,
                    set: (id: string | undefined) => {
                        selected = true; selectedId = id;
                        Object.defineProperty(request, 'matchedRuleId', { value: id, writable: true, configurable: true, enumerable: true });
                        if (preserved && (!id || !passthroughIds.has(id))) preserved.resume();
                    }
                });
                const onTruncate = () => {
                    truncated = true;
                    // Capture the replay stream before Mockttp drops its prefix.
                    // Its backpressure bounds memory until the chosen handler
                    // consumes it, including after an asynchronous delay.
                    preserved = request.body.asStream();
                    preserved.on('error', () => {});
                    preserved.read(0);
                    request.body.asStream = () => preserved!;
                    if (selected && (!selectedId || !passthroughIds.has(selectedId))) preserved.resume();
                };
                buffering.events?.once('truncate', onTruncate);
                captured = (async () => {
                    try {
                        let buffer = await buffering;
                        if (truncated || buffer.length > limit) return undefined;
                        const encodings = String(request.headers['content-encoding'] ?? 'identity').split(',').map(value => value.trim().toLowerCase()).reverse();
                        for (const encoding of encodings) {
                            if (encoding === 'identity') continue;
                            if (!Object.hasOwn(decompress, encoding)) return undefined;
                            buffer = await decompress[encoding as keyof typeof decompress](buffer, { maxOutputLength: limit });
                        }
                        return buffer;
                    } catch { return undefined; }
                    finally { buffering.events?.removeListener('truncate', onTruncate); }
                })();
                bodies.set(request, captured);
            }
            const body = await captured;
            if (body === undefined) return false;
            const view = Object.create(request);
            view.body = {
                ...request.body,
                asDecodedBuffer: async () => body,
                asText: async () => body.toString('utf8'),
                asJson: async () => JSON.parse(body.toString('utf8')),
                asFormData: async () => querystring.parse(body.toString('utf8'))
            };
            return original(view);
        };
    }
    return matchers;
}

function object(value: any, label: string): JsonObject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function fields(value: JsonObject, allowed: string[]) {
    const unknown = Object.keys(value).filter(key => !['type', 'uiType', ...allowed].includes(key));
    if (unknown.length) throw new Error(`Unsupported ${value.type} option(s): ${unknown.join(', ')}`);
}

function string(value: any, label: string): string {
    if (typeof value !== 'string') throw new Error(`${label} must be a string`);
    return value;
}

function integer(value: any, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
    return value;
}

function stringMap(value: any, label: string, arrays = false): JsonObject {
    const map = object(value, label);
    for (const entry of Object.values(map)) {
        if (typeof entry !== 'string' && !(arrays && Array.isArray(entry) && entry.every(v => typeof v === 'string'))) {
            throw new Error(`${label} values must be strings${arrays ? ' or arrays of strings' : ''}`);
        }
    }
    return map;
}

function regex(value: JsonObject): RegExp {
    return new RegExp(string(value.regexSource, 'regexSource'), value.regexFlags === undefined ? '' : string(value.regexFlags, 'regexFlags'));
}

function compileMatcher(input: any): m.RequestMatcher {
    const value = object(input, 'Matcher');
    const options: Record<string, string[]> = {
        wildcard: [], method: ['method'], protocol: ['protocol'], host: ['host'], hostname: ['hostname'], port: ['port'],
        'simple-path': ['path'], 'regex-path': ['regexSource', 'regexFlags'], 'regex-url': ['regexSource', 'regexFlags'],
        header: ['headers'], query: ['queryObject'], 'exact-query-string': ['query'], 'form-data': ['formData'],
        'raw-body': ['content'], 'raw-body-includes': ['content'], 'raw-body-regexp': ['regexString', 'regexFlags'],
        'multipart-form-data': ['matchConditions'],
        'json-body': ['body'], 'json-body-matching': ['body'], cookie: ['cookie']
    };
    if (!Object.hasOwn(options, value.type)) throw new Error(`Unsupported matcher type: ${String(value.type)}`);
    fields(value, options[value.type]);
    switch (value.type) {
        case 'wildcard': return new m.WildcardMatcher();
        case 'method': return new m.MethodMatcher(integer(value.method, 'method', 0, 6));
        case 'protocol':
            if (!['http', 'https', 'ws', 'wss'].includes(value.protocol)) throw new Error('Invalid protocol matcher');
            return new m.ProtocolMatcher(value.protocol);
        case 'host': return new m.HostMatcher(string(value.host, 'host'));
        case 'hostname': return new m.HostnameMatcher(string(value.hostname, 'hostname'));
        case 'port': return new m.PortMatcher(integer(Number(value.port), 'port', 1, 65535));
        case 'simple-path': return new m.FlexiblePathMatcher(string(value.path, 'path'));
        case 'regex-path': return new m.RegexPathMatcher(regex(value));
        case 'regex-url': return new m.RegexUrlMatcher(regex(value));
        case 'header': return new m.HeaderMatcher(stringMap(value.headers, 'headers'));
        case 'query': return new m.QueryMatcher(stringMap(value.queryObject, 'queryObject', true));
        case 'exact-query-string': return new m.ExactQueryMatcher(string(value.query, 'query'));
        case 'form-data': return new m.FormDataMatcher(stringMap(value.formData, 'formData'));
        case 'multipart-form-data': {
            if (!Array.isArray(value.matchConditions)) throw new Error('matchConditions must be an array');
            return new m.MultipartFormDataMatcher(value.matchConditions.map((input: any) => {
                const part = object(input, 'multipart match condition');
                if (Object.keys(part).some(key => !['name', 'filename', 'content'].includes(key))) throw new Error('Unsupported multipart match condition');
                return {
                    ...part,
                    ...(part.name !== undefined ? { name: string(part.name, 'part name') } : {}),
                    ...(part.filename !== undefined ? { filename: string(part.filename, 'part filename') } : {}),
                    ...(part.content !== undefined ? { content: bodyBuffer(part.content) } : {})
                };
            }));
        }
        case 'raw-body': return new m.RawBodyMatcher(string(value.content, 'content'));
        case 'raw-body-includes': return new m.RawBodyIncludesMatcher(string(value.content, 'content'));
        case 'raw-body-regexp': {
            return new m.RegexBodyMatcher(new RegExp(string(value.regexString, 'regexString'), value.regexFlags === undefined ? '' : string(value.regexFlags, 'regexFlags')));
        }
        case 'json-body':
        case 'json-body-matching':
            if (!Object.hasOwn(value, 'body')) throw new Error('JSON body matcher requires body');
            return value.type === 'json-body' ? new m.JsonBodyMatcher(value.body) : new m.JsonBodyFlexibleMatcher(value.body);
        case 'cookie': return new m.CookieMatcher(stringMap(value.cookie, 'cookie'));
        default: throw new Error('Unsupported matcher');
    }
}

function completion(input: any): c.RuleCompletionChecker {
    if (input === undefined) return new c.Always();
    const value = object(input, 'completionChecker');
    fields(value, value.type === 'times' ? ['count'] : []);
    switch (value.type) {
        case 'always': return new c.Always();
        case 'once': return new c.Once();
        case 'twice': return new c.Twice();
        case 'thrice': return new c.Thrice();
        case 'times': return new c.NTimes(integer(value.count, 'completion count', 1));
        default: throw new Error(`Unsupported completion checker: ${String(value.type)}`);
    }
}

function bodyBuffer(value: any): Buffer {
    if (value === undefined || value === null) return Buffer.alloc(0);
    if (typeof value === 'string') return Buffer.from(value);
    if (value?.type === 'Buffer' && Array.isArray(value.data) && value.data.every((v: any) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        return Buffer.from(value.data);
    }
    throw new Error('Response data must be a string or a serialized Buffer');
}

// Captured connection headers are not portable to HTTP/2. Recompute framing for
// each response, including when a file has changed since the previous request.
export function responseHeaders(input: any, size: number, status: number): Record<string, string | string[]> {
    const original = input === undefined ? {} : stringMap(input, 'response headers', true);
    const forbidden = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length']);
    for (const [name, value] of Object.entries(original)) {
        if (name.toLowerCase() === 'connection') {
            for (const token of String(value).split(',')) forbidden.add(token.trim().toLowerCase());
        }
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(original)) {
        http.validateHeaderName(name);
        for (const item of Array.isArray(value) ? value : [value]) http.validateHeaderValue(name, item);
        if (!forbidden.has(name.toLowerCase())) headers[name] = value;
    }
    if (status !== 204 && status !== 304) headers['content-length'] = String(size);
    return headers;
}

function passthroughOptions(value: JsonObject) {
    // Portable connection settings from HTTP Toolkit exports. Callback channels
    // and serialized transforms require a desktop session and are rejected.
    fields(value, ['forwarding', 'ignoreHostCertificateErrors', 'extraCACertificates', 'simulateConnectionErrors', 'mirrorTlsFingerprint']);
    const options: s.PassThroughStepOptions = {};
    if (value.forwarding !== undefined) {
        const forward = object(value.forwarding, 'forwarding');
        if (Object.keys(forward).some(key => !['targetHost', 'updateHostHeader'].includes(key))) throw new Error('Unsupported forwarding option');
        string(forward.targetHost, 'forwarding.targetHost');
        if (forward.updateHostHeader !== undefined && typeof forward.updateHostHeader !== 'boolean' && typeof forward.updateHostHeader !== 'string') throw new Error('Invalid updateHostHeader');
        options.transformRequest = { replaceHost: forward as any };
    }
    if (value.ignoreHostCertificateErrors !== undefined) {
        const ignore = value.ignoreHostCertificateErrors;
        if (typeof ignore !== 'boolean' && !(Array.isArray(ignore) && ignore.every(v => typeof v === 'string'))) throw new Error('Invalid ignoreHostCertificateErrors');
        options.ignoreHostHttpsErrors = ignore;
    }
    if (value.extraCACertificates !== undefined) {
        if (!Array.isArray(value.extraCACertificates)) throw new Error('extraCACertificates must be an array');
        options.additionalTrustedCAs = value.extraCACertificates.map((ca: any) => {
            object(ca, 'CA');
            if (typeof ca.cert === 'string' && Object.keys(ca).length === 1) return { cert: ca.cert };
            if (typeof ca.certPath === 'string' && Object.keys(ca).length === 1) return { certPath: ca.certPath };
            throw new Error('CA must contain cert or certPath');
        });
    }
    for (const key of ['simulateConnectionErrors', 'mirrorTlsFingerprint'] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
        if (value[key] !== undefined) options[key] = value[key];
    }
    return options;
}

async function compileStep(input: any, rule: JsonObject, certificate: { certPath?: string; cert?: string | Buffer }, log: RuleLog): Promise<RequestStep | WebSocketStep> {
    const value = object(input, 'Step');
    const common = ['status', 'statusMessage', 'headers'];
    const websocket = rule.type === 'websocket';
    if (value.type === 'delay') {
        fields(value, ['delayMs']);
        return new s.DelayStep(integer(value.delayMs, 'delayMs', 0, 2147483647));
    }
    const closing: Record<string, () => RequestStep & WebSocketStep> = {
        'close-connection': () => new s.CloseConnectionStep(), 'reset-connection': () => new s.ResetConnectionStep(), 'timeout': () => new s.TimeoutStep()
    };
    if (Object.hasOwn(closing, value.type)) { fields(value, []); return closing[value.type](); }
    if (!websocket && value.type === 'passthrough') return new s.PassThroughStep(passthroughOptions(value));
    if (websocket && value.type === 'ws-passthrough') return new ws.PassThroughWebSocketStep(passthroughOptions(value) as ws.PassThroughWebSocketStepOptions);
    if (websocket && value.type === 'ws-echo') { fields(value, []); return new ws.EchoWebSocketStep(); }
    if (websocket && value.type === 'ws-listen') { fields(value, []); return new ws.ListenWebSocketStep(); }
    if (websocket && value.type === 'ws-reject') {
        fields(value, ['statusCode', 'statusMessage', 'headers', 'body']);
        const status = integer(value.statusCode, 'statusCode', 300, 599);
        if (value.statusMessage !== undefined) http.validateHeaderValue('statusMessage', string(value.statusMessage, 'statusMessage'));
        const body = bodyBuffer(value.body);
        return new ws.RejectWebSocketStep(status, value.statusMessage, responseHeaders(value.headers, body.length, status), body);
    }
    if (websocket || !['simple', 'file', 'proxy-certificate'].includes(value.type)) throw new Error(`Unsupported ${rule.type} step type: ${String(value.type)}`);
    fields(value, [...common, ...(value.type === 'simple' ? ['data'] : value.type === 'file' ? ['filePath'] : [])]);
    const status = integer(value.status ?? 200, 'status', 200, 599);
    if (value.statusMessage !== undefined) http.validateHeaderValue('statusMessage', string(value.statusMessage, 'statusMessage'));
    // Validate headers at startup, even for responses whose files are read later.
    responseHeaders(value.headers, 0, status);
    if (value.type === 'simple') {
        const body = status === 204 || status === 304 ? Buffer.alloc(0) : bodyBuffer(value.data);
        return new s.FixedResponseStep(status, value.statusMessage, body, responseHeaders(value.headers, body.length, status));
    }
    const isDefaultCertificate = rule.id === 'default-certificate' && rule.matchers.some((matcher: any) =>
        matcher.type === 'simple-path' && /^(?:https?:\/\/)?amiusing\.httptoolkit\.tech\/certificate$/.test(matcher.path));
    if (value.type === 'proxy-certificate' || isDefaultCertificate) {
        // Serve the CA loaded by the running proxy, even if somebody replaces
        // its files before restarting. Ordinary response files stay live.
        if (!certificate.cert && !certificate.certPath) throw new Error('The proxy CA certificate is required for the certificate rule');
        const body = certificate.cert ? Buffer.from(certificate.cert) : await fs.readFile(certificate.certPath!);
        return new s.FixedResponseStep(status, value.statusMessage, body, responseHeaders(value.headers, body.length, status));
    }
    const filename = string(value.filePath, 'filePath');
    const absolute = path.resolve(filename);
    if (!(await fs.stat(absolute)).isFile()) throw new Error(`Response file is not a file: ${absolute}`);
    await fs.access(absolute);
    return new s.CallbackStep(async () => {
        try {
            const content = await fs.readFile(absolute);
            const body = status === 204 || status === 304 ? Buffer.alloc(0) : content;
            return { statusCode: status, statusMessage: value.statusMessage, headers: responseHeaders(value.headers, body.length, status), rawBody: body };
        } catch (error: any) {
            log.warn?.(`Failed to read response file ${absolute}: ${error.message}`);
            return { statusCode: 500, body: 'Failed to read response file' };
        }
    });
}

export function collectRules(root: any): JsonObject[] {
    if (!root || Array.isArray(root) || !Array.isArray(root.items)) throw new Error('Invalid rules JSON: expected an object with an "items" array.');
    const rules: JsonObject[] = [];
    function visit(items: any[], location: string) {
        items.forEach((input, i) => {
            const label = `${location}[${i}]`;
            const node = object(input, label);
            if (node.activated !== undefined && typeof node.activated !== 'boolean') throw new Error(`${label}.activated must be a boolean`);
            if (Object.hasOwn(node, 'items')) {
                if (node.type !== undefined) throw new Error(`${label}: a rule cannot also be a group`);
                if (!Array.isArray(node.items)) throw new Error(`${label}.items must be an array`);
                if (node.activated !== false) visit(node.items, `${label}.items`);
            } else {
                if (!['http', 'websocket'].includes(node.type)) throw new Error(`${label}: unsupported rule type ${String(node.type)}`);
                if (node.activated !== false) rules.push({ ...node, _location: label });
            }
        });
    }
    visit(root.items, 'items');
    return rules;
}

export async function applyHtkRules(server: Mockttp, root: any, log: RuleLog, flags: { addDefaultPassthrough: boolean; maxBodySize?: number }, https: { certPath?: string; cert?: string | Buffer }) {
    const rules = collectRules(root);
    const httpRules: RequestRuleData[] = [];
    const wsRules: WebSocketRuleData[] = [];
    let addedUnmatched = false;
    let count = 0;
    const seenFallback = new Set<string>();
    const bodies = new WeakMap<object, Promise<Buffer | undefined>>();
    const passthroughIds = new Set<string>();
    const ids = new Set<string>();
    // Compile and validate the entire tree before registering anything.
    for (const rule of rules) {
        try {
            if (!Array.isArray(rule.matchers) || !rule.matchers.length) throw new Error('matchers must be a non-empty array');
            if (!Array.isArray(rule.steps) || !rule.steps.length) throw new Error('steps must be a non-empty array');
            if (rule.id !== undefined) string(rule.id, 'id');
            const compiledMatchers = boundedBodyMatchers(rule.matchers.map(compileMatcher), flags.maxBodySize ?? 1024 * 1024, bodies, passthroughIds);
            const checker = completion(rule.completionChecker);
            const steps = await Promise.all(rule.steps.map((step: any) => compileStep(step, rule, https ?? {}, log)));
            rule.steps.forEach((step: any, i: number) => {
                if ((step.type === 'delay') === (i === rule.steps.length - 1)) throw new Error('Steps must contain zero or more delays followed by one final action');
            });
            const unrestrictedPassthrough = rule.matchers.length === 1 && rule.matchers[0].type === 'wildcard'
                && rule.steps.length === 1 && rule.steps[0].type === (rule.type === 'http' ? 'passthrough' : 'ws-passthrough')
                && checker.type === 'always';
            const basicFallback = unrestrictedPassthrough
                && Object.keys(rule.steps[0]).every(key => ['type', 'uiType'].includes(key))
                && (rule.priority === undefined || rule.priority === 0);
            const priority = rule.priority === undefined ? (basicFallback ? 0 : 1) : integer(rule.priority, 'priority', 0, 2147483647);
            if (basicFallback) {
                if (seenFallback.has(rule.type)) continue;
                seenFallback.add(rule.type);
            }
            if (unrestrictedPassthrough && priority === 0 && rule.type === 'http') addedUnmatched = true;
            const id = rule.id ?? randomUUID();
            if (!id || ids.has(id)) throw new Error('Rule IDs must be non-empty and unique');
            ids.add(id);
            if (['passthrough', 'ws-passthrough'].includes(rule.steps.at(-1).type)) passthroughIds.add(id);
            const data = { id, priority, matchers: compiledMatchers, completionChecker: checker, steps };
            if (rule.type === 'http') { httpRules.push(data as RequestRuleData); if (!basicFallback) count++; }
            else wsRules.push(data as WebSocketRuleData);
        } catch (error: any) {
            throw new Error(`Invalid rule ${JSON.stringify(rule.id ?? rule._location)}: ${error.message}`);
        }
    }
    if (!addedUnmatched && flags.addDefaultPassthrough) {
        httpRules.push({ priority: 0, matchers: [new m.WildcardMatcher()], completionChecker: new c.Always(), steps: [new s.PassThroughStep()] });
        addedUnmatched = true;
    }
    if (httpRules.length) await server.addRequestRules(...httpRules);
    if (wsRules.length) await server.addWebSocketRules(...wsRules);
    log.info(`Applied ${count} HTTP rule(s), ${wsRules.length} WebSocket rule(s); HTTP fallback=${addedUnmatched}`);
    return { addedUnmatched, count };
}
