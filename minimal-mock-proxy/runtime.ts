import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { createPrivateKey, randomUUID, X509Certificate } from 'crypto';
import envPaths from 'env-paths';
import { getLocal, generateCACertificate, Mockttp } from 'mockttp';
import { applyHtkRules, collectRules } from './rules';
export { applyHtkRules } from './rules';

const fsp = fs.promises;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = typeof LOG_LEVELS[number];
export type Flags = {
    port: number; host: string; rules?: string; logLevel: LogLevel;
    bodyPreview: number; maxBodySize: number; addDefaultPassthrough: boolean;
    telegramBotToken?: string; telegramChatId?: string;
};

export function printUsage() {
    console.log('Usage: node server.js --rules <path> [--port <0-65535>] [--host <IP>] [--log-level error|warn|info|debug] [--body-preview <0-65536>] [--max-body-size <bytes>] [--add-default-passthrough] [--telegram-bot-token <token> --telegram-chat-id <id>]');
}

export function parseArgs(argv: string[]): Flags {
    const flags: Flags = { port: 8888, host: '127.0.0.1', logLevel: 'info', bodyPreview: 0, maxBodySize: 1024 * 1024, addDefaultPassthrough: false };
    const options: Record<string, keyof Flags> = {
        '--port': 'port', '--host': 'host', '--rules': 'rules', '--log-level': 'logLevel', '--body-preview': 'bodyPreview',
        '--max-body-size': 'maxBodySize', '--telegram-bot-token': 'telegramBotToken', '--telegram-chat-id': 'telegramChatId'
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
        if (arg === '--add-default-passthrough') { flags.addDefaultPassthrough = true; continue; }
        if (!Object.hasOwn(options, arg)) throw new Error(`Unknown option: ${arg}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith('--') || value === '') throw new Error(`Missing value for ${arg}`);
        const key = options[arg];
        if (key === 'port' || key === 'bodyPreview' || key === 'maxBodySize') {
            const limit = key === 'port' ? 65535 : key === 'bodyPreview' ? 65536 : 64 * 1024 * 1024;
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > limit || (key === 'maxBodySize' && Number(value) === 0)) {
                throw new Error(`Invalid value for ${arg}: expected an integer from ${key === 'maxBodySize' ? 1 : 0} to ${limit}`);
            }
            flags[key] = Number(value);
        } else (flags as any)[key] = value;
    }
    if (!LOG_LEVELS.includes(flags.logLevel)) throw new Error('Invalid --log-level: expected error, warn, info, or debug');
    if (!net.isIP(flags.host)) throw new Error('Invalid --host: expected an IPv4 or IPv6 address');
    if (!!flags.telegramBotToken !== !!flags.telegramChatId) throw new Error('Provide both --telegram-bot-token and --telegram-chat-id');
    return flags;
}

export function buildLogger(level: LogLevel, output: Pick<Console, 'log' | 'warn' | 'error'> = console) {
    const enabled = (minimum: LogLevel) => LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
    return {
        enabled,
        error: (message: string) => { if (enabled('error')) output.error(message); },
        warn: (message: string) => { if (enabled('warn')) output.warn(message); },
        info: (message: string) => { if (enabled('info')) output.log(message); },
        debug: (message: string) => { if (enabled('debug')) output.log(message); }
    };
}

export async function generateHttpsConfig(directory: string) {
    await fsp.mkdir(directory, { recursive: true });
    const keyPath = path.join(directory, 'ca.key');
    const certPath = path.join(directory, 'ca.pem');
    async function readPair() {
        const read = async (filename: string) => fsp.readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        const [key, cert] = await Promise.all([read(keyPath), read(certPath)]);
        if (key === undefined && cert === undefined) return undefined;
        if (!key || !cert) throw new Error(`Incomplete CA files in ${directory}; restore the existing CA key and certificate`);
        const certificate = new X509Certificate(cert);
        if (!certificate.ca || !certificate.checkPrivateKey(createPrivateKey(key))) throw new Error(`Invalid or mismatched CA files in ${directory}`);
        if (Date.parse(certificate.validTo) <= Date.now()) throw new Error(`Expired CA certificate in ${directory}`);
        return { keyPath, certPath, key, cert };
    }
    // Serialize first-time creation across proxy instances. Existing trusted CA
    // material is validated and never replaced as a side effect of a read error.
    const lockPath = path.join(directory, 'ca.lock');
    let lock: fs.promises.FileHandle | undefined;
    const deadline = Date.now() + 30000;
    while (!lock) {
        try { lock = await fsp.open(lockPath, 'wx', 0o600); }
        catch (error: any) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw new Error(`CA initialization is locked: ${lockPath}. Check for another initializing instance or a stale lock.`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    const temporary = [path.join(directory, `${randomUUID()}.key.tmp`), path.join(directory, `${randomUUID()}.pem.tmp`)];
    try {
        const existing = await readPair();
        if (existing) return existing;
        const pair = await generateCACertificate({ subject: { commonName: 'Minimal Mock Proxy CA', organizationName: 'Minimal Mock Proxy CA' } });
        await Promise.all([fsp.writeFile(temporary[0], pair.key, { mode: 0o600 }), fsp.writeFile(temporary[1], pair.cert)]);
        await fsp.rename(temporary[0], keyPath);
        await fsp.rename(temporary[1], certPath);
        return { keyPath, certPath, ...pair };
    } finally {
        await Promise.all(temporary.map(filename => fsp.unlink(filename).catch(() => {})));
        await lock.close();
        await fsp.unlink(lockPath);
    }
}

// Mockttp 4.6.4 does not expose a bind host. Adapt only this instance's
// transport, before listen(), rather than mutating Node's global prototypes or
// opening a second listener. Keep this guarded and covered by socket tests.
export async function startBound(server: Mockttp, port: number, host: string) {
    if (!net.isIP(host)) throw new Error('A numeric bind address is required');
    const descriptor = Object.getOwnPropertyDescriptor(server, 'server');
    if (!descriptor || !descriptor.configurable) throw new Error('Unsupported Mockttp transport: cannot enforce the bind address');
    if ((server as any).server?.listening) throw new Error('The proxy is already listening');
    let transport: net.Server | undefined;
    let bound = false;
    Object.defineProperty(server, 'server', {
        configurable: true,
        get: () => transport,
        set: (value: net.Server) => {
            transport = value;
            const listen = value.listen.bind(value);
            value.listen = ((selectedPort: number) => {
                if (typeof selectedPort !== 'number') throw new Error('Unsupported Mockttp listen arguments');
                bound = true;
                return listen({ port: selectedPort, host });
            }) as typeof value.listen;
        }
    });
    try {
        await server.start(port);
        const address = transport?.address();
        if (!bound || !address || typeof address === 'string' || address.address !== host) throw new Error('Proxy did not bind to the configured address');
    } catch (error) {
        await server.stop().catch(() => {});
        throw error;
    }
}

function safeUrl(input: string) {
    try {
        const url = new URL(input);
        url.username = ''; url.password = '';
        for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
        return url.toString();
    } catch { return '(unparsable URL)'; }
}

export async function registerLogging(server: Mockttp, log: ReturnType<typeof buildLogger>, flags: Flags) {
    if (log.enabled('info')) {
        await server.on('request-initiated', request => log.info(`[req] ${request.method} ${safeUrl(request.url)}`));
        await server.on('response', response => {
            const type = String(response.headers['content-type'] ?? '');
            const raw = response.body.buffer;
            let detail = `body-bytes=${raw.length}`;
            // Never decompress bodies for previews: a small compressed response
            // can expand far beyond the capture limit. Binary bodies stay binary.
            if (flags.bodyPreview > 0 && !response.headers['content-encoding'] && /^(text\/|application\/(?:[\w.-]+\+)?(?:json|xml)|application\/(?:javascript|x-www-form-urlencoded))/i.test(type)) {
                const text = raw.subarray(0, Math.min(raw.length, flags.bodyPreview * 4)).toString('utf8');
                const preview = text.slice(0, flags.bodyPreview);
                detail = `body=${JSON.stringify(preview)}${raw.length > Buffer.byteLength(preview) ? '…' : ''}`;
            }
            log.info(`[res] ${response.statusCode} content-type=${JSON.stringify(type)} ${detail}`);
        });
    }
    if (log.enabled('warn')) await server.on('abort', request => log.warn(`[abort] ${request.method} ${safeUrl(request.url)}`));
    await server.on('client-error', () => {
        log.warn('[client-error]');
        void notifyTelegram(flags, 'Proxy client error');
    });
    await server.on('tls-client-error', () => {
        log.warn('[tls-error] Client could not establish a trusted TLS connection');
        void notifyTelegram(flags, 'Proxy TLS client error');
    });
}

export async function notifyTelegram(flags: Pick<Flags, 'telegramBotToken' | 'telegramChatId'>, message: string, send: typeof fetch = fetch) {
    if (!flags.telegramBotToken || !flags.telegramChatId) return;
    try {
        const response = await send(`https://api.telegram.org/bot${flags.telegramBotToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ chat_id: flags.telegramChatId, text: message.slice(0, 4000) }).toString(),
            signal: AbortSignal.timeout(3000)
        });
        if (!response.ok) console.warn(`Telegram notify failed: ${response.status}`);
    } catch { console.warn('Telegram notification failed'); }
}

