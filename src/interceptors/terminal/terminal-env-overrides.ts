import * as path from 'path';

import { HttpsPathOptions } from 'mockttp/dist/util/tls';

import { APP_ROOT } from '../../constants';

const PATH_VAR_SEPARATOR = process.platform === 'win32' ? ';' : ':';

export const OVERRIDES_DIR = path.join(APP_ROOT, 'overrides');
const OVERRIDE_RUBYGEMS_PATH = path.join(OVERRIDES_DIR, 'gems');
const OVERRIDE_PYTHONPATH = path.join(OVERRIDES_DIR, 'pythonpath');

export const OVERRIDE_BIN_PATH = path.join(OVERRIDES_DIR, 'path');

export function getTerminalEnvVars(
    proxyPort: number,
    httpsConfig: HttpsPathOptions,
    currentEnv: { [key: string]: string | undefined } | 'runtime-inherit'
): { [key: string]: string } {
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;

    return {
        'http_proxy': proxyUrl,
        'HTTP_PROXY': proxyUrl,
        'https_proxy': proxyUrl,
        'HTTPS_PROXY': proxyUrl,
        // Used by global-agent to configure node.js HTTP(S) defaults
        'GLOBAL_AGENT_HTTP_PROXY': proxyUrl,
        // Used by some CGI engines to avoid 'httpoxy' vulnerability
        'CGI_HTTP_PROXY': proxyUrl,
        // Used by npm, for versions that don't support HTTP_PROXY etc
        'npm_config_proxy': proxyUrl,
        'npm_config_https_proxy': proxyUrl,
        // Stop npm warning about having a different 'node' in $PATH
        'npm_config_scripts_prepend_node_path': 'false',
        // Proxy used by the Go CLI
        'GOPROXY': proxyUrl,

        // Trust cert when using OpenSSL with default settings
        'SSL_CERT_FILE': httpsConfig.certPath,
        // Trust cert when using Node 7.3.0+
        'NODE_EXTRA_CA_CERTS': httpsConfig.certPath,
        // Trust cert when using Requests (Python)
        'REQUESTS_CA_BUNDLE': httpsConfig.certPath,
        // Trust cert when using Perl LWP
        'PERL_LWP_SSL_CA_FILE': httpsConfig.certPath,
        // Trust cert for HTTPS requests from Git
        'GIT_SSL_CAINFO': httpsConfig.certPath,

        // Flag used by subprocesses to check they're running in an intercepted env
        'HTTP_TOOLKIT_ACTIVE': 'true',

        // Prepend our bin overrides into $PATH
        'PATH': `${OVERRIDE_BIN_PATH}${PATH_VAR_SEPARATOR}${
            currentEnv == 'runtime-inherit' ? '$PATH' : currentEnv.PATH
        }`,

        // Prepend our Ruby gem overrides into $LOAD_PATH
        'RUBYLIB': currentEnv === 'runtime-inherit'
                ? `${OVERRIDE_RUBYGEMS_PATH}:$RUBYLIB`
            : !!currentEnv.RUBYLIB
                ? `${OVERRIDE_RUBYGEMS_PATH}:${currentEnv.RUBYLIB}`
            : OVERRIDE_RUBYGEMS_PATH,

        // Prepend our Python package overrides into $PYTHONPATH
        'PYTHONPATH': currentEnv === 'runtime-inherit'
                ? `${OVERRIDE_PYTHONPATH}:$PYTHONPATH`
            : currentEnv.PYTHONPATH
                ? `${OVERRIDE_PYTHONPATH}:${currentEnv.PYTHONPATH}`
            : OVERRIDE_PYTHONPATH,

        // Clear NODE_OPTIONS - it's meant for _us_, not subprocesses.
        // Otherwise e.g. --max-http-header-size can break old Node/Electron
        NODE_OPTIONS: ""
    };
}