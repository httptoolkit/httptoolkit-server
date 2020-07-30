import { CompletedRequest } from 'mockttp';
import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';
import { expect } from 'chai';
import * as semver from 'semver';

const interceptorSetup = setupInterceptor('fresh-firefox');

describe('Firefox interceptor', function () {
    this.timeout(10000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.anyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor: firefoxInterceptor } = await interceptorSetup;

        if (semver.satisfies(process.version, '>=12')) {
            // For some reason Node 12+ is very fussy about Firefox shutdown disconnections,
            // so we work around that by just killing the server first. This is a short-term
            // fix really, but it does seem to be just a test problem, that doesn't
            // reproduce in real usage, even using new node releases.
            const serverPort = server.port;
            await server.stop();
            await firefoxInterceptor.deactivate(serverPort);
        } else {
            await firefoxInterceptor.deactivate(server.port);
            await server.stop();
        }
    });

    itIsAvailable(interceptorSetup);

    it('successfully makes requests', async function () {
        const { server, interceptor: firefoxInterceptor } = await interceptorSetup;

        const exampleRequestReceived = new Promise<CompletedRequest>((resolve) =>
            server.on('request', (req) => {
                if (req.url.startsWith('https://amiusing.httptoolkit.tech')) {
                    resolve(req);
                }
            })
        );

        await firefoxInterceptor.activate(server.port);

        // Only resolves if amiusing request is sent successfully
        await exampleRequestReceived;
    });

    it('can deactivate all', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.activate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(true);
        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivateAll();
        expect(interceptor.isActive(server.port)).to.equal(false);
    });
});