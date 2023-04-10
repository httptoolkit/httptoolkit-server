import _ from 'lodash';
import * as util from 'util';
import { exec } from 'child_process';

import { expect } from 'chai';

import fetch from 'node-fetch';

import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';

const execAsync = util.promisify(exec);

const interceptorSetup = setupInterceptor('existing-terminal');

describe('Existing terminal interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
    });

    afterEach(async () => {
        const { server, interceptor } = await interceptorSetup;
        await interceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);

    it('can be activated', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        const result = await interceptor.activate(server.port) as { port: number };
        expect(interceptor.isActive(server.port)).to.equal(false);
        await fetch(`http://localhost:${result.port}/setup`);
        await fetch(`http://localhost:${result.port}/success`, { method: 'POST' });
        expect(interceptor.isActive(server.port)).to.equal(true);

        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(false);
    });

    it('can deactivate all', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        const result = await interceptor.activate(server.port) as { port: number };
        await fetch(`http://localhost:${result.port}/setup`);
        await fetch(`http://localhost:${result.port}/success`, { method: 'POST' });
        expect(interceptor.isActive(server.port)).to.equal(true);

        await interceptor.deactivateAll();
        expect(interceptor.isActive(server.port)).to.equal(false);
    });

    it('can deactivate after failed activation', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        const result = await interceptor.activate(server.port) as { port: number };
        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.deactivateAll();
        expect(interceptor.isActive(server.port)).to.equal(false);

        const setupResponse = await fetch(`http://localhost:${result.port}/setup`).catch(e => e);
        expect(setupResponse).to.be.instanceOf(Error);
    });

    it("should intercept all popular JS libraries", async function () {
        this.timeout(10000);
        const { interceptor, server } = await interceptorSetup;
        const result = await interceptor.activate(server.port) as { port: number, commands: { [shell: string]: { command: string } } };

        const mainRule = await server.forGet(/https?:\/\/example.test\/js\/.*/).thenReply(200);
        const stripeRule = await server.forGet('https://api.stripe.com/v1/customers').thenJson(200, {});

        const scriptOutput = await execAsync(`
            ${result.commands['Bash'].command}
            node "${require.resolve('../fixtures/terminal/js-test-script')}"
        `, {
            shell: '/bin/bash'
        });

        expect(scriptOutput.stdout).to.contain("HTTP Toolkit interception enabled");
        expect(interceptor.isActive(server.port)).to.equal(true);

        const seenRequests = _.concat(...await Promise.all([
            mainRule.getSeenRequests(),
            stripeRule.getSeenRequests()
        ])).map(r => r.url.replace(':443', '').replace(':80', ''));

        // Built-in modules
        expect(seenRequests).to.include('http://example.test/js/http');
        expect(seenRequests).to.include('https://example.test/js/https');

        // http & https with lots of popular libraries
        ['http', 'https'].forEach((protocol) =>
            [
                'request',
                'axios',
                'superagent',
                'node-fetch',
                'got',
                'bent',
                'unirest',
                'reqwest',
                'needle',
                'undici'
            ].forEach((library) =>
                expect(seenRequests).to.include(`${protocol}://example.test/js/${library}`)
            )
        );

        // Special case modules that need manual handling:
        expect(seenRequests).to.include('https://api.stripe.com/v1/customers');
    });

});