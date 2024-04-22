import * as path from 'path';

import * as fs from '../../util/fs';
import { OVERRIDES_DIR } from '../terminal/terminal-env-overrides';

const FRIDA_SCRIPTS_ROOT = path.join(OVERRIDES_DIR, 'frida');

function buildFridaConfig(
    configScriptTemplate: string,
    caCertContent: string,
    proxyHost: string,
    proxyPort: number
) {
    return configScriptTemplate
        .replace(/(?<=const CERT_PEM = `)[^`]+(?=`)/s, caCertContent.trim())
        .replace(/(?<=const PROXY_HOST = ')[^']+(?=')/, proxyHost)
        .replace(/(?<=const PROXY_PORT = ')\d+(?=;)/, proxyPort.toString());
}

export async function buildAndroidFridaScript(
    caCertContent: string,
    proxyHost: string,
    proxyPort: number
) {
    const scripts = await Promise.all([
        fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, 'config.js'), { encoding: 'utf8' })
            .then((configTemplate) =>
                buildFridaConfig(configTemplate, caCertContent, proxyHost, proxyPort)
            ),
        ...[
            ['native-connect-hook.js'],
            ['native-tls-hook.js'],
            ['android', 'android-proxy-override.js'],
            ['android', 'android-system-certificate-injection.js'],
            ['android', 'android-certificate-unpinning.js'],
            ['android', 'android-certificate-unpinning-fallback.js']
        ].map((hookRelPath) =>
            fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, ...hookRelPath), { encoding: 'utf8' })
        )
    ]);

    return scripts.join('\n');
}