export async function startProxy(flags: Flags, configPath = envPaths('minimal-mock-proxy', { suffix: '' }).config) {
    if (!flags.rules) throw new Error('A rules JSON file is required. Use --rules <path>.');
    const rules = JSON.parse(await fsp.readFile(path.resolve(flags.rules), 'utf8'));
    collectRules(rules);
    const log = buildLogger(flags.logLevel);
    const https = await generateHttpsConfig(configPath);
    const server = getLocal({ https, recordTraffic: false, maxBodySize: flags.maxBodySize });
    try {
        await applyHtkRules(server, rules, log, flags, https);
        await registerLogging(server, log, flags);
        await startBound(server, flags.port, flags.host);
        const host = net.isIPv6(flags.host) ? `[${flags.host}]` : flags.host;
        log.info(`Mock proxy listening on ${host}:${server.port}`);
        log.debug(`Using CA cert at: ${https.certPath}`);
        return { server, https, stop: () => server.stop() };
    } catch (error) {
        await server.stop().catch(() => {});
        throw error;
    }
}

export async function main() {
    const flags = parseArgs(process.argv);
    const proxy = await startProxy(flags);
    let stopping = false;
    const stop = async (code: number, error?: unknown) => {
        if (stopping) return;
        stopping = true;
        if (error) console.error(error);
        try { await proxy.stop(); }
        finally {
            if (error) await notifyTelegram(flags, 'Proxy stopped after an unexpected error. Check local logs.');
            process.exit(code);
        }
    };
    process.once('SIGINT', () => { void stop(0); });
    process.once('SIGTERM', () => { void stop(0); });
    process.once('unhandledRejection', error => { void stop(1, error); });
    process.once('uncaughtException', error => { void stop(1, error); });
}
