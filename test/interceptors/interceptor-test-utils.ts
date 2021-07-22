import * as _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';

import { expect } from 'chai';

import { getLocal, generateCACertificate, Mockttp } from 'mockttp';

import { buildInterceptors, Interceptor } from '../../src/interceptors';

const getCertificateDetails = _.memoize(async (configPath: string) => {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const newCertPair = await generateCACertificate({ commonName: 'HTTP Toolkit CA - DO NOT TRUST' });

    fs.writeFileSync(keyPath, newCertPair.key);
    fs.writeFileSync(certPath, newCertPair.cert);

    return { certPath, keyPath, certContent: newCertPair.cert, keyLength: 2048};
});

type TestSetup = {
    server: Mockttp,
    configPath: string,
    httpsConfig: { certPath: string, keyPath: string, certContent: string, keyLength: number }
};

export async function setupTest(): Promise<TestSetup> {
    const configPath = tmp.dirSync({ unsafeCleanup: true }).name;

    const httpsConfig = await getCertificateDetails(configPath);

    const server = getLocal({ https: httpsConfig });

    return { server, configPath, httpsConfig };
}

type InterceptorSetup = TestSetup & {
    interceptor: Interceptor
};

export async function setupInterceptor(interceptor: string): Promise<InterceptorSetup> {
    const { server, configPath, httpsConfig } = await setupTest();
    const interceptors = buildInterceptors({ appName: "HTTP Toolkit", configPath, https: httpsConfig });

    return { server, configPath, httpsConfig, interceptor: interceptors[interceptor] };
}

// Various tests that we'll want to reuse across interceptors:

export function itIsAvailable(interceptorSetup: Promise<InterceptorSetup>) {
    it('is available', async () => {
        const { interceptor } = await interceptorSetup;
        expect(await interceptor.isActivable()).to.equal(true);
    });
}

export function itCanBeActivated(interceptorSetup: Promise<InterceptorSetup>) {
    it('can be activated', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.activate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(true);
        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(false);
    });

    it('can deactivate all', async () => {
        const { interceptor, server } = await interceptorSetup;

        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.activate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(true);
        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivateAll();
        expect(interceptor.isActive(server.port)).to.equal(false);
    });
}