import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tls from 'tls';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { execFileSync } from 'child_process';
import { expect } from 'chai';
import { getLocal, Mockttp } from 'mockttp';

import { generateHTTPSConfig, setCertificateMode } from '../../src/https-config';
import { EMUDHRA_CHAIN, EMUDHRA_KEY, EMUDHRA_OLD_CHAIN } from '../../src/emudhra';
import {
    parseCert, getCertExpiry, getCertificateFingerprint, getCertificateSubjectHash
} from '../../src/certificates';

describe('HTTPS CA configuration', () => {
    let configPath: string;
    let server: Mockttp | undefined;

    beforeEach(async () => {
        configPath = await fs.mkdtemp(path.join(os.tmpdir(), 'htk-ca-test-'));
    });
    afterEach(async () => {
        await server?.stop();
        server = undefined;
        await fs.rm(configPath, { recursive: true, force: true });
    });

    it('preserves and reuses the local CA when switching eMudhra on and off', async () => {
        const local = await generateHTTPSConfig(configPath);
        const localKey = await fs.readFile(local.keyPath, 'utf8');
        const emudhra = await generateHTTPSConfig(configPath, true);
        expect(emudhra.certContent).to.equal(EMUDHRA_CHAIN);
        expect(await fs.readFile(emudhra.keyPath, 'utf8')).to.equal(EMUDHRA_KEY);
        expect(await fs.readFile(emudhra.certPath, 'utf8')).to.equal(EMUDHRA_CHAIN);
        if (process.platform !== 'win32') {
            expect((await fs.stat(emudhra.keyPath)).mode & 0o777).to.equal(0o600);
        }
        const legacy = await generateHTTPSConfig(configPath, 'emudhra-old');
        expect(legacy.certContent).to.equal(EMUDHRA_OLD_CHAIN);
        expect(legacy.certPath).not.to.equal(emudhra.certPath);
        expect(legacy.keyPath).not.to.equal(emudhra.keyPath);
        expect(await fs.readFile(legacy.keyPath, 'utf8')).to.equal(EMUDHRA_KEY);
        expect(await fs.readFile(legacy.certPath, 'utf8')).to.equal(EMUDHRA_OLD_CHAIN);
        // Both bundles include every cross-sign, in different priority orders.
        const certs = (bundle: string) => bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!;
        expect(certs(emudhra.certContent)).to.have.length(3);
        expect(certs(legacy.certContent)).to.deep.equal([
            certs(emudhra.certContent)[2], ...certs(emudhra.certContent).slice(0, 2)
        ]);
        const restored = await generateHTTPSConfig(configPath);
        expect(restored).to.deep.equal(local);
        expect(await fs.readFile(local.keyPath, 'utf8')).to.equal(localKey);
    });

    it('uses the saved choice by default and honors explicit programmatic overrides', async () => {
        const local = await generateHTTPSConfig(configPath);
        const active = { ...local };
        await setCertificateMode(configPath, active, 'emudhra');
        expect(active.certificateMode).to.equal('emudhra');
        expect((await generateHTTPSConfig(configPath)).certificateMode).to.equal('emudhra');
        expect((await generateHTTPSConfig(configPath, false)).certificateMode).to.equal('local');
        await setCertificateMode(configPath, active, 'emudhra-old');
        expect((await generateHTTPSConfig(configPath)).certificateMode).to.equal('emudhra-old');
        expect(active.certContent).to.equal(EMUDHRA_OLD_CHAIN);
        expect((await generateHTTPSConfig(configPath, true)).certificateMode).to.equal('emudhra');
        await setCertificateMode(configPath, active, 'local');
        expect(active).to.deep.equal(local);
        expect((await generateHTTPSConfig(configPath, true)).certificateMode).to.equal('emudhra');
    });

    it('keeps the active CA if saving the new choice fails', async () => {
        const local = await generateHTTPSConfig(configPath);
        const active = { ...local };
        await fs.mkdir(path.join(configPath, 'certificate-settings.json'));
        let failed = false;
        try {
            await setCertificateMode(configPath, active, 'emudhra');
        } catch { failed = true; }
        expect(failed).to.equal(true);
        expect(active).to.deep.equal(local);
    });

    it('can enable eMudhra without generating a local CA', async () => {
        await generateHTTPSConfig(configPath, true);
        expect((await fs.readdir(configPath)).sort()).to.deep.equal(['emudhra.key', 'emudhra.pem']);
    });

    for (const mode of ['emudhra', 'emudhra-old'] as const) {
        const legacy = mode === 'emudhra-old';
        const rootFile = legacy ? 'aaa-certificate-services.pem' : 'emsign-ecc-root-g3.pem';
        const issuer = legacy ? 'AAA Certificate Services' : 'emSign Root TLS CA - G3';

        for (const sni of [true, false]) {
            it(`serves a trusted ${mode} chain ${sni ? 'with' : 'without'} SNI`, async () => {
                const config = await generateHTTPSConfig(configPath, mode);
                server = getLocal({ https: config });
                await server.start();
                const root = await fs.readFile(path.join(__dirname, '../fixtures', rootFile), 'utf8');
                const peer = await new Promise<tls.DetailedPeerCertificate>((resolve, reject) => {
                    const socket = tls.connect({
                        host: 'localhost',
                        port: server!.port,
                        servername: sni ? 'example.test' : undefined,
                        ca: root,
                        rejectUnauthorized: true
                    }, () => {
                        const cert = socket.getPeerCertificate(true);
                        socket.end();
                        resolve(cert);
                    });
                    socket.once('error', reject);
                });
                expect(peer.subject.CN).to.equal(sni ? 'example.test' : 'localhost');
                expect(peer.issuer.CN).to.equal('EM OV TLS CA - G3C');
                expect(peer.issuerCertificate.issuer.CN).to.equal(issuer);
            });
        }

        it(`intercepts an HTTPS CONNECT request with the ${mode} CA`, async () => {
            const config = await generateHTTPSConfig(configPath, mode);
            server = getLocal({ https: config });
            await server.start();
            await server.forGet('https://example.test/').thenReply(200, 'intercepted');
            const root = await fs.readFile(path.join(__dirname, '../fixtures', rootFile), 'utf8');
            const agent = new HttpsProxyAgent(server.url.replace('https:', 'http:'));
            try {
                const body = await new Promise<string>((resolve, reject) => {
                    https.get('https://example.test/', { agent, ca: root, rejectUnauthorized: true }, res => {
                        let text = '';
                        res.on('data', chunk => { text += chunk; });
                        res.on('end', () => resolve(text));
                        res.on('error', reject);
                    }).on('error', reject);
                });
                expect(body).to.equal('intercepted');
            } finally {
                agent.destroy();
            }
        });
    }

    for (const type of ['RSA', 'EC']) {
        it(`reads ${type} CA metadata and matches OpenSSL's Android subject hash`, async () => {
            const pem = type === 'EC' ? EMUDHRA_CHAIN : (await generateHTTPSConfig(configPath)).certContent;
            const cert = parseCert(pem);
            expect(getCertExpiry(cert)).to.equal(Date.parse(cert.validTo));
            expect(getCertificateFingerprint(cert)).to.equal(cert.fingerprint.replace(/:/g, '').toLowerCase());
            const opensslHash = execFileSync('openssl', ['x509', '-subject_hash_old', '-noout'], { input: pem }).toString().trim();
            expect(getCertificateSubjectHash(cert)).to.equal(opensslHash);
        });
    }
});
