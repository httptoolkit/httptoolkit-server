import * as _ from 'lodash';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

import { delay } from '@httptoolkit/util';
import * as request from 'request-promise-native';
import * as tmp from 'tmp';
import decompress from 'decompress';
import { expect } from 'chai';
import getGraphQL from 'graphql.js';
import fetch from 'node-fetch';

import { getRemote, getLocal } from 'mockttp';

async function setupServerPath() {
    if (!process.env.TEST_BUILT_TARBALL) {
        // By default, test the current folder code
        return path.join(__dirname, '..', '..', 'bin', 'run');
    }

    // If TEST_BUILT_TARBALL is set, test the latest built ready-to-go tarball:
    const tmpDir = tmp.dirSync({ prefix: 'name with spaces', unsafeCleanup: true }).name;
    const version: string = require(path.join('..', '..', 'package.json')).version;

    const channel = (version.split('-')[1] || '').split('.')[0];

    const tarballPath = path.join(
        __dirname,
        '..',
        '..',
        'build',
        'dist',
        `v${version}`,
        `${channel ? channel + '-' : ''}httptoolkit-server-v${version}-${process.platform}-${process.arch}.tar.gz`
    );

    console.log('Extracting built tarball to', tmpDir);
    await decompress(tarballPath, tmpDir);

    // Pretend this is being called by the real startup script,
    // so it acts like a proper prod build.
    process.env.HTTPTOOLKIT_SERVER_BINPATH = 'PROD-TEST';
    return path.join(tmpDir, 'httptoolkit-server', 'bin', 'run');
}

const buildGraphql = (
    url: string,
    // Pretend to be a browser on the real site:
    headers = { 'origin': 'https://app.httptoolkit.tech' }
) => getGraphQL(url, {
    asJSON: true,
    headers
});

