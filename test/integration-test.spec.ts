import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { getRemote } from 'mockttp';
import * as request from 'request-promise-native';

import * as getGraphQL from 'graphql.js';

import { delay } from '../src/util';
import { expect } from 'chai';

describe('Integration test', function () {
    // Timeout needs to be long, as first test runs (e.g. in CI) generate
    // fresh certificates, which can take a little while.
    this.timeout(30000);

    let serverProcess: ChildProcess;
    let stdout = '';
    let stderr = '';

    beforeEach(async () => {
        serverProcess = spawn(path.join(__dirname, '..', 'bin', 'run'), ['start'], {
            stdio: 'pipe'
        });
        stdout = "";
        stderr = "";

        return new Promise((resolve, reject) => {
            serverProcess.stdout.on('data', (d) => {
                resolve();
                stdout = stdout + d.toString();
                console.log(d.toString());
            });

            serverProcess.stderr.on('data', (d) => {
                reject();
                stderr = stderr + d.toString();
                console.warn(d.toString());
            });
        });
    });

    afterEach(() => {
        if (!serverProcess.killed) serverProcess.kill();
        expect(stderr).to.equal('');
    });

    it('starts and stops successfully', async () => {
        await delay(500);
        serverProcess.kill();

        expect(stderr).to.equal('');
        expect(stdout).to.equal('Server started\n');
    });

    it('starts a Mockttp server', async () => {
        const mockttp = getRemote();
        await mockttp.start();
        await mockttp.get('https://google.com').thenReply(200, 'Mock response');

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const response = await request.get('https://google.com', { proxy: mockttp.url });
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        expect(response).to.equal('Mock response');
    });

    it('exposes the version over HTTP', async () => {
        const graphql = getGraphQL('http://localhost:45457/', { asJSON: true });

        const response = await graphql(`
            query getVersion {
                version
            }
        `)();

        expect(response.version).to.equal(require('../package.json').version);
    });

    it('exposes interceptors over HTTP', async () => {
        const graphql = getGraphQL('http://localhost:45457/', { asJSON: true });

        const response = await graphql(`
            query getInterceptors($proxyPort: Int!) {
                interceptors {
                    id
                    version
                    isActive(proxyPort: $proxyPort)
                    isActivable
                }
            }
        `)({ proxyPort: 8000 });

        expect(response.interceptors).to.deep.equal([
            {
                "id": "fresh-chrome",
                "isActivable": true,
                "isActive": false,
                "version": "1.0.0"
            },
            {
                "id": "fresh-firefox",
                "isActivable": true,
                "isActive": false,
                "version": "1.0.0"
            },
            {
                "id": "fresh-terminal",
                "isActivable": true,
                "isActive": false,
                "version": "1.0.0"
            }
        ]);
    });
});