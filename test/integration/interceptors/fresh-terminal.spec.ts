import _ from 'lodash';
import { fork } from 'child_process';

import { expect } from 'chai';

import { FIXTURES_DIR } from '../../test-util';
import { setupInterceptor, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';
import { getTerminalEnvVars } from '../../../src/interceptors/terminal/terminal-env-overrides';

const interceptorSetup = setupInterceptor('fresh-terminal');

describe('Fresh terminal interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
    });

    afterEach(async () => {
        const { server } = await interceptorSetup;
        await server.stop();
    });

    describe('run directly', () => {

        beforeEach(async () => {
            const { server } = await interceptorSetup;
            await server.forAnyRequest().thenPassThrough();
        });

        afterEach(async () => {
            const { server, interceptor } = await interceptorSetup;
            await interceptor.deactivate(server.port);
        });

        itIsAvailable(interceptorSetup);
        itCanBeActivated(interceptorSetup);
    });

    describe('simulated from env vars', () => {

        it("should intercept all popular JS libraries", async function () {
            this.timeout(10000);

            const { server, httpsConfig } = await interceptorSetup;

            const mainRule = await server.forGet(/https?:\/\/example.test\/js\/.*/).thenReply(200);
            const stripeRule = await server.forGet('https://api.stripe.com/v1/customers').thenJson(200, {});

            // Spawn node, as if it was run inside an intercepted terminal
            const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);
            const nodeScript = fork(require.resolve(`${FIXTURES_DIR}/terminal/js-test-script`), [], {
                execArgv: ['-r', require.resolve('../../../overrides/js/prepend-node.js')],
                env: Object.assign({}, process.env, terminalEnvOverrides)
            });
            await new Promise((resolve, reject) => {
                nodeScript.on('close', resolve);
                nodeScript.on('error', reject);
            });

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

});