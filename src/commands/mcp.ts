import * as readline from 'readline';
import { execFile } from 'child_process';

import { Command, flags } from '@oclif/command';
import { delay } from '@httptoolkit/util';

import { SERVER_VERSION } from '../constants';
import { apiRequest } from '../api/bridge-client';
import { HtkOperation } from '../api/ui-operation-bridge';

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

function operationsToMcpTools(operations: HtkOperation[]): any[] {
    return operations.map(op => ({
        name: op.name.replace(/\./g, '_'),
        description: op.description,
        inputSchema: {
            type: 'object',
            properties: op.inputSchema?.properties ?? {},
        },
        ...(op.annotations && { annotations: op.annotations })
    }));
}

const POLL_INTERVAL_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const LAUNCH_POLL_MS = 500;

function launchDesktopApp(): boolean {
    const exePath = process.env.HTK_DESKTOP_EXE;
    if (!exePath) return false;

    execFile(exePath, [], () => {});
    return true;
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

    log('Launching HTTP Toolkit desktop app...');
    if (!launchDesktopApp()) {
        return {
            content: [{ type: 'text', text: 'Cannot launch HTTP Toolkit: desktop app path not detected.' }],
            isError: true
        };
    }

    // Wait for the UI to connect and send operations
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await delay(LAUNCH_POLL_MS);
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

    async function refreshOperations(): Promise<void> {
        try {
            cachedOperations = await apiRequest('GET', '/api/operations');
        } catch {
            cachedOperations = [];
        }
    }
    await refreshOperations();

    function getToolsList(): any[] {
        if (cachedOperations.length > 0) return operationsToMcpTools(cachedOperations);
        // No running instance — the only available action is to launch it.
        // This tool disappears once HTTP Toolkit is running and real tools become available.
        return [{
            name: 'start_httptoolkit',
            description: 'HTTP Toolkit is not currently running. Call this to launch it — once started, more tools will become available.',
            inputSchema: { type: 'object', properties: {} }
        }];
    }

    async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: any[]; isError?: boolean }> {
        if (name === 'start_httptoolkit') {
            return startHttpToolkit(log, refreshOperations);
        }

        // Map MCP tool name back to operation name
        const matchedOp = cachedOperations.find(op => op.name.replace(/\./g, '_') === name);
        const operationName = matchedOp?.name ?? name.replace(/_/g, '.');

        try {
            const result = await apiRequest('POST', '/api/execute', {
                name: operationName,
                args
            });

            if (result && !result.success && result.error?.code === 'PRO_REQUIRED') {
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
            case 'initialize':
                jsonRpcResult(msg.id!, {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: { listChanged: true }
                    },
                    serverInfo: {
                        name: 'httptoolkit',
                        version: SERVER_VERSION
                    }
                });
                break;

            case 'notifications/initialized':
                // Client ready — no response needed
                break;

            case 'tools/list':
                jsonRpcResult(msg.id!, { tools: getToolsList() });
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
    let lastOpsKey = JSON.stringify(cachedOperations.map(o => o.name).sort());

    const pollTimer = setInterval(async () => {
        await refreshOperations();
        const newOpsKey = JSON.stringify(cachedOperations.map(o => o.name).sort());
        if (newOpsKey !== lastOpsKey) {
            lastOpsKey = newOpsKey;
            sendJsonRpc({
                jsonrpc: '2.0',
                method: 'notifications/tools/list_changed'
            });
            log('Sent tools/list_changed');
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
