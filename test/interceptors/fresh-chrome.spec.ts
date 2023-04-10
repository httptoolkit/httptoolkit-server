import _ from 'lodash';
import { CompletedRequest } from 'mockttp';
import { setupInterceptor, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

const interceptorSetup = setupInterceptor('fresh-chrome');

describe('Chrome interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.forAnyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor: chromeInterceptor } = await interceptorSetup;

        await chromeInterceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);
    itCanBeActivated(interceptorSetup);

    it('successfully makes requests', async function () {
        const { server, interceptor: chromeInterceptor } = await interceptorSetup;

        const exampleRequestReceived = new Promise<CompletedRequest>((resolve) =>
            server.on('request', (req) => {
                if (req.url.startsWith('https://amiusing.httptoolkit.tech')) {
                    resolve(req);
                }
            })
        );

        await chromeInterceptor.activate(server.port);

        // Only resolves if amiusing request is sent successfully
        await exampleRequestReceived;
    });
});