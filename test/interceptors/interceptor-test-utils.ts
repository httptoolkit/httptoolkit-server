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

    return { certPath, keyPath };
});

type InterceptorSetup = Promise<{
    server: Mockttp,
    interceptor: Interceptor,
    httpsConfig: { certPath: string, keyPath: string }
}>

export async function setupInterceptor(interceptor: string): InterceptorSetup {
    const configPath = tmp.dirSync({ unsafeCleanup: true }).name;

    const httpsConfig = await getCertificateDetails(configPath);

    const server = getLocal({ https: httpsConfig });
    const interceptors = buildInterceptors({ configPath, https: httpsConfig });

    return { server, interceptor: interceptors[interceptor], httpsConfig };
}

// Various tests that we'll want to reuse across interceptors:

export function itIsAvailable(interceptorSetup: InterceptorSetup) {
    it('is available', async () => {
        const { interceptor } = await interceptorSetup;
        expect(await interceptor.isActivable()).to.equal(true);
    });
}

export function itCanBeActivated(interceptorSetup: InterceptorSetup) {
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