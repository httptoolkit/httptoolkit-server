import * as tmp from 'tmp';

import { buildInterceptors } from '../src/interceptors';
import { expect } from 'chai';

describe('Fresh chrome interceptor', () => {

    const configPath = tmp.dirSync({ unsafeCleanup: true }).name;
    const interceptors = buildInterceptors(configPath);

    it('is available', async () => {
        const freshChrome = interceptors['fresh-chrome'];

        expect(await freshChrome.checkIfAvailable()).to.equal(true);
    });

    it('can be activated', async () => {
        const freshChrome = interceptors['fresh-chrome'];
        expect(freshChrome.isActive).to.equal(false);

        await freshChrome.activate();
        expect(freshChrome.isActive).to.equal(true);

        await freshChrome.deactivate();
        expect(freshChrome.isActive).to.equal(false);
    });
});