describe('End-to-end server API test', function () {
    // Timeout needs to be long, as first test runs (e.g. in CI) generate
    // fresh certificates, which can take a little while.
    this.timeout(30000);

    let serverProcess: ChildProcess;
    let stdout = '';
    let stderr = '';

    beforeEach(async () => {
        const serverRunPath = await setupServerPath();

        serverProcess = spawn(serverRunPath, ['start'], {
            stdio: 'pipe'
        });
        stdout = "";
        stderr = "";

        console.log('---');

        return new Promise((resolve, reject) => {
            serverProcess.stdout!.on('data', (d) => {
                if (d.includes('Server started')) resolve();
                stdout = stdout + d.toString();
                console.log(d.toString().trimEnd());
            });

            serverProcess.stderr!.on('data', (d) => {
                console.warn(d.toString());

                // Some nodes warn about fs.promises - ignore it.
                if (d.toString().includes('ExperimentalWarning: The fs.promises API')) return;
                // We use _stream_wrap, in some node versions this is deprecated, for now ignore it
                if (d.toString().includes('The _stream_wrap module is deprecated')) return;
                // Deprecation in 'ftp' module (from pac-proxy) - only appears in built package, not source,
                // as node doesn't show these deprecations by default when fired within node_modules.
                if (d.toString().includes('Buffer() is deprecated') && process.env.TEST_BUILT_TARBALL) return;
                // If the config parent folder doesn't exist at all, we'll see an ENOENT, that's ok:
                if (d.toString().includes('[ENOENT]')) return;

                stderr = stderr + d.toString();
            });

            // Exit or error before our expected output means startup failed.
            serverProcess.on('close', reject);
            serverProcess.on('error', reject);
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
        expect(stdout).to.contain('\nServer started');
    });

    it('starts a Mockttp server', async () => {
        const mockttp = getRemote({
            adminServerUrl: 'http://localhost:45456',
            client: {
                // Pretend to be a browser on the real site:
                headers: { origin: 'https://app.httptoolkit.tech' }
            }
        });
        await mockttp.start();
        await mockttp.forGet('https://google.com').thenReply(200, 'Mock response');

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const response = await request.get('https://google.com', { proxy: mockttp.url });
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        expect(response).to.equal('Mock response');
        await mockttp.stop();
    });

    it('exposes the version via GraphQL', async () => {
        const graphql = buildGraphql('http://localhost:45457/');

        const response = await graphql(`
            query getVersion {
                version
            }
        `)();

        expect(response.version).to.equal(require('../../package.json').version);
    });

    it('exposes the version via REST', async () => {
        const response = await fetch('http://localhost:45457/version', {
            headers: { 'origin': 'https://app.httptoolkit.tech' }
        });

        expect(response.ok).to.equal(true);
        const responseData = await response.json();

        expect(responseData).to.deep.equal({
            version: require('../../package.json').version
        });
    });

    it('rejects all requests with invalid origins', async () => {
        const graphql = buildGraphql('http://localhost:45457/', {
            origin: 'https://unknown.test'
        });

        const restWrongOriginResponse = await fetch('http://localhost:45457/version', {
            headers: { 'origin': 'https://unknown.test' }
        });

        const restNoOriginResponse = await fetch('http://localhost:45457/version', {
            headers: {}
        });

        expect(restWrongOriginResponse.status).to.equal(403);
        expect(restNoOriginResponse.status).to.equal(403);

        try {
            await graphql(`
                query getVersion {
                    version
                }
            `)();
            expect.fail('GraphQL request with invalid origin should fail');
        } catch (errorResponse: any) {
            // GraphQL.js handles errors weirdly, and just throws the response body. Oh well,
            // it's good enough to test this anyway:
            expect(errorResponse).to.deep.equal({
                error: { message: 'Invalid CORS headers' }
            });
        }
    });

    it('exposes the system configuration via REST', async () => {
        const response = await fetch('http://localhost:45457/config?proxyPort=8000', {
            headers: { 'origin': 'https://app.httptoolkit.tech' }
        });

        expect(response.ok).to.equal(true);
        const responseData = await response.json();

        const { config } = responseData;
        expect(config.certificatePath).not.to.equal(undefined);
        expect(config.certificateContent).not.to.equal(undefined);
        expect(config.certificateFingerprint).not.to.equal(undefined);
        expect(Object.keys(config.networkInterfaces).length).to.be.greaterThan(0);
        expect(config.ruleParameterKeys).to.deep.equal([]);
        expect(config.dnsServers.length).to.equal(1);
    });

    it('exposes interceptors over GraphQL & REST', async function () {
        // Browser detection on a fresh machine (i.e. in CI) with many browsers
        // installed can take a couple of seconds. Give it one retry.
        this.retries(1);

        const graphql = buildGraphql('http://localhost:45457/');
        const gqlResponse = await graphql(`
            query getInterceptors($proxyPort: Int!) {
                interceptors {
                    id
                    version
                    isActive(proxyPort: $proxyPort)
                    isActivable
                }
            }
        `)({ proxyPort: 8000 });

        const restResponse = await (await fetch('http://localhost:45457/interceptors?proxyPort=8000', {
            headers: { 'origin': 'https://app.httptoolkit.tech' }
        })).json();

        // We drop metadata - much harder to assert against.
        restResponse.interceptors.forEach((interceptor: any) => {
            delete interceptor.metadata;
        });

        expect(gqlResponse).to.deep.equal(restResponse);

        const activable = (id: string, version = '1.0.0') => ({
            id,
            version,
            "isActivable": true,
            "isActive": false
        });

        const inactivable = (id: string, version = '1.0.0') => ({
            id,
            version,
            "isActivable": false,
            "isActive": false
        });

        expect(restResponse.interceptors).to.deep.equal([
            activable('fresh-chrome'),
            activable('existing-chrome'),
            inactivable('fresh-chrome-beta'),
            inactivable('fresh-chrome-dev'),
            inactivable('fresh-chrome-canary'),
            inactivable('fresh-chromium'),
            inactivable('fresh-chromium-dev'),
            inactivable('fresh-edge'),
            inactivable('fresh-edge-beta'),
            inactivable('fresh-edge-dev'),
            inactivable('fresh-edge-canary'),
            inactivable('fresh-opera', '1.0.3'),
            inactivable('fresh-brave'),
            activable('fresh-firefox', '1.2.0'),
            inactivable('fresh-firefox-dev', '1.2.0'),
            inactivable('fresh-firefox-nightly', '1.2.0'),
            activable('fresh-terminal'),
            activable('existing-terminal'),
            activable('electron', '1.0.1'),
            inactivable('android-adb'),
            inactivable('android-frida'),
            inactivable('ios-frida'),
            activable('attach-jvm', '1.0.1'),
            activable('docker-attach')
        ]);
    });

    it("allows activating interceptors via REST API", async () => {
        const response = await fetch('http://localhost:45457/interceptors/existing-terminal/activate/8000', {
            method: 'POST',
            headers: { 'origin': 'https://app.httptoolkit.tech' }
        });

        expect(response.ok).to.equal(true);
        const responseData = await response.json();
        expect(responseData).to.deep.equal({
            "result": {
                "metadata": {
                    "commands": {
                        "Bash": {
                            "command": "eval \"$(curl -sS localhost:8001/setup)\"",
                            "description": "Bash-compatible"
                        },
                        "Fish": {
                            "command": "curl -sS localhost:8001/fish-setup | source",
                            "description": "Fish"
                        },
                        "Powershell": {
                            "command": "Invoke-Expression (Invoke-WebRequest http://localhost:8001/ps-setup).Content",
                            "description": "Powershell"
                        }
                    },
                    "port": 8001
                },
                "success": true
            }
        });
    });

    describe("client API", () => {
        const mockServer = getLocal();

        beforeEach(() => mockServer.start());
        afterEach(() => mockServer.stop());

        it("can send HTTP requests", async () => {
            await mockServer.forAnyRequest().thenCallback(async (request) => {
                expect(request.method).to.equal('POST');
                expect(request.url).to.equal(`http://localhost:${mockServer.port}/abc?def`);
                expect(request.rawHeaders).to.deep.equal([
                    ['host', `localhost:${mockServer.port}`],
                    ['content-length', '12'],
                    ['TEST-header', 'Value']
                ]);
                expect(await request.body.getText()).to.equal('Request body');

                return {
                    statusCode: 200,
                    statusMessage: 'Custom status message',
                    headers: { 'custom-HEADER': 'custom-VALUE' },
                    rawBody: Buffer.from('Mock response body')
                };
            });

            const apiResponse = await fetch('http://localhost:45457/client/send', {
                method: 'POST',
                headers: {
                    'origin': 'https://app.httptoolkit.tech',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    request: {
                        method: 'POST',
                        url: mockServer.urlFor('/abc?def'),
                        headers: [
                            ['host', `localhost:${mockServer.port}`],
                            ['content-length', '12'],
                            ['TEST-header', 'Value'],
                        ],
                        rawBody: Buffer.from('Request body').toString('base64')
                    },
                    options: {}
                })
            });

            expect(apiResponse.status).to.equal(200);

            const apiResponseBody = await apiResponse.text();
            const responseEvents = apiResponseBody
                .split('\n')
                .filter(l => l.trim().length)
                .map(l => JSON.parse(l));

            expect(responseEvents.length).to.equal(4);
            expect(_.omit(responseEvents[0], 'timestamp', 'startTime')).to.deep.equal({
                type: 'request-start'
            });
            expect(_.omit(responseEvents[1], 'timestamp')).to.deep.equal({
                type: 'response-head',
                statusCode: 200,
                statusMessage: 'Custom status message',
                headers: [
                    ['custom-HEADER', 'custom-VALUE']
                ]
            });

            expect(responseEvents[2].type).equal('response-body-part');
            expect(
                Buffer.from(responseEvents[2].rawBody, 'base64').toString('utf8')
            ).to.equal('Mock response body');


            expect(_.omit(responseEvents[3], 'timestamp')).to.deep.equal({ type: 'response-end' });
        });
    })
});