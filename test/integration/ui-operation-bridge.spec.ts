import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { expect } from 'chai';
import WebSocket, { WebSocketServer } from 'ws';

import { UiOperationBridge, HtkOperation } from '../../src/api/ui-operation-bridge';

function getTempSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-test-'));
    return path.join(dir, 'test.sock');
}

let testSocketPath: string;

function makeApiRequest(method: 'GET' | 'POST', urlPath: string, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method,
            path: urlPath,
            socketPath: testSocketPath,
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                const statusCode = res.statusCode!;
                try {
                    const parsed = JSON.parse(raw);
                    if (statusCode >= 400) {
                        const err: any = new Error(parsed.message || parsed.error || `HTTP ${statusCode}`);
                        err.statusCode = statusCode;
                        err.body = parsed;
                        reject(err);
                    } else {
                        resolve(parsed);
                    }
                } catch {
                    if (statusCode >= 400) {
                        reject(new Error(`HTTP ${statusCode}: ${raw}`));
                    } else {
                        resolve(raw);
                    }
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const TEST_OPERATIONS: HtkOperation[] = [
    {
        name: 'proxy.get-config',
        description: 'Get the proxy configuration',
        category: 'proxy',
        tiers: ['free', 'pro'],
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true }
    },
    {
        name: 'events.list',
        description: 'List captured HTTP events',
        category: 'events',
        tiers: ['free', 'pro'],
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Max events to return' }
            }
        },
        outputSchema: { type: 'object' }
    }
];

const PRO_ONLY_OPERATIONS: HtkOperation[] = [
    ...TEST_OPERATIONS,
    {
        name: 'interceptors.activate',
        description: 'Activate an interceptor',
        category: 'interceptors',
        tiers: ['pro'],
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' }
    }
];

// Creates a connected WebSocket pair: the server-side WS is given to the bridge,
// and the client-side WS is returned for sending mock UI messages.
function createWsPair(bridge: UiOperationBridge): Promise<{ clientWs: WebSocket; wss: WebSocketServer }> {
    return new Promise((resolve) => {
        const wss = new WebSocketServer({ port: 0 });

        wss.on('connection', (serverSideWs) => {
            bridge.setWebSocket(serverSideWs as any);
        });

        wss.on('listening', () => {
            const addr = wss.address() as { port: number };
            const clientWs = new WebSocket(`ws://127.0.0.1:${addr.port}`);
            clientWs.on('open', () => resolve({ clientWs, wss }));
        });
    });
}

// Helper to wait for a specific message type from the server
function waitForMessage(ws: WebSocket, type: string): Promise<any> {
    return new Promise((resolve) => {
        const handler = (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === type) {
                ws.removeListener('message', handler);
                resolve(msg);
            }
        };
        ws.on('message', handler);
    });
}

// Creates a connected pair, authenticates, sends the operations message, and
// waits for the bridge to be ready. The server always requires an auth message
// before processing operations (even without a configured token), so every
// connecting client must authenticate.
async function connectMockUi(
    bridge: UiOperationBridge,
    ops: HtkOperation[] = TEST_OPERATIONS,
    authToken?: string
): Promise<{ clientWs: WebSocket; wss: WebSocketServer }> {
    const pair = await createWsPair(bridge);
    const wasReady = bridge.isReady;

    // Always send auth first and wait for auth-result, matching real UI behavior.
    const authResultPromise = waitForMessage(pair.clientWs, 'auth-result');
    pair.clientWs.send(JSON.stringify({
        type: 'auth',
        token: authToken,
        jwt: false
    }));
    await authResultPromise;

    pair.clientWs.send(JSON.stringify({
        type: 'operations',
        operations: ops
    }));

    if (!wasReady) {
        await new Promise<void>(resolve => bridge.once('ready', resolve));
    } else {
        // Non-primary channel: no event emitted, just wait for the message to be processed.
        await new Promise(r => setTimeout(r, 50));
    }

    return pair;
}

