import * as _ from 'lodash';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import { expect } from 'chai';
import { getLocal, CompletedRequest, generateCACertificate, Mockttp } from 'mockttp';

import { buildInterceptors, Interceptor } from '../src/interceptors';

const configPath = tmp.dirSync({ unsafeCleanup: true }).name;

const keyPath = path.join(configPath, 'ca.key');
const certPath = path.join(configPath, 'ca.pem');
const newCertPair = generateCACertificate({ commonName: 'HTTP Toolkit CA - DO NOT TRUST' });
fs.writeFileSync(keyPath, newCertPair.key);
fs.writeFileSync(certPath, newCertPair.cert);

const server = getLocal({ https: { certPath, keyPath } });
const interceptors = buildInterceptors({ configPath });

_.forEach(interceptors, (interceptor, name) =>
    describe(`${name} interceptor`, function () {

        beforeEach(() => server.start());
        afterEach(async () => {
            await interceptor.deactivate(server.port);
            await server.stop();
        });

        it('is available', async () => {
            expect(await interceptor.isActivable()).to.equal(true);
        });

        it('can be activated', async () => {
            expect(interceptor.isActive(server.port)).to.equal(false);

            await interceptor.activate(server.port);
            expect(interceptor.isActive(server.port)).to.equal(true);
            expect(interceptor.isActive(server.port + 1)).to.equal(false);

            await interceptor.deactivate(server.port);
            expect(interceptor.isActive(server.port)).to.equal(false);
        });

        it('successfully makes requests', async () => {
            await server.anyRequest().thenPassThrough();

            const exampleRequestReceived = new Promise<CompletedRequest>((resolve) =>
                server.on('request', (req) => {
                    if (req.url.startsWith('https://example.com')) {
                        resolve(req);
                    }
                })
            );

            await interceptor.activate(server.port);

            // Only resolves if example.com request is sent successfully
            await exampleRequestReceived;
        });
    })
);