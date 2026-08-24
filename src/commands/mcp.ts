type BridgeClientModule = typeof import('../api/bridge-client');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { execFile, spawn } from 'child_process';

const canAccess = (filePath: string): Promise<boolean> =>
    fs.promises.access(filePath).then(() => true).catch(() => false);

import { Command, flags } from '@oclif/command';

import { IS_PROD_BUILD, SERVER_VERSION } from '../constants';
import type { HtkOperation } from '../api/ui-operation-bridge';

function maybeBundleImport<T>(moduleName: string): T {
    if (IS_PROD_BUILD || process.env.OCLIF_TS_NODE === '0') {
        return require('../../bundle/' + moduleName);
    } else {
        return require('../' + moduleName);
    }
}

const { apiRequest } = maybeBundleImport<BridgeClientModule>('api/bridge-client');

const LATEST_LEGACY_MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_LEGACY_MCP_PROTOCOL_VERSIONS = new Set([
    LATEST_LEGACY_MCP_PROTOCOL_VERSION,
    '2025-06-18',
    '2025-03-26',
    '2024-11-05'
]);

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string;
    method: string;
    params?: any;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: any;
}

function sendJsonRpc(msg: JsonRpcResponse | JsonRpcNotification): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function jsonRpcResult(id: number | string | null, result: any): void {
    sendJsonRpc({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: number | string | null, code: number, message: string): void {
    sendJsonRpc({ jsonrpc: '2.0', id, error: { code, message } });
}

function negotiateLegacyProtocolVersion(requestedVersion: unknown): string {
    return typeof requestedVersion === 'string' &&
        SUPPORTED_LEGACY_MCP_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : LATEST_LEGACY_MCP_PROTOCOL_VERSION;
}

function operationsToMcpTools(operations: HtkOperation[]): any[] {
    return operations.map(op => ({
        name: op.name.replace(/\./g, '_'),
        description: op.description,
        inputSchema: {
            ...(isPlainObject(op.inputSchema) ? op.inputSchema : {}),
            type: 'object',
            properties: isPlainObject(op.inputSchema?.properties)
                ? op.inputSchema.properties
                : {},
        },
        ...(op.annotations && { annotations: op.annotations })
    }));
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getUnderlyingBridgeErrors(error: any): any[] {
    return error?.socketAttempts?.length
        ? error.socketAttempts.map((attempt: any) => attempt.error)
        : [error];
}

function isExpectedBridgeUnavailable(error: any): boolean {
    if (!error) return false;
    if (error.statusCode === 503 && error.body?.error === 'not_ready') return true;

    const underlyingErrors = getUnderlyingBridgeErrors(error);
    return underlyingErrors.length > 0 && underlyingErrors.every((underlyingError) =>
        underlyingError?.code === 'ENOENT' ||
        underlyingError?.code === 'ECONNREFUSED'
    );
}

function shouldExposeBridgeDiagnostics(error: any): boolean {
    return !!error && !isExpectedBridgeUnavailable(error);
}

function serializeBridgeError(error: any): any {
    return {
        message: error?.message ?? String(error),
        ...(error?.code && { code: error.code }),
        ...(error?.statusCode !== undefined && { statusCode: error.statusCode }),
        ...(error?.body !== undefined && { body: error.body }),
        ...(error?.socketPath && { socketPath: error.socketPath }),
        ...(error?.socketAttempts && {
            socketAttempts: error.socketAttempts.map((attempt: any) => ({
                socketPath: attempt.socketPath,
                error: serializeBridgeError(attempt.error)
            }))
        })
    };
}

function getBridgeFailureInstruction(error: any): string {
    const underlyingErrors = getUnderlyingBridgeErrors(error);
    const codes = new Set(underlyingErrors.map((underlyingError) => underlyingError?.code));

    if (codes.has('EPERM') || codes.has('EACCES')) {
        return 'The MCP process was denied access to the local control socket. Check whether ' +
            'it is running inside a sandbox that blocks Unix socket access.';
    }
    if (codes.has('ETIMEDOUT')) {
        return 'The local control socket did not respond within two seconds. Restart HTTP ' +
            'Toolkit and retry once it has fully opened.';
    }
    if (error?.statusCode === 404) {
        return 'The responding server does not support this control endpoint. Restart HTTP ' +
            'Toolkit and the MCP client after all application components have updated.';
    }
    if (error?.statusCode === 401 || error?.statusCode === 403) {
        return 'The control server rejected this MCP process. Check that HTTP Toolkit and its ' +
            'MCP process use the same authentication configuration.';
    }
    if (error?.statusCode !== undefined) {
        return `The control server returned HTTP ${error.statusCode}. Restart HTTP Toolkit and ` +
            'the MCP client, then retry.';
    }

    return 'Restart HTTP Toolkit and retry. If the failure continues, report these diagnostic ' +
        'details with the HTTP Toolkit and MCP versions.';
}

const POLL_INTERVAL_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const LAUNCH_POLL_MS = 500;
const OPEN_TIMEOUT_MS = 10_000;

// Default install paths per platform. First match wins. The wrapper scripts
// (httptoolkit-mcp / .cmd) set HTK_DESKTOP_EXE explicitly, so the env var
// check below handles the normal "bundled with HTK" case.
function getDefaultHtkExeCandidates(): string[] {
    if (process.platform === 'darwin') {
        return [
            '/Applications/HTTP Toolkit.app/Contents/MacOS/HTTP Toolkit',
            path.join(os.homedir(), 'Applications/HTTP Toolkit.app/Contents/MacOS/HTTP Toolkit')
        ];
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.PROGRAMFILES;
        const candidates: string[] = [];
        if (localAppData) {
            candidates.push(path.join(localAppData, 'Programs', 'HTTP Toolkit', 'HTTP Toolkit.exe'));
        }
        if (programFiles) {
            candidates.push(path.join(programFiles, 'HTTP Toolkit', 'HTTP Toolkit.exe'));
        }
        return candidates;
    }

    // Linux (default for deb/rpm at least)
    return ['/opt/HTTP Toolkit/httptoolkit'];
}

async function getLaunchableHtkExePath(): Promise<string | null> {
    const envPath = process.env.HTK_DESKTOP_EXE;
    if (envPath && await canAccess(envPath)) return envPath;

    for (const candidate of getDefaultHtkExeCandidates()) {
        if (await canAccess(candidate)) return candidate;
    }

    return null;
}

async function getOutermostAppBundlePath(exePath: string): Promise<string | undefined> {
    const realExePath = await fs.promises.realpath(exePath).catch(() => exePath);

    const pathParts = realExePath.split(path.sep);
    const outermostBundleIndex = pathParts.findIndex((part) => part.endsWith('.app'));
    if (outermostBundleIndex === -1) return undefined;

    return pathParts.slice(0, outermostBundleIndex + 1).join(path.sep);
}

// We launch on Mac via `open`. Launching the exe directly would mean the MCP server
// becomes the responsible process, which has permissions & OS UI effects.
function openAppBundleViaLaunchServices(bundlePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/open', ['-a', bundlePath], { timeout: OPEN_TIMEOUT_MS }, (error, _stdout, stderr) => {
            if (!error) resolve();
            else reject(new Error(`${bundlePath} could not be opened: ${stderr.trim() || error.message}`));
        });
    });
}

