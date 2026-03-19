import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

import WebSocket from 'ws';

export interface HtkOperation {
    name: string;
    description: string;
    category: string;
    inputSchema: any;
    outputSchema: any;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

interface BridgeChannel {
    ws: WebSocket;
    operations: HtkOperation[];
}

interface PendingRequest {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function getSocketPath(): string {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\httptoolkit-ctl';
    }

    let socketDir: string;
    if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
        socketDir = process.env.XDG_RUNTIME_DIR;
    } else {
        const tmpDir = os.tmpdir();
        if (tmpDir === '/tmp' || tmpDir === '/var/tmp') {
            socketDir = path.join(tmpDir, `httptoolkit-${process.getuid!()}`);
            fs.mkdirSync(socketDir, { mode: 0o700, recursive: true });
        } else {
            socketDir = tmpDir;
        }
    }

    return path.join(socketDir, 'httptoolkit-ctl.sock');
}

export class UiOperationBridge extends EventEmitter {

    private channels: BridgeChannel[] = [];
    private pending = new Map<string, PendingRequest>();
    private socketServer: http.Server | undefined;

    private get primaryChannel(): BridgeChannel | undefined {
        return this.channels[0];
    }

    get isReady(): boolean {
        const primary = this.primaryChannel;
        return primary !== undefined && primary.operations.length > 0;
    }

    get currentOperations(): HtkOperation[] {
        return this.primaryChannel?.operations ?? [];
    }

    /**
     * Called when a UI client connects via WebSocket upgrade on /ui-operations.
     * Each connection becomes a channel, ordered by connection time. The first
     * channel is always primary — operations and execute requests route through
     * it. If the primary hasn't sent operations yet, the bridge is not ready
     * regardless of other channels. When a channel disconnects, the next one
     * takes over as primary.
     */
    setWebSocket(ws: WebSocket): void {
        const channel: BridgeChannel = { ws, operations: [] };
        this.channels.push(channel);

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(channel, msg);
            } catch {}
        });

        ws.on('close', () => {
            this.handleChannelClose(channel);
        });

        ws.on('error', () => {
            // Error will be followed by close
        });
    }

    async executeOperation(operation: string, params: Record<string, unknown> = {}): Promise<any> {
        if (!this.isReady) {
            throw new Error('UI API is not ready');
        }

        const primary = this.primaryChannel!;

        if (primary.ws.readyState !== WebSocket.OPEN) {
            throw new Error('No UI connected');
        }

        const id = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(id, { resolve, reject, timer });

            try {
                primary.ws.send(JSON.stringify({
                    type: 'request',
                    id,
                    operation,
                    params
                }));
            } catch (err: any) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error(
                    `Failed to send '${operation}' request to UI: ${err.message}`
                ));
            }
        });
    }

    startApiServer(socketPath: string): http.Server {
        // Clean up stale socket file if it exists (Unix only)
        if (process.platform !== 'win32') {
            try { fs.unlinkSync(socketPath); } catch {}
        }

        const server = http.createServer(async (req, res) => {
            res.setHeader('Content-Type', 'application/json');

            const url = new URL(req.url!, `http://localhost`);
            const pathname = url.pathname;

            try {
                if (req.method === 'GET' && pathname === '/api/status') {
                    this.handleApiStatus(res);
                } else if (req.method === 'GET' && pathname === '/api/operations') {
                    this.handleApiOperations(res);
                } else if (req.method === 'POST' && pathname === '/api/execute') {
                    await this.handleApiExecute(req, res);
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'not_found' }));
                }
            } catch (err: any) {
                console.error('UI Bridge API error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
            }
        });

        server.listen(socketPath, () => {
            if (process.platform !== 'win32') {
                fs.chmodSync(socketPath, 0o600);
            }
            console.log(`UI Bridge API server listening on ${socketPath}`);
        });

        this.socketServer = server;
        return server;
    }

    private handleApiStatus(res: http.ServerResponse): void {
        res.writeHead(200);
        res.end(JSON.stringify({
            ready: this.isReady
        }));
    }

    private handleApiOperations(res: http.ServerResponse): void {
        if (!this.isReady) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'not_ready' }));
            return;
        }

        res.writeHead(200);
        res.end(JSON.stringify(this.currentOperations));
    }

    private async handleApiExecute(
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): Promise<void> {
        if (!this.isReady) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'not_ready' }));
            return;
        }

        const body = await readBody(req);
        let parsed: { name: string; args?: Record<string, unknown> };

        try {
            parsed = JSON.parse(body);
        } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
        }

        if (!parsed.name || typeof parsed.name !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'missing_operation_name' }));
            return;
        }

        try {
            const result = await this.executeOperation(parsed.name, parsed.args ?? {});
            res.writeHead(200);
            res.end(JSON.stringify(result));
        } catch (err: any) {
            console.error(`Operation '${parsed.name}' failed:`, err);
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'execution_failed', message: err.message }));
        }
    }

    private handleMessage(channel: BridgeChannel, data: any): void {
        if (!data || typeof data.type !== 'string') return;

        switch (data.type) {
            case 'operations': {
                const wasReady = this.isReady;
                channel.operations = data.operations ?? [];

                // Only emit events when the primary channel's operations change
                if (channel === this.primaryChannel) {
                    if (!wasReady && this.isReady) {
                        this.emit('ready');
                    }
                    this.emit('operations-changed', this.currentOperations);
                }
                break;
            }

            case 'response':
                this.handleResponse(data);
                break;
        }
    }

    private handleChannelClose(channel: BridgeChannel): void {
        const wasPrimary = channel === this.primaryChannel;
        const wasReady = this.isReady;

        const idx = this.channels.indexOf(channel);
        if (idx !== -1) this.channels.splice(idx, 1);

        if (wasPrimary) {
            // All in-flight requests were sent to this channel and will never get responses
            this.rejectAllPending('UI session disconnected');

            if (this.isReady) {
                // New primary already has operations
                this.emit('operations-changed', this.currentOperations);
            } else if (wasReady) {
                this.emit('not-ready');
            }
        }
    }

    private handleResponse(data: { id: string; result?: any; error?: string }): void {
        const pending = this.pending.get(data.id);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pending.delete(data.id);

        if (data.error) {
            pending.reject(new Error(data.error));
        } else {
            pending.resolve(data.result);
        }
    }

    private rejectAllPending(message: string): void {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(message));
        }
        this.pending.clear();
    }

    destroy(): void {
        if (this.socketServer) {
            this.socketServer.close();
            this.socketServer = undefined;
        }

        for (const channel of this.channels) {
            channel.ws.removeAllListeners();
            channel.ws.close();
        }
        this.channels = [];

        this.rejectAllPending('Bridge destroyed');
        this.removeAllListeners();
    }
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
