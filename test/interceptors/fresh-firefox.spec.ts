import * as _ from 'lodash';
import fetch from 'node-fetch';
import { CompletedRequest } from 'mockttp';
import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';
import { expect } from 'chai';
import { delay } from '../../src/util';

const interceptorSetup = setupInterceptor('fresh-firefox');

describe('Firefox interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.anyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor: firefoxInterceptor } = await interceptorSetup;
        await firefoxInterceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);

    it('successfully makes requests', async function () {
        this.timeout(10000);
        const { server, interceptor: firefoxInterceptor } = await interceptorSetup;

        await firefoxInterceptor.activate(server.port);

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
        await delay(500); // Wait to ensure the profile is cleaned up
    });
});