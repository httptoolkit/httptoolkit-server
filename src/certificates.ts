import * as crypto from 'crypto';
import * as forge from 'node-forge';

export const parseCert = forge.pki.certificateFromPem;

export function getCertExpiry(cert: forge.pki.Certificate): number {
    return cert.validity.notAfter.valueOf();
}

export function getTimeToCertExpiry(cert: forge.pki.Certificate): number {
    return getCertExpiry(cert) - Date.now();
}

// A series of magic incantations that matches the behaviour of openssl's
// -subject_hash_old output, as expected by Android's cert store.
export function getCertificateSubjectHash(cert: forge.pki.Certificate) {
    const derBytes = forge.asn1.toDer(
        (
            forge.pki as any
        ).distinguishedNameToAsn1(cert.subject)
    ).getBytes();

    return crypto.createHash('md5')
        .update(derBytes)
        .digest()
        .readUInt32LE(0)
        .toString(16);
}

// Get a full SHA1 hash of the certificate
export function getCertificateFingerprint(cert: forge.pki.Certificate) {
    return forge.md.sha1.create()
        .update(
            forge.asn1.toDer(
                forge.pki.certificateToAsn1(cert)
            ).getBytes()
        )
        .digest()
        .toHex();
}