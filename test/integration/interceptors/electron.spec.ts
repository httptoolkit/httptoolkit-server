import _ from 'lodash';
import * as os from 'os';
import * as fs from 'fs';
import { CompletedRequest } from 'mockttp';
import { setupInterceptor, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

import { expect } from 'chai';

const interceptorSetup = setupInterceptor('electron');

// We use slack as a test app. Doesn't really matter what it is, but
// slack is pretty common, easy to kill & restart, and fairly representative.
const electronAppPath: string | undefined = [
    '/usr/local/bin/slack', // Wrapper, used in CI to inject --no-sandbox
    '/usr/bin/slack',
    '/Applications/Slack.app/Contents/MacOS/Slack',
    `${os.homedir()}\\AppData\\Local\\slack\\slack.exe`
].find((path) => fs.existsSync(path));

describe('Electron interception', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.forAnyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor } = await interceptorSetup;

        await interceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);

    it('can be activated', async function () {
        if (!electronAppPath) this.skip();

        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.activate(server.port, {
            pathToApplication: electronAppPath
        });
        expect(interceptor.isActive(server.port)).to.equal(true);
        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(false);
    });

    it('successfully makes requests', async function () {
        if (!electronAppPath) this.skip();

        const { server, interceptor } = await interceptorSetup;

        const slackRequestReceived = new Promise<CompletedRequest>((resolve) =>
            server.on('request', (req) => {
                if (req.url.includes('slack.com')) {
                    resolve(req);
                }
            })
        );

        await interceptor.activate(server.port, {
            pathToApplication: electronAppPath
        });

        // Only resolves if a slack request is intercepted
        await slackRequestReceived;
    });
});