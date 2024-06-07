import { expect } from 'chai';
import * as FridaJs from 'frida-js';

import { FRIDA_SRIS, FRIDA_VERSION } from '../../src/interceptors/frida/frida-integration';

describe("Frida download SRIs", function () {
    this.timeout(30000); // Can be slow, since we're doing MB downloads & disk IO

    Object.entries(FRIDA_SRIS).forEach(([target, sriMap]) => {
        Object.entries(sriMap).forEach(([arch, expectedHash]) => {
            it(`should have the correct SRI for ${target}-${arch}`, async () => {
                const correctSriHash = await FridaJs.calculateFridaSRI({
                    ghToken: process.env.GITHUB_TOKEN,
                    arch: arch as any,
                    platform: target as any,
                    version: FRIDA_VERSION
                });

                expect(expectedHash).to.equal(correctSriHash[0]);
            });
        });
    });
});