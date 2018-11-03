import { HttpsPathOptions } from "mockttp/dist/util/tls";

export interface HtkConfig {
    configPath: string;
    https: HttpsPathOptions
}