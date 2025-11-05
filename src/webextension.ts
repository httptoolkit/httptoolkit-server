import * as path from 'path';
import * as os from 'os';

import { deleteFile, mkDir, writeFile, copyRecursive, deleteFolder } from './util/fs.ts';
import { addShutdownHandler } from './shutdown.ts';

import { OVERRIDES_DIR } from './interceptors/terminal/terminal-env-overrides.ts';

const WEBEXTENSION_BASE_PATH = path.join(OVERRIDES_DIR, 'webextension');

// We copy the WebExtension to a temp directory the first time it's activated, so that we can
// modify the config folder within to easily inject config into the extension. Without this,
// the extension is usually in the app install directory, which is often not user-writable.
// We only make one copy for all sessions, but we later inject independent per-session
// config files, so they can behave independently.
export let WEBEXTENSION_INSTALL: {
    path: string;
    configPath: string;
} | undefined;
async function ensureWebExtensionInstalled() {
    if (WEBEXTENSION_INSTALL) return; // No-op after the first install
    else {
        const tmpDir = os.tmpdir();

        const webExtensionPath = path.join(tmpDir, 'httptoolkit-webextension');
        const configPath = path.join(webExtensionPath, 'config');

        await copyRecursive(WEBEXTENSION_BASE_PATH, webExtensionPath);
        await mkDir(configPath).catch((e: any) => {
            if (e.code === 'EEXIST') return; // Already exists, no problem
            else throw e;
        });

        WEBEXTENSION_INSTALL = { path: webExtensionPath, configPath };
        console.log(`Webextension installed at ${WEBEXTENSION_INSTALL.path}`);
    }
}

// On shutdown, we delete the webextension install again.
addShutdownHandler(async () => {
    if (WEBEXTENSION_INSTALL) {
        console.log(`Uninstalling webextension from ${WEBEXTENSION_INSTALL.path}`);
        await deleteFolder(WEBEXTENSION_INSTALL.path);
        WEBEXTENSION_INSTALL = undefined;
    }
});

interface WebExtensionConfig { // Should match config in the WebExtension itself
    mockRtc: {
        peerId: string;
        adminBaseUrl: string;
    } | false;
}

const getConfigKey = (proxyPort: number) =>
    `127_0_0_1.${proxyPort}`; // Filename-safe proxy address

const getConfigPath = (proxyPort: number) =>
    path.join(WEBEXTENSION_INSTALL!.configPath, getConfigKey(proxyPort));

export function clearWebExtensionConfig(httpProxyPort: number) {
    if (!WEBEXTENSION_INSTALL) return;

    return deleteFile(getConfigPath(httpProxyPort))
        .catch(() => {}); // We ignore errors - nothing we can do, not very important.
}

export async function updateWebExtensionConfig(
    sessionId: string,
    httpProxyPort: number,
    webRTCEnabled: boolean
) {
    if (webRTCEnabled) {
        await ensureWebExtensionInstalled();

        const adminBaseUrl = `http://internal.httptoolkit.localhost:45456/session/${sessionId}`;
        await writeConfig(httpProxyPort, {
            mockRtc: {
                peerId: 'matching-peer',
                adminBaseUrl
            }
        });
    } else {
        if (WEBEXTENSION_INSTALL) {
            // If the extension is set up, but this specific session has it disabled, we
            // make the config explicitly disable it, just to be clear:
            await writeConfig(httpProxyPort, { mockRtc: false });
        }
    }
}

async function writeConfig(proxyPort: number, config: WebExtensionConfig) {
    return writeFile(getConfigPath(proxyPort), JSON.stringify(config));
}