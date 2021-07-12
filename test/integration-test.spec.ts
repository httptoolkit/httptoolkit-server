import { promisify } from 'util';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { getRemote } from 'mockttp';
import * as request from 'request-promise-native';
import * as tmp from 'tmp';
import { extractTarball as extractTarballCb } from 'tarball-extract';
const extractTarball = promisify(extractTarballCb) as (source: string, dest: string) => Promise<void>;

import * as getGraphQL from 'graphql.js';

import { delay } from '../src/util';
import { expect } from 'chai';

async function setupServerPath() {
    if (!process.env.TEST_BUILT_TARBALL) {
        // By default, test the current folder code
        return path.join(__dirname, '..', 'bin', 'run');
    }

    // If TEST_BUILT_TARBALL is set, test the latest built ready-to-go tarball:
    const tmpDir = tmp.dirSync({ prefix: 'name with spaces', unsafeCleanup: true }).name;
    const version: string = require(path.join('..', 'package.json')).version;

    const channel = (version.split('-')[1] || '').split('.')[0];

    const tarballPath = path.join(
        __dirname,
        '..',
        'build',
        'dist',
        `v${version}`,
        `${channel ? channel + '-' : ''}httptoolkit-server-v${version}-${process.platform}-${process.arch}.tar.gz`
    );

    console.log('Extracting built tarball to', tmpDir);
    await extractTarball(tarballPath, tmpDir);

    // Pretend this is being called by the real startup script,
    // so it acts like a proper prod build.
    process.env.HTTPTOOLKIT_SERVER_BINPATH = 'PROD-TEST';
    return path.join(tmpDir, 'httptoolkit-server', 'bin', 'run');
}

const buildGraphql = (url: string) => getGraphQL(url, {
    asJSON: true,
    // Pretend to be a browser on the real site:
    headers: { 'origin': 'https://app.httptoolkit.tech' }
});

describe('Integration test', function () {
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

        return new Promise((resolve, reject) => {
            serverProcess.stdout!.on('data', (d) => {
                if (d.includes('Server started')) resolve();
                stdout = stdout + d.toString();
                console.log(d.toString());
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
            standaloneServerUrl: 'http://localhost:45456',
            client: {
                // Pretend to be a browser on the real site:
                headers: { origin: 'https://app.httptoolkit.tech' }
            }
        });
        await mockttp.start();
        await mockttp.get('https://google.com').thenReply(200, 'Mock response');

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const response = await request.get('https://google.com', { proxy: mockttp.url });
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        expect(response).to.equal('Mock response');
    });

    it('exposes the version over HTTP', async () => {
        const graphql = buildGraphql('http://localhost:45457/');

        const response = await graphql(`
            query getVersion {
                version
            }
        `)();

        expect(response.version).to.equal(require('../package.json').version);
    });

    it('exposes interceptors over HTTP', async () => {
        const graphql = buildGraphql('http://localhost:45457/');

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

        expect(response.interceptors).to.deep.equal([
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
            activable('fresh-firefox', '1.1.0'),
            activable('fresh-terminal'),
            activable('existing-terminal'),
            activable('electron', '1.0.1'),
            inactivable('android-adb'),
            activable('attach-jvm', '1.0.1'),
            activable('docker-all'),
            activable('docker-container')
        ]);
    });
});