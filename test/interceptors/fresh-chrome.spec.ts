import * as _ from 'lodash';
import { CompletedRequest } from 'mockttp';
import { getInterceptorAndServer, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

const { server, interceptor: chromeInterceptor } = getInterceptorAndServer('fresh-chrome');

describe('Chrome interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        await server.start();
        await server.anyRequest().thenPassThrough();
    });

    afterEach(async () => {
        await chromeInterceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(chromeInterceptor);
    itCanBeActivated(chromeInterceptor, server);

    it('successfully makes requests', async function () {
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