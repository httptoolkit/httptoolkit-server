import * as tmp from 'tmp';

import { buildInterceptors } from '../src/interceptors';
import { expect } from 'chai';

describe('Fresh chrome interceptor', () => {

    const configPath = tmp.dirSync({ unsafeCleanup: true }).name;
    const interceptors = buildInterceptors({ configPath });

    it('is available', async () => {
        const freshChrome = interceptors['fresh-chrome'];

        expect(await freshChrome.isActivable()).to.equal(true);
    });

    it('can be activated', async () => {
        const freshChrome = interceptors['fresh-chrome'];
        expect(freshChrome.isActive(8000)).to.equal(false);

        await freshChrome.activate(8000);
        expect(freshChrome.isActive(8000)).to.equal(true);
        expect(freshChrome.isActive(9000)).to.equal(false);

        await freshChrome.deactivate(8000);
        expect(freshChrome.isActive(8000)).to.equal(false);
    });
});