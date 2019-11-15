import * as path from 'path';

import { HttpsPathOptions } from 'mockttp/dist/util/tls';

const PATH_VAR_SEPARATOR = process.platform === 'win32' ? ';' : ':';

export const OVERRIDES_DIR = path.join(
    process.env.HTK_IS_BUNDLED
        ? path.join(__dirname, '..')
        : path.join(__dirname, '..', '..', '..'),
    'overrides'
);

export function getTerminalEnvVars(
    proxyPort: number,
    httpsConfig: HttpsPathOptions,
    // Either a set of current env vars for our current world (windows or posix or otherwise),
    // or we generate values that read from an unknown POSIX runtime environment later.
    currentEnv: { [key: string]: string | undefined } | 'runtime-inherit'
): { [key: string]: string } {
    // With runtime inherit, we're always POSIX, and we expect the runtime env to set
    // the root dir via HTTPTOOLKIT_OVERRIDE_DIR. This is for git bash/etc, which need
    // PATHs in different path formats, and need detecting at runtime.
    const overrideDir = currentEnv === 'runtime-inherit'
        ? path.posix.join.bind(null, "$HTTPTOOLKIT_OVERRIDE_DIR")
        : path.join.bind(null, OVERRIDES_DIR);

    const binPathOverride = overrideDir('path');
    const rubygemsOverride = overrideDir('gems');
    const pythonpathOverride = overrideDir('pythonpath');

    return {
        'http_proxy': `http://127.0.0.1:${proxyPort}`,
        'HTTP_PROXY': `http://127.0.0.1:${proxyPort}`,
        'https_proxy': `http://127.0.0.1:${proxyPort}`,
        'HTTPS_PROXY': `http://127.0.0.1:${proxyPort}`,
        // Used by global-agent to configure node.js HTTP(S) defaults
        'GLOBAL_AGENT_HTTP_PROXY': `http://127.0.0.1:${proxyPort}`,
        // Used by some CGI engines to avoid 'httpoxy' vulnerability
        'CGI_HTTP_PROXY': `http://127.0.0.1:${proxyPort}`,
        // Used by npm, for versions that don't support HTTP_PROXY etc
        'npm_config_proxy': `http://127.0.0.1:${proxyPort}`,
        'npm_config_https_proxy': `http://127.0.0.1:${proxyPort}`,
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
        'PATH': `${binPathOverride}${
            currentEnv == 'runtime-inherit'
                ? ':$PATH'
                : (PATH_VAR_SEPARATOR + currentEnv.PATH)
        }`,

        // Prepend our Ruby gem overrides into $LOAD_PATH
        'RUBYLIB': currentEnv === 'runtime-inherit'
                ? `${rubygemsOverride}:$RUBYLIB`
            : !!currentEnv.RUBYLIB
                ? `${rubygemsOverride}:${currentEnv.RUBYLIB}`
            : rubygemsOverride,

        // Prepend our Python package overrides into $PYTHONPATH
        'PYTHONPATH': currentEnv === 'runtime-inherit'
                ? `${pythonpathOverride}:$PYTHONPATH`
            : currentEnv.PYTHONPATH
                ? `${pythonpathOverride}:${currentEnv.PYTHONPATH}`
            : pythonpathOverride
    };
}