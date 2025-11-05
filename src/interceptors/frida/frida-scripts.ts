import * as path from 'path';

import * as fs from '../../util/fs.ts';
import { OVERRIDES_DIR } from '../terminal/terminal-env-overrides.ts';

const FRIDA_SCRIPTS_ROOT = path.join(OVERRIDES_DIR, 'frida');

function buildFridaConfig(
    configScriptTemplate: string,
    caCertContent: string,
    proxyHost: string,
    proxyPort: number,
    portsToIgnore: number[],
    enableSocks: boolean
) {
    return configScriptTemplate
        .replace(/(?<=const CERT_PEM = `)[^`]+(?=`)/s, caCertContent.trim())
        .replace(/(?<=const PROXY_HOST = ')[^']+(?=')/, proxyHost)
        .replace(/(?<=const PROXY_PORT = )\d+(?=;)/, proxyPort.toString())
        .replace(/(?<=const PROXY_SUPPORTS_SOCKS5 = )false(?=;)/, enableSocks.toString())
        .replace(/(?<=const IGNORED_NON_HTTP_PORTS = )\[\s*\](?=;)/s, JSON.stringify(portsToIgnore));
}

export async function buildAndroidFridaScript(
    caCertContent: string,
    proxyHost: string,
    proxyPort: number,
    portsToIgnore: number[],
    enableSocks: boolean
) {
    const scripts = await Promise.all([
        fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, 'frida-java-bridge.js'), { encoding: 'utf8' }),
        fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, 'config.js'), { encoding: 'utf8' })
            .then((configTemplate) =>
                buildFridaConfig(configTemplate, caCertContent, proxyHost, proxyPort, portsToIgnore, enableSocks)
            ),
        ...[
            ['native-connect-hook.js'],
            ['native-tls-hook.js'],
            ['android', 'android-proxy-override.js'],
            ['android', 'android-system-certificate-injection.js'],
            ['android', 'android-certificate-unpinning.js'],
            ['android', 'android-certificate-unpinning-fallback.js'],
            ['android', 'android-disable-root-detection.js']
        ].map((hookRelPath) =>
            fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, ...hookRelPath), { encoding: 'utf8' })
        )
    ]);

    return scripts.join('\n');
}

export async function buildIosFridaScript(
    caCertContent: string,
    proxyHost: string,
    proxyPort: number,
    portsToIgnore: number[],
    enableSocks: boolean
) {
    const scripts = await Promise.all([
        fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, 'frida-objc-bridge.js'), { encoding: 'utf8' }),
        fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, 'config.js'), { encoding: 'utf8' })
            .then((configTemplate) =>
                buildFridaConfig(configTemplate, caCertContent, proxyHost, proxyPort, portsToIgnore, enableSocks)
            ),
        ...[
            ['ios', 'ios-connect-hook.js'],
            ['ios', 'ios-disable-detection.js'],
            ['native-tls-hook.js'],
            ['native-connect-hook.js'],
        ].map((hookRelPath) =>
            fs.readFile(path.join(FRIDA_SCRIPTS_ROOT, ...hookRelPath), { encoding: 'utf8' })
        )
    ]);

    return scripts.join('\n');
}

export async function buildIpTestScript(
    ips: string[],
    proxyPort: number
) {
    const baseScript = await fs.readFile(
        path.join(FRIDA_SCRIPTS_ROOT, 'utilities', 'test-ip-connectivity.js'),
        { encoding: 'utf8' }
    );

    return baseScript.replace(/(?<=const IP_ADDRESSES_TO_TEST = )\[\s+\](?=;)/s, JSON.stringify(ips))
        .replace(/(?<=const TARGET_PORT = )0(?=;)/, proxyPort.toString());
}