function spawnAppDetached(exePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const app = spawn(exePath, [], {
            detached: true,
            stdio: 'ignore'
        });

        app.on('error', (error) => reject(
            new Error(`${exePath} could not be started: ${error.message}`)
        ));
        app.on('spawn', () => {
            app.unref();
            resolve();
        });
    });
}

async function launchDesktopApp(exePath: string): Promise<void> {
    if (process.platform === 'darwin') {
        const bundlePath = await getOutermostAppBundlePath(exePath);
        if (bundlePath) return openAppBundleViaLaunchServices(bundlePath);
    }

    return spawnAppDetached(exePath);
}

async function startHttpToolkit(
    log: (msg: string) => void,
    refreshOperations: () => Promise<void>
): Promise<{ content: any[]; isError?: boolean }> {
    // Check if it's already running (maybe it just connected since the last poll)
    await refreshOperations();
    if ((await apiRequest('GET', '/api/status').catch(() => null))?.ready) {
        await refreshOperations();
        return {
            content: [{ type: 'text', text: 'HTTP Toolkit is already running and ready.' }]
        };
    }

    const exePath = await getLaunchableHtkExePath();
    if (!exePath) {
        return {
            content: [{ type: 'text', text: 'Cannot launch HTTP Toolkit: desktop app path not available.' }],
            isError: true
        };
    }

    log('Launching HTTP Toolkit desktop app...');
    try {
        await launchDesktopApp(exePath);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: 'text', text: `Could not launch HTTP Toolkit: ${message}` }],
            isError: true
        };
    }

    // Wait for the UI to connect and send operations
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, LAUNCH_POLL_MS));
        await refreshOperations();
        try {
            const status = await apiRequest('GET', '/api/status');
            if (status?.ready) {
                log('HTTP Toolkit is ready');
                return {
                    content: [{ type: 'text', text: 'HTTP Toolkit has been launched and is ready.' }]
                };
            }
        } catch {
            // Server not yet available, keep waiting
        }
    }

    return {
        content: [{ type: 'text', text: 'HTTP Toolkit was launched but is not yet ready. It may still be starting up — try again in a moment.' }],
        isError: true
    };
}

