import { expect } from 'chai';

import {
    getDockerTunnelProxySetting
} from '../../src/interceptors/docker/docker-interception-services';

describe("Docker interception services", () => {

    it("should fail open if Docker route lookup does not resolve quickly", async () => {
        const originalWarn = console.warn;
        console.warn = () => {};

        try {
            const proxySetting = getDockerTunnelProxySetting(
                8000,
                new Promise(() => {}),
                { timeoutMs: 10 }
            );

            const startTime = Date.now();
            const result = await proxySetting({ hostname: 'example.com' } as any);

            expect(result).to.equal(undefined);
            expect(Date.now() - startTime).to.be.lessThan(200);
        } finally {
            console.warn = originalWarn;
        }
    });

    it("should not use the Docker tunnel for non-Docker hostnames", async () => {
        const proxySetting = getDockerTunnelProxySetting(
            8000,
            Promise.resolve({
                dockerRoutedAliases: new Set(['service-a'])
            })
        );

        const result = await proxySetting({ hostname: 'example.com' } as any);

        expect(result).to.equal(undefined);
    });

});
