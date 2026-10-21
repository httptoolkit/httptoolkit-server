const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const run = promisify(execFile);
const invalidRulesMessage = 'Invalid rules JSON: expected an object with an "items" array.';
const log = { info() {} };

function fakeServer() {
    return {
        fallbacks: 0,
        async addRequestRules(...rules) {
            this.fallbacks += rules.filter(rule => rule.priority === 0 && rule.steps[0].type === 'passthrough').length;
        }
    };
}

for (const entry of ['server.ts', 'server.js']) {
    const { applyHtkRules } = require(path.join('..', entry));
    const apply = (server, rules, addDefaultPassthrough) =>
        applyHtkRules(server, rules, log, { addDefaultPassthrough }, {});

    test(`${entry}: rejects malformed roots before registering a fallback`, async () => {
        for (const rules of [undefined, null, false, 0, '', 'rules', [], {}, { items: null }, { items: {} }]) {
            const server = fakeServer();
            await assert.rejects(apply(server, rules, true), { message: invalidRulesMessage });
            assert.equal(server.fallbacks, 0);
        }
    });

    test(`${entry}: reports a flag-added fallback`, async () => {
        const server = fakeServer();
        const result = await apply(server, { items: [] }, true);
        assert.deepEqual(result, { addedUnmatched: true, count: 0 });
        assert.equal(server.fallbacks, 1);
    });

    test(`${entry}: leaves passthrough disabled without the flag`, async () => {
        const server = fakeServer();
        const result = await apply(server, { items: [] }, false);
        assert.deepEqual(result, { addedUnmatched: false, count: 0 });
        assert.equal(server.fallbacks, 0);
    });

    for (const addDefaultPassthrough of [false, true]) {
        test(`${entry}: preserves and deduplicates existing fallbacks (flag=${addDefaultPassthrough})`, async () => {
            const server = fakeServer();
            const fallback = {
                type: 'http', activated: true,
                matchers: [{ type: 'wildcard' }], steps: [{ type: 'passthrough' }]
            };
            const result = await apply(server, { items: [{ items: [fallback, fallback] }] }, addDefaultPassthrough);
            assert.deepEqual(result, { addedUnmatched: true, count: 0 });
            assert.equal(server.fallbacks, 1);
        });
    }

    test(`${entry}: inactive fallback does not suppress the flag`, async () => {
        const server = fakeServer();
        const result = await apply(server, { items: [{
            type: 'http', activated: false,
            matchers: [{ type: 'wildcard' }], steps: [{ type: 'passthrough' }]
        }] }, true);
        assert.deepEqual(result, { addedUnmatched: true, count: 0 });
        assert.equal(server.fallbacks, 1);
    });

    test(`${entry}: an existing fallback with forwarding options suppresses the flag`, async () => {
        const registered = [];
        const result = await apply({ async addRequestRules(...rules) { registered.push(...rules); } }, { items: [{
            type: 'http', activated: true, priority: 0,
            matchers: [{ type: 'wildcard' }],
            steps: [{ type: 'passthrough', forwarding: { targetHost: 'example.test' } }]
        }] }, true);
        assert.equal(result.addedUnmatched, true); assert.equal(registered.length, 1);
        assert.equal(registered[0].steps[0].transformRequest.replaceHost.targetHost, 'example.test');
    });

    test(`${entry}: malformed rules fail CLI startup with a clear error`, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-proxy-invalid-rules-'));
        try {
            const rulesPath = path.join(directory, 'rules.json');
            for (const rules of [{}, { items: null }, null, false]) {
                await fs.writeFile(rulesPath, JSON.stringify(rules));
                const args = entry.endsWith('.ts') ? ['--import', 'tsx'] : [];
                args.push(entry, '--rules', rulesPath, '--port', '0', '--add-default-passthrough');
                await assert.rejects(run(process.execPath, args, {
                    cwd: path.join(__dirname, '..'),
                    env: { ...process.env, LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory },
                    timeout: 15000,
                    windowsHide: true
                }), error => {
                    assert.equal(error.code, 1);
                    assert.ok(error.stderr.includes(invalidRulesMessage), error.stderr);
                    assert.ok(!error.stdout.includes('Mock proxy listening'));
                    return true;
                });
            }
        } finally {
            assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(directory).startsWith('mock-proxy-invalid-rules-'));
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
}
