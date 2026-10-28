import * as crypto from 'crypto';
import * as forge from 'node-forge';

// Reads the first certificate in PEM bundles.
export const parseCert = (pem: string) => new crypto.X509Certificate(pem);

export function getCertExpiry(cert: crypto.X509Certificate): number {
    return new Date(cert.validTo).valueOf();
}

export function getTimeToCertExpiry(cert: crypto.X509Certificate): number {
    return getCertExpiry(cert) - Date.now();
}

// Android subject hash (OpenSSL -subject_hash_old).
export function getCertificateSubjectHash(cert: crypto.X509Certificate) {
    const certificate = forge.asn1.fromDer(cert.raw.toString('binary'));
    const tbs = (certificate.value as forge.asn1.Asn1[])[0];
    const fields = tbs.value as forge.asn1.Asn1[];
    // An explicit version shifts the subject index from 4 to 5.
    const hasVersion = fields[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC;
    const subject = fields[hasVersion ? 5 : 4];
    const subjectDer = Buffer.from(forge.asn1.toDer(subject).getBytes(), 'binary');

    return crypto.createHash('md5')
        .update(subjectDer)
        .digest()
        .readUInt32LE(0)
        .toString(16)
        .padStart(8, '0');
}

// Lowercase SHA-1 fingerprint for Android.
export function getCertificateFingerprint(cert: crypto.X509Certificate) {
    return crypto.createHash('sha1').update(cert.raw).digest('hex');
}
