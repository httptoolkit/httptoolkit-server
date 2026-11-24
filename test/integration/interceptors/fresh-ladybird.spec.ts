import _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';

import { CompletedRequest, Mockttp } from 'mockttp';
import { expect } from 'chai';

import { buildInterceptors } from '../../../src/interceptors';

import { setupInterceptor, itCanBeActivated } from './interceptor-test-utils';

const interceptorSetup = setupInterceptor('fresh-ladybird');

// Resolves with the last request, once our test page has been requested this many times
const waitForPageRequests = (server: Mockttp, count: number) =>
    new Promise<CompletedRequest>((resolve) => {
        let seen = 0;
        server.on('request', (req) => {
            if (req.url !== 'https://amiusing.httptoolkit.tech/') return;
            seen += 1;
            if (seen === count) resolve(req);
        });
    });

describe('Ladybird interceptor', function () {
    this.timeout(20000);

    before(async function () {
        // Ladybird isn't available in all test environments yet
        const { interceptor } = await interceptorSetup;
        if (!await interceptor.isActivable()) this.skip();
    });

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.forAnyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor: ladybirdInterceptor } = await interceptorSetup;
        await ladybirdInterceptor.deactivate(server.port);
        await server.stop();
    });

    itCanBeActivated(interceptorSetup);

    it('successfully makes requests', async function () {
        const { server, interceptor: ladybirdInterceptor } = await interceptorSetup;

        const pageRequested = waitForPageRequests(server, 1);

        await ladybirdInterceptor.activate(server.port);

        // Only resolves if the request is successfully intercepted
        const request = await pageRequested;
        expect(request.headers['user-agent']).to.include('Ladybird/');
    });

    it('can be activated again while already running', async function () {
        const { server, interceptor: ladybirdInterceptor } = await interceptorSetup;

        const pageRequestedTwice = waitForPageRequests(server, 2);

        await ladybirdInterceptor.activate(server.port);
        await ladybirdInterceptor.activate(server.port);
        expect(ladybirdInterceptor.isActive(server.port)).to.equal(true);

        // The second activation opens the page again in the running browser
        await pageRequestedTwice;
    });

    it('can be activated twice at the same time', async function () {
        const { server, interceptor: ladybirdInterceptor } = await interceptorSetup;

        const pageRequestedTwice = waitForPageRequests(server, 2);

        await Promise.all([
            ladybirdInterceptor.activate(server.port),
            ladybirdInterceptor.activate(server.port)
        ]);
        expect(ladybirdInterceptor.isActive(server.port)).to.equal(true);

        // Both activations open the page, in the same browser
        await pageRequestedTwice;
    });

    it('deletes its profile once deactivated', async function () {
        const { server, configPath, interceptor: ladybirdInterceptor } = await interceptorSetup;

        const profilePath = path.join(
            await fs.promises.realpath(configPath),
            `ladybird${server.port}`
        );

        const profileExists = () => fs.promises.access(profilePath).then(() => true, () => false);

        await ladybirdInterceptor.activate(server.port);
        expect(await profileExists()).to.equal(true);

        await ladybirdInterceptor.deactivate(server.port);
        expect(await profileExists()).to.equal(false);
    });

    it('can be activated with a config path too long for a Unix socket', async function () {
        const { server, configPath, httpsConfig } = await interceptorSetup;

        const longConfigPath = path.join(configPath, 'long-path-'.repeat(12));
        await fs.promises.mkdir(longConfigPath);

        const ladybirdInterceptor = buildInterceptors({
            configPath: longConfigPath,
            https: httpsConfig
        })['fresh-ladybird'];

        const pageRequested = waitForPageRequests(server, 1);

        await ladybirdInterceptor.activate(server.port);
        expect(ladybirdInterceptor.isActive(server.port)).to.equal(true);

        // Ladybird exits at startup if it can't use its profile path
        await pageRequested;

        await ladybirdInterceptor.deactivate(server.port);
        expect(ladybirdInterceptor.isActive(server.port)).to.equal(false);
    });

    it('fails clearly if no usable profile path is available', async function () {
        const { server, configPath, httpsConfig } = await interceptorSetup;

        const longConfigPath = path.join(configPath, 'long-config-'.repeat(12));
        const longTmpPath = path.join(configPath, 'long-tmp-'.repeat(12));
        await fs.promises.mkdir(longConfigPath);
        await fs.promises.mkdir(longTmpPath);

        const ladybirdInterceptor = buildInterceptors({
            configPath: longConfigPath,
            https: httpsConfig
        })['fresh-ladybird'];

        const originalEnv = _.pick(process.env, 'TMPDIR', 'XDG_RUNTIME_DIR');
        process.env.TMPDIR = longTmpPath;
        delete process.env.XDG_RUNTIME_DIR;

        try {
            const result = await ladybirdInterceptor.activate(server.port).catch(e => e);
            expect(result).to.be.instanceOf(Error);
            expect(result.message).to.include('too long for a Unix socket');
            expect(ladybirdInterceptor.isActive(server.port)).to.equal(false);
        } finally {
            delete process.env.TMPDIR;
            Object.assign(process.env, originalEnv);
        }
    });
});
