export interface HtkConfig {
    configPath: string;
    https: {
        keyPath: string;
        certPath: string;
        certContent: string;
        keyLength: number;
    }
}