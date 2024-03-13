import * as _ from 'lodash';
import * as path from 'path';

import { APP_ROOT } from '../../constants';
import { getDockerPipePath } from '../docker/docker-proxy';

const BIN_OVERRIDE_DIR = 'path';
const RUBY_OVERRIDE_DIR = 'gems';
const PHP_OVERRIDE_DIR = 'php';
const PYTHON_OVERRIDE_DIR = 'pythonpath';
const NODE_PREPEND_SCRIPT = ['js', 'prepend-node.js'];
const JAVA_AGENT_JAR = 'java-agent.jar';

export const OVERRIDES_DIR = path.join(APP_ROOT, 'overrides');

// Used in terminal scripts that help to enforce our PATH override elsewhere:
export const OVERRIDE_BIN_PATH = path.join(OVERRIDES_DIR, BIN_OVERRIDE_DIR);

// Use in attach-jvm to attach externally to a running JVM process:
export const OVERRIDE_JAVA_AGENT = path.join(OVERRIDES_DIR, JAVA_AGENT_JAR);

export function getTerminalEnvVars(
    proxyPort: number,
    httpsConfig: { certPath: string },
    currentEnv:
        | { [key: string]: string | undefined }
        | 'posix-runtime-inherit'
        | 'powershell-runtime-inherit',

    // All 3 of the below must be overriden together, or not at all, to avoid
    // mixing platforms & default (platform-specific) paths
    targetEnvConfig?: {
        httpToolkitHost: string,
        overridePath: string,
        targetPlatform: NodeJS.Platform
    }
): { [key: string]: string } {
    const { overridePath, targetPlatform, httpToolkitHost } = targetEnvConfig ?? {
        httpToolkitHost: '127.0.0.1',
        overridePath: OVERRIDES_DIR,
        targetPlatform: process.platform
    };

    const runtimeInherit = currentEnv === 'posix-runtime-inherit'
            ? (varName: string) => `$${varName}`
        : currentEnv === 'powershell-runtime-inherit'
            ? ((varName: string) => `$env:${varName}`)
        : undefined;
    currentEnv = (runtimeInherit
        ? {} // Reset the env if we're using runtime inheritance:
        // Or use the real values we were given if not:
        : currentEnv
    ) as { [key: string]: string | undefined };

    const pathVarSeparator = targetPlatform === 'win32' ? ';' : ':';
    const joinPath = targetPlatform === 'win32' ? path.win32.join : path.posix.join;

    const proxyUrl = `http://${httpToolkitHost}:${proxyPort}`;

    const dockerHost = `${
        targetPlatform === 'win32'
        ? 'npipe'
        : 'unix'
    }://${getDockerPipePath(proxyPort, targetPlatform)}`;

    const rubyGemsPath = joinPath(overridePath, RUBY_OVERRIDE_DIR);
    const pythonPath = joinPath(overridePath, PYTHON_OVERRIDE_DIR);
    const phpPath = joinPath(overridePath, PHP_OVERRIDE_DIR);

    // Node supports POSIX paths everywhere, and using those solves some weird issues
    // when combining backslashes with quotes in Git Bash on Windows:
    const nodePrependScript = path.posix.join(
        ...(targetPlatform === 'win32'
            ? overridePath.split(path.win32.sep)
            : [overridePath]
        ),
        ...NODE_PREPEND_SCRIPT
    );
    const nodePrependOption = `--require ${
        // Avoid quoting except when necessary, because node 8 doesn't support quotes here
        nodePrependScript.includes(' ')
            ? `"${nodePrependScript}"`
            : nodePrependScript
    }`;

    const javaAgentOption = `-javaagent:"${
        joinPath(overridePath, JAVA_AGENT_JAR)
    }"=${httpToolkitHost}|${proxyPort}|${httpsConfig.certPath}`;

    const binPath = joinPath(overridePath, BIN_OVERRIDE_DIR);

    return {
        // The main env vars, which in theory should be used by most well-behaved clients:
        'HTTP_PROXY': proxyUrl,
        'HTTPS_PROXY': proxyUrl,
        // The same in lowercase, to fully cover even oddly behaved cases:
        'http_proxy': proxyUrl,
        'https_proxy': proxyUrl,
        // The same for WebSockets, as some clients treat these differently:
        'WS_PROXY': proxyUrl,
        'WSS_PROXY': proxyUrl,

        // Used by global-agent to configure node.js HTTP(S) defaults
        'GLOBAL_AGENT_HTTP_PROXY': proxyUrl,
        // Used by some CGI engines to avoid 'httpoxy' vulnerability
        'CGI_HTTP_PROXY': proxyUrl,
        // Used by npm, for versions that don't support HTTP_PROXY etc
        'npm_config_proxy': proxyUrl,
        'npm_config_https_proxy': proxyUrl,
        // Stop npm warning about having a different 'node' in $PATH
        'npm_config_scripts_prepend_node_path': 'false',

        // Trust cert when using OpenSSL with default settings
        'SSL_CERT_FILE': httpsConfig.certPath,
        // Trust cert when using Node 7.3.0+
        'NODE_EXTRA_CA_CERTS': httpsConfig.certPath,
        // Deno:
        'DENO_CERT': httpsConfig.certPath,
        // Trust cert when using Perl LWP
        'PERL_LWP_SSL_CA_FILE': httpsConfig.certPath,
        // Trust cert for HTTPS requests from Git
        'GIT_SSL_CAINFO': httpsConfig.certPath,
        // Trust cert in Rust's Cargo:
        'CARGO_HTTP_CAINFO': httpsConfig.certPath,
        // Trust cert in CURL (only required when not using OpenSSL) and Python Requests:
        'CURL_CA_BUNDLE': httpsConfig.certPath,
        // Trust our CA in the AWS CLI:
        'AWS_CA_BUNDLE': httpsConfig.certPath,

        // Flag used by subprocesses to check they're running in an intercepted env
        'HTTP_TOOLKIT_ACTIVE': 'true',
        // Useful downstream to derive the raw paths elsewhere, e.g. in php.ini override config.
        'HTTP_TOOLKIT_OVERRIDE_PATH': overridePath,

        // Prepend our bin overrides into $PATH
        'PATH': `${binPath}${pathVarSeparator}${
            runtimeInherit ? runtimeInherit('PATH') : currentEnv.PATH
        }`,

        // Prepend our Ruby gem overrides into $LOAD_PATH
        'RUBYLIB': runtimeInherit
                ? `${rubyGemsPath}:${runtimeInherit('RUBYLIB')}`
            : !!currentEnv.RUBYLIB
                ? `${rubyGemsPath}:${currentEnv.RUBYLIB}`
            : rubyGemsPath,

        // Prepend our Python package overrides into $PYTHONPATH
        'PYTHONPATH': runtimeInherit
                ? `${pythonPath}:${runtimeInherit('PYTHONPATH')}`
            : currentEnv.PYTHONPATH
                ? `${pythonPath}:${currentEnv.PYTHONPATH}`
            : pythonPath,

        // We use $NODE_OPTIONS to prepend our script into node. Notably this drops existing
        // env values, when using our env, because _our_ NODE_OPTIONS aren't meant for
        // subprocesses. Otherwise e.g. --max-http-header-size breaks old Node/Electron.
        'NODE_OPTIONS': runtimeInherit
            ? `${runtimeInherit('NODE_OPTIONS')} ${nodePrependOption}`
            : nodePrependOption,

        // Attach our Java agent to all launched Java processes:
        'JAVA_TOOL_OPTIONS': runtimeInherit
                ? `${runtimeInherit('JAVA_TOOL_OPTIONS')} ${javaAgentOption}`
            : currentEnv.JAVA_TOOL_OPTIONS
                ? `${currentEnv.JAVA_TOOL_OPTIONS} ${javaAgentOption}`
            : javaAgentOption,

        'PHP_INI_SCAN_DIR': runtimeInherit
                ? `${runtimeInherit('PHP_INI_SCAN_DIR')}${pathVarSeparator}${phpPath}`
            : currentEnv.PHP_INI_SCAN_DIR
                ? `${currentEnv.PHP_INI_SCAN_DIR}${pathVarSeparator}${phpPath}`
            : phpPath,

        // Run all Docker operations through our Docker-hooking proxy:
        'DOCKER_HOST': dockerHost,
        // For now, we don't support intercepting BuildKit builds - disable them:
        'DOCKER_BUILDKIT': '0'
    };
}

export function getInheritableCurrentEnv() {
    const currentEnv = (process.platform === 'win32')
        // Windows env var behaviour is very odd. Windows env vars are case-insensitive, and node
        // simulates this for process.env accesses, but when used in an object they become
        // case-*sensitive* object keys, and it's easy to end up with duplicates.
        // To fix this, on Windows we enforce here that all env var input keys are uppercase.
        ? _.mapKeys(process.env, (_value, key) => key.toUpperCase())
        : process.env;

    // We drop various keys that are set by the server or desktop shell, and which shouldn't generally
    // be inherited through the independently running apps.
    return _.omit(currentEnv, [
        // Set by us to mildly widen platform support:
        'NODE_SKIP_PLATFORM_CHECK',
        // Set by Oclif:
        'HTTPTOOLKIT_SERVER_BINPATH',
        // Set by Electron:
        'NO_AT_BRIDGE',
        'ORIGINAL_XDG_CURRENT_DESKTOP',
        'GDK_BACKEND',
        'CHROME_DESKTOP'
    ]);
}