async function runMcpServer(): Promise<void> {
    const log = (msg: string) => process.stderr.write(`[MCP] ${msg}\n`);

    let cachedOperations: HtkOperation[] = [];
    let lastBridgeError: any;
    let lastToolStateKey: string | undefined;

    function getToolStateKey(): string {
        return JSON.stringify({
            operations: cachedOperations.map(o => o.name).sort(),
            diagnostics: shouldExposeBridgeDiagnostics(lastBridgeError)
        });
    }

    async function refreshOperations(): Promise<void> {
        try {
            cachedOperations = await apiRequest('GET', '/api/operations');
            lastBridgeError = undefined;
        } catch (err) {
            cachedOperations = [];
            lastBridgeError = err;
        }
    }

    // Kick off the first refresh in the background — don't block on this until
    // we actually need the tools list.
    const initialRefresh = refreshOperations().then(() => {
        lastToolStateKey = getToolStateKey();
    });

    async function getToolsList(): Promise<any[]> {
        await initialRefresh;
        if (cachedOperations.length > 0) return operationsToMcpTools(cachedOperations);

        const tools: any[] = [];

        if (shouldExposeBridgeDiagnostics(lastBridgeError)) {
            tools.push({
                name: 'diagnose_httptoolkit_connection',
                description: 'Show details and recovery instructions for the current broken HTTP Toolkit connection.',
                inputSchema: { type: 'object', properties: {} },
                annotations: {
                    readOnlyHint: true,
                    idempotentHint: true
                }
            });
        }

        if (await getLaunchableHtkExePath()) {
            tools.push({
                name: 'start_httptoolkit',
                description: 'HTTP Toolkit is not currently running. Call this to launch it — once started, more tools will become available.',
                inputSchema: { type: 'object', properties: {} }
            });
        }

        return tools;
    }

    async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: any[]; isError?: boolean }> {
        if (name === 'start_httptoolkit') {
            return startHttpToolkit(log, refreshOperations);
        }

        if (name === 'diagnose_httptoolkit_connection') {
            if (!shouldExposeBridgeDiagnostics(lastBridgeError)) {
                return {
                    content: [{
                        type: 'text',
                        text: 'The HTTP Toolkit connection is no longer reporting a broken state. Refresh the available tools.'
                    }]
                };
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        serverVersion: SERVER_VERSION,
                        process: {
                            platform: process.platform,
                            arch: process.arch,
                            node: process.version,
                            pid: process.pid
                        },
                        runtimeEnvironment: {
                            xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
                            tempDir: process.env.TMPDIR
                        },
                        failure: serializeBridgeError(lastBridgeError),
                        instructions: [
                            getBridgeFailureInstruction(lastBridgeError),
                            'Call start_httptoolkit to retry startup.'
                        ]
                    }, null, 2)
                }]
            };
        }

        // Map MCP tool name back to operation name
        const matchedOp = cachedOperations.find(op => op.name.replace(/\./g, '_') === name);
        const operationName = matchedOp?.name ?? name.replace(/_/g, '.');

        try {
            const result = await apiRequest('POST', '/api/execute', {
                name: operationName,
                args,
                source: 'mcp'
            });

            if (result && !result.success && result.error) {
                return {
                    content: [{ type: 'text', text: result.error.message }],
                    isError: true
                };
            }

            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
        } catch (err: any) {
            return {
                content: [{ type: 'text', text: `Error: ${err.message}` }],
                isError: true
            };
        }
    }

    function handleMessage(msg: JsonRpcRequest): void {
        switch (msg.method) {
            case 'initialize': {
                const protocolVersion = negotiateLegacyProtocolVersion(
                    msg.params?.protocolVersion
                );

                jsonRpcResult(msg.id!, {
                    protocolVersion,
                    capabilities: {
                        tools: { listChanged: true }
                    },
                    serverInfo: {
                        name: 'httptoolkit',
                        version: SERVER_VERSION
                    }
                });
                break;
            }

            case 'ping':
                jsonRpcResult(msg.id!, {});
                break;

            case 'notifications/initialized':
                // Client ready — no response needed
                break;

            case 'tools/list':
                getToolsList().then(tools => {
                    jsonRpcResult(msg.id!, { tools });
                }).catch(err => {
                    jsonRpcError(msg.id!, -32603, err.message);
                });
                break;

            case 'tools/call': {
                const { name, arguments: callArgs } = msg.params ?? {};
                if (!name || typeof name !== 'string') {
                    jsonRpcError(msg.id!, -32602, 'Missing tool name');
                    break;
                }
                log(`Tool called: ${name} with args: ${JSON.stringify(callArgs)}`);
                handleToolCall(name, callArgs ?? {}).then(result => {
                    jsonRpcResult(msg.id!, result);
                }).catch(err => {
                    jsonRpcError(msg.id!, -32603, err.message);
                });
                break;
            }

            default:
                if (msg.id !== undefined) {
                    jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
                }
                break;
        }
    }

    // Poll for operation changes
    let pollInProgress = false;

    const pollTimer = setInterval(async () => {
        if (pollInProgress) return;
        pollInProgress = true;

        try {
            await refreshOperations();
            const newToolStateKey = getToolStateKey();
            if (newToolStateKey !== lastToolStateKey) {
                lastToolStateKey = newToolStateKey;
                sendJsonRpc({
                    jsonrpc: '2.0',
                    method: 'notifications/tools/list_changed'
                });
                log('Sent tools/list_changed');
            }
        } finally {
            pollInProgress = false;
        }
    }, POLL_INTERVAL_MS);

    // Read stdin line-by-line
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const msg = JSON.parse(trimmed) as JsonRpcRequest;
            handleMessage(msg);
        } catch {
            jsonRpcError(null, -32700, 'Parse error');
        }
    });

    rl.on('close', () => {
        clearInterval(pollTimer);
        process.exit(0);
    });

    log('MCP server started on stdio');
}

class McpCommand extends Command {
    static description = 'start an MCP server for HTTP Toolkit'

    static flags = {
        help: flags.help({ char: 'h' }),
        token: flags.string({
            char: 't',
            description: 'optional token to authenticate server access',
            env: 'HTK_SERVER_TOKEN'
        }),
    }

    async run() {
        this.parse(McpCommand);
        await runMcpServer();
    }
}

export = McpCommand;
