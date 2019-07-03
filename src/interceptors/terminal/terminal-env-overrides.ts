import * as path from 'path';

import { HttpsPathOptions } from 'mockttp/dist/util/tls';

const PATH_VAR_SEPARATOR = process.platform === 'win32' ? ';' : ':';

const OVERRIDES_DIR = path.join(__dirname, '..', '..', '..', 'overrides');
const OVERRIDE_RUBYGEMS_PATH = path.join(OVERRIDES_DIR, 'gems');
const OVERRIDE_PYTHONPATH = path.join(OVERRIDES_DIR, 'pythonpath');

export const OVERRIDE_BIN_PATH = path.join(OVERRIDES_DIR, 'path');

export function getTerminalEnvVars(
    proxyPort: number,
    httpsConfig: HttpsPathOptions,
    currentEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
    return {
        'http_proxy': `http://localhost:${proxyPort}`,
        'HTTP_PROXY': `http://localhost:${proxyPort}`,
        'https_proxy': `http://localhost:${proxyPort}`,
        'HTTPS_PROXY': `http://localhost:${proxyPort}`,
        // Used by global-agent to configure node.js HTTP(S) defaults
        'GLOBAL_AGENT_HTTP_PROXY': `http://localhost:${proxyPort}`,
        // Used by some CGI engines to avoid 'httpoxy' vulnerability
        'CGI_HTTP_PROXY': `http://localhost:${proxyPort}`,
        // Used by npm, for versions that don't support HTTP_PROXY etc
        'npm_config_proxy': `http://localhost:${proxyPort}`,
        'npm_config_https_proxy': `http://localhost:${proxyPort}`,
        // Stop npm warning about having a different 'node' in $PATH
        'npm_config_scripts_prepend_node_path': 'false',

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
        'PATH': `${OVERRIDE_BIN_PATH}${PATH_VAR_SEPARATOR}${currentEnv.PATH}`,

        // Prepend our Ruby gem overrides into $LOAD_PATH
        'RUBYLIB': currentEnv.RUBYLIB
            ? `${OVERRIDE_RUBYGEMS_PATH}:${currentEnv.RUBYLIB}`
            : OVERRIDE_RUBYGEMS_PATH,

        // Prepend our Python package overrides into $PYTHONPATH
        'PYTHONPATH': currentEnv.PYTHONPATH
            ? `${OVERRIDE_PYTHONPATH}:${currentEnv.PYTHONPATH}`
            : OVERRIDE_PYTHONPATH
    };
}