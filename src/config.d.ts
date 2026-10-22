export interface HtkConfig {
    configPath: string;
    authToken?: string;
    https: {
        certificateMode?: import('./https-config').CertificateMode;
        keyPath: string;
        certPath: string;
        certContent: string;
        keyLength: number;
        certificateTransparency: boolean;
    }
}