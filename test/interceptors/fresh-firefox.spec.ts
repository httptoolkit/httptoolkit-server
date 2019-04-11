import * as _ from 'lodash';
import { CompletedRequest } from 'mockttp';
import { setupInterceptor, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

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
    itCanBeActivated(interceptorSetup);

    // TODO: This doesn't work, as we need to manually accept the cert before
    // Firefox makes its HTTPS request to amiusing
    it.skip('successfully makes requests', async function () {
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
});