describe("UiOperationBridge", () => {

    let bridge: UiOperationBridge;
    const activePairs: { clientWs: WebSocket; wss: WebSocketServer }[] = [];

    beforeEach(async () => {
        bridge = new UiOperationBridge();
        testSocketPath = getTempSocketPath();
        await bridge.startApiServer(testSocketPath);
    });

    afterEach((done) => {
        for (const pair of activePairs) {
            if (pair.clientWs.readyState === WebSocket.OPEN) pair.clientWs.close();
            pair.wss.close();
        }
        activePairs.length = 0;

        bridge.destroy();

        try { fs.unlinkSync(testSocketPath); } catch {}
        try { fs.rmdirSync(path.dirname(testSocketPath)); } catch {}
        done();
    });

    async function setupMockUi(ops: HtkOperation[] = TEST_OPERATIONS, authToken?: string) {
        const pair = await connectMockUi(bridge, ops, authToken);
        activePairs.push(pair);
        return pair;
    }

    describe("HTTP API without UI connected", () => {

        it("should return status with ready=false", async () => {
            const result = await makeApiRequest('GET', '/api/status');
            expect(result).to.deep.equal({ ready: false });
        });

        it("should return 503 for operations when not ready", async () => {
            try {
                await makeApiRequest('GET', '/api/operations');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(503);
            }
        });

        it("should return 503 for execute when not ready", async () => {
            try {
                await makeApiRequest('POST', '/api/execute', {
                    name: 'proxy.get-config',
                    args: {}
                });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(503);
            }
        });
    });

    describe("HTTP API with UI connected", () => {

        beforeEach(async () => {
            await setupMockUi();
        });

        it("should return status with ready=true", async () => {
            const result = await makeApiRequest('GET', '/api/status');
            expect(result).to.deep.equal({ ready: true });
        });

        it("should return operations list", async () => {
            const result = await makeApiRequest('GET', '/api/operations');
            expect(result).to.be.an('array').with.length(2);
            expect(result[0].name).to.equal('proxy.get-config');
            expect(result[1].name).to.equal('events.list');
        });

        it("should include annotations in operations", async () => {
            const result = await makeApiRequest('GET', '/api/operations');
            expect(result[0].annotations).to.deep.equal({ readOnlyHint: true });
        });

        it("should proxy execute requests to the UI and return results", async () => {
            const mockResult = { port: 8000, ip: '127.0.0.1' };

            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: mockResult
                    }));
                }
            });

            const result = await makeApiRequest('POST', '/api/execute', {
                name: 'proxy.get-config',
                args: {}
            });
            expect(result).to.deep.equal(mockResult);
        });

        it("should forward operation arguments to the UI", async () => {
            let receivedParams: any;

            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    receivedParams = msg.params;
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: { events: [] }
                    }));
                }
            });

            await makeApiRequest('POST', '/api/execute', {
                name: 'events.list',
                args: { limit: 10 }
            });

            expect(receivedParams).to.deep.equal({ limit: 10 });
        });

        it("should return 502 when the UI returns an error", async () => {
            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        error: 'Something went wrong'
                    }));
                }
            });

            try {
                await makeApiRequest('POST', '/api/execute', {
                    name: 'proxy.get-config',
                    args: {}
                });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(502);
            }
        });

        it("should return 400 for execute with missing operation name", async () => {
            try {
                await makeApiRequest('POST', '/api/execute', { args: {} });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(400);
            }
        });

        it("should return 404 for unknown paths", async () => {
            try {
                await makeApiRequest('GET', '/api/unknown');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(404);
            }
        });
    });

    describe("Authentication", () => {

        it("should require an auth message even when no auth token is configured", async () => {
            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            await new Promise(r => setTimeout(r, 100));
            expect(bridge.isReady).to.be.false;

            // After sending auth, the buffered operations are applied.
            const readyPromise = new Promise<void>(resolve => bridge.once('ready', resolve));
            pair.clientWs.send(JSON.stringify({ type: 'auth', jwt: false }));
            await readyPromise;

            expect(bridge.isReady).to.be.true;
        });

        it("should require auth message before processing operations when token configured", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            // Send operations without auth — should be ignored
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            await new Promise(r => setTimeout(r, 100));
            expect(bridge.isReady).to.be.false;
        });

        it("should authenticate and become ready with correct token", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            await setupMockUi(TEST_OPERATIONS, 'test-secret');
            expect(bridge.isReady).to.be.true;
        });

        it("should send auth-result success on valid token", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            const authResultPromise = waitForMessage(pair.clientWs, 'auth-result');

            pair.clientWs.send(JSON.stringify({
                type: 'auth',
                token: 'test-secret',
                jwt: false
            }));

            const result = await authResultPromise;
            expect(result.success).to.be.true;
        });

        it("should send auth-result failure and close on invalid token", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            const authResultPromise = waitForMessage(pair.clientWs, 'auth-result');

            pair.clientWs.send(JSON.stringify({
                type: 'auth',
                token: 'wrong-token',
                jwt: false
            }));

            const result = await authResultPromise;
            expect(result.success).to.be.false;
            expect(result.error).to.include('Invalid');
        });

        it("should accept jwt: false to indicate logged out", async () => {
            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            const authResultPromise = waitForMessage(pair.clientWs, 'auth-result');

            pair.clientWs.send(JSON.stringify({
                type: 'auth',
                jwt: false
            }));

            const result = await authResultPromise;
            expect(result.success).to.be.true;
        });

        it("should buffer operations sent before auth and apply them on auth success", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            // Send operations BEFORE auth — these should be buffered, not processed
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            // Give the bridge a chance to process the message
            await new Promise(r => setTimeout(r, 50));
            expect(bridge.isReady).to.be.false;

            // Verify external clients see no operations
            try {
                await makeApiRequest('GET', '/api/operations');
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(503);
            }

            // Now send auth — buffered operations should be applied and bridge should become ready
            const readyPromise = new Promise<void>(resolve => bridge.once('ready', resolve));
            pair.clientWs.send(JSON.stringify({
                type: 'auth',
                token: 'test-secret',
                jwt: false
            }));
            await readyPromise;

            expect(bridge.isReady).to.be.true;
            const result = await makeApiRequest('GET', '/api/operations');
            expect(result).to.have.length(2);
        });

        it("should discard buffered operations if initial auth fails", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            // Send operations first — will be buffered
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            // Send auth with invalid token — connection should close
            const closedPromise = new Promise<void>(resolve =>
                pair.clientWs.on('close', () => resolve())
            );
            pair.clientWs.send(JSON.stringify({
                type: 'auth',
                token: 'wrong-token',
                jwt: false
            }));

            await closedPromise;
            expect(bridge.isReady).to.be.false;
        });

        it("should not process execute requests during pending authentication", async () => {
            bridge.destroy();
            bridge = new UiOperationBridge('test-secret');
            testSocketPath = getTempSocketPath();
            await bridge.startApiServer(testSocketPath);

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            // Send operations before auth — buffered
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));
            await new Promise(r => setTimeout(r, 50));

            // Execute should be rejected because the bridge isn't ready
            try {
                await makeApiRequest('POST', '/api/execute', {
                    name: 'proxy.get-config',
                    args: {}
                });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(503);
            }
        });
    });

    describe("CTL/MCP source-based access control", () => {

        beforeEach(async () => {
            // Use operations that include a pro-only operation
            await setupMockUi(PRO_ONLY_OPERATIONS);

            // Auto-respond to execute requests
            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: { success: true }
                    }));
                }
            });
        });

        it("should block all CTL operations when user is not paid", async () => {
            // No JWT was sent, so isPaidUser() returns false
            try {
                await makeApiRequest('POST', '/api/execute', {
                    name: 'proxy.get-config',
                    args: {},
                    source: 'ctl'
                });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(403);
                expect(err.body.error.code).to.equal('TIER_REQUIRED_PRO');
            }
        });

        it("should allow MCP free-tier operations when user is not paid", async () => {
            const result = await makeApiRequest('POST', '/api/execute', {
                name: 'proxy.get-config',
                args: {},
                source: 'mcp'
            });
            expect(result).to.deep.equal({ success: true });
        });

        it("should block MCP pro-only operations when user is not paid", async () => {
            try {
                await makeApiRequest('POST', '/api/execute', {
                    name: 'interceptors.activate',
                    args: {},
                    source: 'mcp'
                });
                expect.fail('Should have thrown');
            } catch (err: any) {
                expect(err.statusCode).to.equal(403);
                expect(err.body.error.code).to.equal('TIER_REQUIRED_PRO');
            }
        });

        it("should allow operations without a source field", async () => {
            const result = await makeApiRequest('POST', '/api/execute', {
                name: 'proxy.get-config',
                args: {}
            });
            expect(result).to.deep.equal({ success: true });
        });
    });

    describe("Bridge events", () => {

        it("should emit 'ready' when UI sends auth and operations", async () => {
            const readyPromise = new Promise<void>((resolve) => {
                bridge.on('ready', resolve);
            });

            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            pair.clientWs.send(JSON.stringify({ type: 'auth', jwt: false }));
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            await readyPromise;
        });

        it("should emit 'operations-changed' when UI updates operations", async () => {
            await setupMockUi();

            const changedPromise = new Promise<HtkOperation[]>((resolve) => {
                bridge.on('operations-changed', resolve);
            });

            const newOps: HtkOperation[] = [{
                name: 'test.op',
                description: 'A new operation',
                category: 'test',
                tiers: ['free', 'pro'],
                inputSchema: { type: 'object', properties: {} },
                outputSchema: { type: 'object' }
            }];

            activePairs[0].clientWs.send(JSON.stringify({
                type: 'operations',
                operations: newOps
            }));

            const result = await changedPromise;
            expect(result).to.have.length(1);
            expect(result[0].name).to.equal('test.op');
        });

        it("should become not-ready when UI disconnects", async () => {
            await setupMockUi();
            expect(bridge.isReady).to.be.true;

            const notReadyPromise = new Promise<void>((resolve) => {
                bridge.on('not-ready', resolve);
            });

            activePairs[0].clientWs.close();
            await notReadyPromise;
            expect(bridge.isReady).to.be.false;
        });
    });

    describe("Error handling", () => {

        it("should not crash on malformed JSON request body", async () => {
            await setupMockUi();
            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response', id: msg.id, result: { ok: true }
                    }));
                }
            });

            // Send invalid JSON body
            await new Promise<void>((resolve, reject) => {
                const req = http.request({
                    method: 'POST',
                    path: '/api/execute',
                    socketPath: testSocketPath,
                    headers: { 'Content-Type': 'application/json' }
                }, (res) => {
                    expect(res.statusCode).to.equal(400);
                    res.resume();
                    res.on('end', () => resolve());
                });
                req.on('error', reject);
                req.write('this is not json');
                req.end();
            });

            // Verify the server still works afterward
            const result = await makeApiRequest('GET', '/api/status');
            expect(result.ready).to.be.true;
        });

        it("should not crash on malformed WebSocket message (invalid JSON)", async () => {
            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            pair.clientWs.send('not valid json');
            pair.clientWs.send(Buffer.from([0xff, 0xfe, 0xfd]));

            // Send valid messages afterward — the server should still be functional
            pair.clientWs.send(JSON.stringify({ type: 'auth', jwt: false }));
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            await new Promise<void>(resolve => bridge.once('ready', resolve));
            expect(bridge.isReady).to.be.true;
        });

        it("should not crash on WebSocket messages missing type field", async () => {
            const pair = await createWsPair(bridge);
            activePairs.push(pair);

            pair.clientWs.send(JSON.stringify({ no: 'type' }));
            pair.clientWs.send(JSON.stringify(null));
            pair.clientWs.send(JSON.stringify('just a string'));

            pair.clientWs.send(JSON.stringify({ type: 'auth', jwt: false }));
            pair.clientWs.send(JSON.stringify({
                type: 'operations',
                operations: TEST_OPERATIONS
            }));

            await new Promise<void>(resolve => bridge.once('ready', resolve));
            expect(bridge.isReady).to.be.true;
        });
    });

    describe("Multiple channels", () => {

        it("should use the first channel for operations", async () => {
            await setupMockUi();
            await setupMockUi([{
                name: 'other.op',
                description: 'Different operation',
                category: 'other',
                tiers: ['free', 'pro'],
                inputSchema: { type: 'object', properties: {} },
                outputSchema: { type: 'object' }
            }]);

            const result = await makeApiRequest('GET', '/api/operations');
            expect(result).to.have.length(2);
            expect(result[0].name).to.equal('proxy.get-config');
        });

        it("should route execute requests to the first channel", async () => {
            await setupMockUi();
            await setupMockUi();

            let channel1Received = false;
            let channel2Received = false;

            activePairs[0].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    channel1Received = true;
                    activePairs[0].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: { from: 'channel1' }
                    }));
                }
            });

            activePairs[1].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    channel2Received = true;
                    activePairs[1].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: { from: 'channel2' }
                    }));
                }
            });

            const result = await makeApiRequest('POST', '/api/execute', {
                name: 'proxy.get-config',
                args: {}
            });

            expect(result).to.deep.equal({ from: 'channel1' });
            expect(channel1Received).to.be.true;
            expect(channel2Received).to.be.false;
        });

        it("should fail over to the second channel when the first disconnects", async () => {
            await setupMockUi();
            await setupMockUi();

            activePairs[1].clientWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'request') {
                    activePairs[1].clientWs.send(JSON.stringify({
                        type: 'response',
                        id: msg.id,
                        result: { from: 'channel2' }
                    }));
                }
            });

            // Close the primary channel
            activePairs[0].clientWs.close();
            await new Promise<void>(resolve => {
                bridge.once('operations-changed', () => resolve());
            });

            expect(bridge.isReady).to.be.true;

            const result = await makeApiRequest('POST', '/api/execute', {
                name: 'proxy.get-config',
                args: {}
            });
            expect(result).to.deep.equal({ from: 'channel2' });
        });

        it("should become not-ready only when all channels disconnect", async () => {
            await setupMockUi();
            await setupMockUi();

            // Close the first channel — still ready
            activePairs[0].clientWs.close();
            await new Promise<void>(resolve => {
                bridge.once('operations-changed', () => resolve());
            });
            expect(bridge.isReady).to.be.true;

            // Close the second channel — now not ready
            const notReadyPromise = new Promise<void>(resolve => {
                bridge.on('not-ready', resolve);
            });
            activePairs[1].clientWs.close();
            await notReadyPromise;
            expect(bridge.isReady).to.be.false;
        });

        it("should not emit not-ready when a non-primary channel disconnects", async () => {
            await setupMockUi();
            await setupMockUi();

            let notReadyEmitted = false;
            bridge.on('not-ready', () => { notReadyEmitted = true; });

            // Close the second (non-primary) channel
            activePairs[1].clientWs.close();
            // Give the event loop a chance to emit
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(notReadyEmitted).to.be.false;
            expect(bridge.isReady).to.be.true;
        });
    });
});
