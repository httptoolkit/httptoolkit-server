import * as crypto from 'crypto';
import * as fs from '../util/fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

import WebSocket from 'ws';

import { getUserFromAppJwt, type User } from '@httptoolkit/accounts';

export interface HtkOperation {
    name: string;
    description: string;
    category: string;
    tiers: Array<'free' | 'pro'>;
    sessionLimit?: number;
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
    user?: User;
    authenticated: boolean;
    // Operations received before authentication completes are buffered here
    // and applied atomically once auth succeeds.
    pendingOperations?: HtkOperation[];
    // Monotonic sequence number for in-flight JWT validations. Only the
    // latest validation is applied; earlier ones are discarded if superseded.
    authSeq: number;
}

interface PendingRequest {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function getSocketPath(): Promise<string> {
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
            await fs.mkDir(socketDir, { mode: 0o700, recursive: true });
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

    constructor(private authToken?: string) {
        super();
    }

    private get primaryChannel(): BridgeChannel | undefined {
        return this.channels[0];
    }

    get isReady(): boolean {
        const primary = this.primaryChannel;
        return !!primary?.authenticated && primary.operations.length > 0;
    }

    get currentOperations(): HtkOperation[] {
        return this.primaryChannel?.operations ?? [];
    }

    isPaidUser(): boolean {
        return this.primaryChannel?.user?.isPaidUser() ?? false;
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
        const channel: BridgeChannel = {
            ws,
            operations: [],
            authenticated: false,
            authSeq: 0
        };
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

    async startApiServer(socketPath: string): Promise<void> {
        // Clean up stale socket file if it exists (Unix only)
        if (process.platform !== 'win32') {
            try { await fs.deleteFile(socketPath); } catch {}
        }

        const server = http.createServer(async (req, res) => {
            try {
                res.setHeader('Content-Type', 'application/json');

                const url = new URL(req.url!, `http://localhost`);
                const pathname = url.pathname;

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

        this.socketServer = server;

        return new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, async () => {
                server.removeListener('error', reject);
                server.on('error', (err) => {
                    console.warn(`UI Bridge socket server error: ${err.message}`);
                });

                if (process.platform !== 'win32') {
                    try {
                        // On Unix, socket file is an actual file on disk, so we need to
                        // lock it down for user-only access.
                        await fs.chmod(socketPath, 0o600);
                    } catch (err: any) {
                        server.close();
                        reject(new Error(
                            `Failed to chmod bridge socket: ${err.message}`
                        ));
                        return;
                    }
                }

                console.log(`UI Bridge API server listening on ${socketPath}`);
                resolve();
            });
        });
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
        let parsed: { name: string; args?: Record<string, unknown>; source?: string };

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

        const source = parsed.source;
        const isPaid = this.isPaidUser();

        // CTL requires Pro for all operations
        if (source === 'ctl' && !isPaid) {
            res.writeHead(403);
            res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'TIER_REQUIRED_PRO',
                    message: 'CLI remote control requires HTTP Toolkit Pro. ' +
                        'Get Pro at https://httptoolkit.com/pricing/'
                }
            }));
            return;
        }

        // MCP requires Pro for non-free operations:
        if (source === 'mcp' && !isPaid) {
            const operation = this.currentOperations.find(op => op.name === parsed.name);
            if (!operation) {
                // Shouldn't happen - valid names come from the exposed operations
                // list in the first place.
                throw new Error(`Requested operation '${parsed.name}' not found`);
            }

            if (!operation.tiers.includes('free')) {
                res.writeHead(403);
                res.end(JSON.stringify({
                    success: false,
                    error: {
                        code: 'TIER_REQUIRED_PRO',
                        message: `The '${parsed.name}' operation requires HTTP Toolkit Pro. ` +
                            'Get Pro at https://httptoolkit.com/pricing/'
                    }
                }));
                return;
            }
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

        if (data.type === 'auth') {
            this.handleAuth(channel, data);
            return;
        }

        if (!channel.authenticated) {
            // Before authentication completes, buffer the latest operations
            // message so it can be applied atomically once auth succeeds.
            // All other messages are dropped. Operations/execute cannot be
            // processed until both the token and JWT are fully validated.
            if (data.type === 'operations') {
                channel.pendingOperations = data.operations ?? [];
            }
            return;
        }

        switch (data.type) {
            case 'operations':
                this.applyOperations(channel, data.operations ?? []);
                break;

            case 'response':
                this.handleResponse(data);
                break;
        }
    }

    private applyOperations(channel: BridgeChannel, operations: HtkOperation[]): void {
        const wasReady = this.isReady;
        channel.operations = operations;

        // Only emit events when the primary channel's operations change
        if (channel === this.primaryChannel) {
            if (!wasReady && this.isReady) {
                this.emit('ready');
            }
            this.emit('operations-changed', this.currentOperations);
        }
    }

    private handleAuth(channel: BridgeChannel, data: { token?: string; jwt: string | false }): void {
        const isFirstAuth = !channel.authenticated;

        // New sequence number per auth attempt — older in-flight validations
        // become stale and are discarded when they resolve.
        const seq = ++channel.authSeq;

        // Validate connection token (only required on the first auth).
        if (isFirstAuth && this.authToken) {
            if (data.token !== this.authToken) {
                console.warn('WebSocket auth failed: invalid token');
                this.sendAuthResult(channel, { success: false, error: 'Invalid auth token' });
                channel.ws.close(4003, 'Invalid auth token');
                return;
            }
        }

        // jwt: false means explicitly logged out / no account. Synchronous.
        if (data.jwt === false) {
            channel.user = undefined;
            if (isFirstAuth) this.completeInitialAuth(channel);
            this.sendAuthResult(channel, { success: true });
            return;
        }

        if (typeof data.jwt !== 'string') {
            channel.user = undefined;
            this.sendAuthResult(channel, {
                success: false,
                error: 'JWT must be a valid string or false'
            });
            channel.ws.close(1007, 'JWT must be a valid string or false');
            return;
        }

        getUserFromAppJwt(data.jwt).then((user) => {
            // Discard stale validations that were superseded by a later auth.
            if (seq !== channel.authSeq) return;
            if (channel.ws.readyState !== WebSocket.OPEN) return;

            channel.user = user;
            if (isFirstAuth) this.completeInitialAuth(channel);
            this.sendAuthResult(channel, { success: true });
        }).catch((err) => {
            if (seq !== channel.authSeq) return;
            if (channel.ws.readyState !== WebSocket.OPEN) return;

            console.warn(`Failed to validate user JWT: ${err.message}`);
            channel.user = undefined;
            this.sendAuthResult(channel, {
                success: false,
                error: `JWT validation failed: ${err.message}`
            });
            channel.ws.close(1007, `JWT validation failed: ${err.message}`);
        });
    }

    private completeInitialAuth(channel: BridgeChannel): void {
        channel.authenticated = true;

        // Apply any operations that were buffered during authentication.
        // This guarantees operations are never exposed until auth succeeds.
        if (channel.pendingOperations !== undefined) {
            const ops = channel.pendingOperations;
            channel.pendingOperations = undefined;
            this.applyOperations(channel, ops);
        }
    }

    private sendAuthResult(
        channel: BridgeChannel,
        result: { success: true } | { success: false; error: string }
    ): void {
        if (channel.ws.readyState !== WebSocket.OPEN) return;
        channel.ws.send(JSON.stringify({ type: 'auth-result', ...result }));
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
