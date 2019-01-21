import * as _ from 'lodash';
import { CompletedRequest } from 'mockttp';
import { getInterceptorAndServer, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

const { server, interceptor: terminalInterceptor } = getInterceptorAndServer('fresh-terminal');

describe('Terminal interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        await server.start();
        await server.anyRequest().thenPassThrough();
    });

    afterEach(async () => {
        await terminalInterceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(terminalInterceptor);
    itCanBeActivated(terminalInterceptor, server);

});