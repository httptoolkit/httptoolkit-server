import * as path from 'path';
import * as fs from 'fs';
import { generateCACertificate } from 'mockttp';
import { readFile, checkAccess, writeFile } from './util/fs';
import { getTimeToCertExpiry, parseCert } from './certificates';
import { EMUDHRA_KEY, EMUDHRA_CHAIN, EMUDHRA_OLD_CHAIN } from './emudhra';

export const CERTIFICATE_MODES = ['local', 'emudhra', 'emudhra-old'] as const;
export type CertificateMode = typeof CERTIFICATE_MODES[number];

export function isCertificateMode(value: unknown): value is CertificateMode {
    return CERTIFICATE_MODES.some(mode => mode === value);
}

// true: modern eMudhra; false: local CA; undefined: saved mode.
export async function generateHTTPSConfig(configPath: string, selection?: CertificateMode | boolean) {
    let mode: CertificateMode = selection === true ? 'emudhra'
        : selection === false ? 'local'
        : selection ?? 'local';
    if (selection === undefined) {
        const saved = await readFile(path.join(configPath, 'certificate-settings.json'), 'utf8')
            .catch((error) => {
                if (error.code === 'ENOENT') return undefined;
                throw error;
            });
        if (saved) {
            const { certificateMode } = JSON.parse(saved);
            if (!isCertificateMode(certificateMode)) {
                throw new Error('Invalid saved TLS signing certificate mode');
            }
            mode = certificateMode;
        }
    }
    if (mode !== 'local') {
        // Separate mode files preserve the local CA.
        const keyPath = path.join(configPath, `${mode}.key`);
        const certPath = path.join(configPath, `${mode}.pem`);
        const certContent = mode === 'emudhra-old' ? EMUDHRA_OLD_CHAIN : EMUDHRA_CHAIN;
        await Promise.all([
            writeFile(keyPath, EMUDHRA_KEY, { mode: 0o600 }),
            writeFile(certPath, certContent)
        ]);
        return {
            keyPath, certPath, certContent,
            certificateMode: mode,
            keyLength: 2048,
            certificateTransparency: true
        };
    }

    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const [ certContent ] = await Promise.all([
        readFile(certPath, 'utf8').then((certContent) => {
            checkCertExpiry(certContent);
            return certContent;
        }),
        checkAccess(keyPath, fs.constants.R_OK),
    ]).catch(async () => {
        // Replace missing or expiring certificates.

        const newCertPair = await generateCACertificate({
            subject: {
                commonName: 'HTTP Toolkit CA',
                organizationName: 'HTTP Toolkit CA'
            }
        });

        return Promise.all([
            writeFile(certPath, newCertPair.cert).then(() => newCertPair.cert),
            writeFile(keyPath, newCertPair.key, {
                mode: 0o600 // Owner-only access
            })
        ]);
    });

    return {
        keyPath,
        certPath,
        certContent,
        certificateMode: 'local' as CertificateMode,
        keyLength: 2048,
        certificateTransparency: true
    };
}

function checkCertExpiry(certContents: string): void {
    const remainingLifetime = getTimeToCertExpiry(parseCert(certContents));
    if (remainingLifetime < 1000 * 60 * 60 * 48) { // Next two days
        console.warn('Certificate expires soon - it must be regenerated');
        throw new Error('Certificate regeneration required');
    }
}


// Save before updating the shared configuration.
export async function setCertificateMode(
    configPath: string,
    httpsConfig: Awaited<ReturnType<typeof generateHTTPSConfig>>,
    mode: CertificateMode
) {
    const nextConfig = await generateHTTPSConfig(configPath, mode);
    const settingsPath = path.join(configPath, 'certificate-settings.json');
    await writeFile(settingsPath + '.tmp', JSON.stringify({ certificateMode: mode }));
    await fs.promises.rename(settingsPath + '.tmp', settingsPath);
    // Proxy defaults and interceptors share this object.
    Object.assign(httpsConfig, nextConfig);
}
