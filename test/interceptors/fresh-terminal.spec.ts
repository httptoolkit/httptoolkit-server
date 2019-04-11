import * as _ from 'lodash';
import { setupInterceptor, itIsAvailable, itCanBeActivated } from './interceptor-test-utils';

const interceptorSetup = setupInterceptor('fresh-terminal');

describe('Terminal interceptor', function () {
    this.timeout(5000);

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
        await server.anyRequest().thenPassThrough();
    });

    afterEach(async () => {
        const { server, interceptor: terminalInterceptor } = await interceptorSetup;
        await terminalInterceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);
    itCanBeActivated(interceptorSetup);

});