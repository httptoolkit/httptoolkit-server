import * as path from 'path';
import { OVERRIDES_DIR } from './interceptors/terminal/terminal-env-overrides';

import { deleteFile, writeFile } from "./util/fs";

export const WEBEXTENSION_PATH = path.join(OVERRIDES_DIR, 'webextension');

interface WebExtensionConfig { // Should match config in the WebExtension itself
    mockRtc: {
        peerId: string;
        adminBaseUrl: string;
    } | false;
}

const getConfigKey = (proxyPort: number) =>
    `127_0_0_1.${proxyPort}`; // Filename-safe proxy address

const getConfigPath = (proxyPort: number) =>
    path.join(WEBEXTENSION_PATH, 'config', getConfigKey(proxyPort));

export function clearWebExtensionConfig(httpProxyPort: number) {
    return deleteFile(getConfigPath(httpProxyPort))
        .catch(() => {}); // We ignore errors - nothing we can do, not very important.
}

export async function updateWebExtensionConfig(
    sessionId: string,
    httpProxyPort: number,
    webRTCEnabled: boolean
) {
    if (webRTCEnabled) {
        const adminBaseUrl = `http://internal.httptoolkit.localhost:45456/session/${sessionId}`;
        await writeConfig(httpProxyPort, {
            mockRtc: {
                peerId: 'matching-peer',
                adminBaseUrl
            }
        });
    } else {
        await writeConfig(httpProxyPort, { mockRtc: false });
    }
}

async function writeConfig(proxyPort: number, config: WebExtensionConfig) {
    return writeFile(getConfigPath(proxyPort), JSON.stringify(config));
}