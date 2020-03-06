export interface HtkConfig {
    appName: string;
    configPath: string;
    authToken?: string;
    https: {
        keyPath: string;
        certPath: string;
        certContent: string;
        keyLength: number;
    }
}