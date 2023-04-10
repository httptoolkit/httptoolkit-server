import _ from 'lodash';
import * as fs from 'fs';
import * as util from 'util';
import * as os from 'os';
import * as path from 'path';

import { canAccess, writeFile, renameFile, readFile, getRealPath } from '../../util/fs';
import { reportError } from '../../error-tracking';
import { OVERRIDE_BIN_PATH } from './terminal-env-overrides';

// Generate POSIX paths for git-bash on Windows (or use the normal path everywhere else)
const POSIX_OVERRIDE_BIN_PATH = process.platform === 'win32'
    ? OVERRIDE_BIN_PATH.replace(/\\/g, '/').replace(/^(\w+):/, (_all, driveLetter) => `/${driveLetter.toLowerCase()}`)
    : OVERRIDE_BIN_PATH;

const SHELL = (process.env.SHELL || '').split('/').slice(-1)[0];

const appendOrCreateFile = util.promisify(fs.appendFile);
const appendToFirstExisting = async (paths: string[], forceWrite: boolean, contents: string) => {
    for (let path of paths) {
        // Follow the path through symlinks (relatively common for terminal config):
        const realPath = await getRealPath(path);
        if (!realPath) continue; // File (or linked file) does not exist

        if (await canAccess(realPath)) {
            // Found our first valid readable file - append our extra config
            return appendOrCreateFile(realPath, contents);
        }

        // ^ Small races here, if the file content/perms change between check and write, but
        // unlikely to be a major concern - we'll just fail to write, it'll work next time.
    }

    if (forceWrite) {
        // If force write is set, write the last file anyway, even though it didn't exist before:
        return appendOrCreateFile(paths.slice(-1)[0], contents);
    }
};

const START_CONFIG_SECTION = '# --httptoolkit--';
const END_CONFIG_SECTION = '# --httptoolkit-end--';

// The shell config required to ensure every spawned shell always has the right
// configuration, even if it has its env vars reset somehow. This also includes
// fixes for winpty with git-bash. By default, winpty will intercept known
// commands to manage them, so our PATH overrides never get run. We avoid that
// with trivial aliases, and then run winpty ourselves inside the overrides.

// Works in bash, zsh, dash, ksh, sh (not fish)
const SH_SHELL_PATH_CONFIG = `
${START_CONFIG_SECTION}
# This section will be reset each time a HTTP Toolkit terminal is opened
if [ -n "$HTTP_TOOLKIT_ACTIVE" ]; then
    # When HTTP Toolkit is active, we inject various overrides into PATH
    export PATH="${POSIX_OVERRIDE_BIN_PATH}:$PATH"

    if command -v winpty >/dev/null 2>&1; then
        # Work around for winpty's hijacking of certain commands
        alias php=php
        alias node=node
    fi
fi
${END_CONFIG_SECTION}`;
const FISH_SHELL_PATH_CONFIG = `
${START_CONFIG_SECTION}
# This section will be reset each time a HTTP Toolkit terminal is opened
if [ -n "$HTTP_TOOLKIT_ACTIVE" ]
    # When HTTP Toolkit is active, we inject various overrides into PATH
    set -x PATH "${POSIX_OVERRIDE_BIN_PATH}" $PATH;

    if command -v winpty >/dev/null 2>&1
        # Work around for winpty's hijacking of certain commands
        alias php=php
        alias node=node
    end
end
${END_CONFIG_SECTION}`;

// A source-able shell script. Should work for everything sh-compatible, e.g. Bash, Zsh, Ksh etc.
export const getBashShellScript = (callbackUrl: string, env: { [name: string]: string }) => `${
        _.map(env, (value, key) => `    export ${key}="${value.replace(/"/g, '\\"')}"`).join('\n')
    }

    if command -v winpty >/dev/null 2>&1; then
        # Work around for winpty's hijacking of certain commands
        alias php=php
        alias node=node
    fi

    if command -v curl >/dev/null 2>&1; then
        # Let the HTTP Toolkit app know this ran succesfully
        (curl --noproxy '*' -X POST "${callbackUrl}" >/dev/null 2>&1 &) &> /dev/null
    fi

    echo 'HTTP Toolkit interception enabled'
`;

// Build a Bash script, but first just translate the $PATH (which Git Bash expects to include its own
// path-format strings) from Windows to Git Bash format.
export const getGitBashShellScript = (callbackUrl: string, env: { [name: string]: string }) =>
    getBashShellScript(callbackUrl, {
        ...env,
        // We convert path from being the override bin & ; separator to /C/path/to/overrides.
        PATH: env['PATH']
            .replace(
                `${OVERRIDE_BIN_PATH};`,
                POSIX_OVERRIDE_BIN_PATH + ':' // Unix format $PATH separator
            )
    });

export const getFishShellScript = (callbackUrl: string, env: { [name: string]: string }) => `${
        _.map(env, (value, key) => `    set -x ${key} "${value.replace(/"/g, '\\"')}"`).join('\n')
    }

    if command -v winpty >/dev/null 2>&1
        # Work around for winpty's hijacking of certain commands
        alias php=php
        alias node=node
    end

    if command -v curl >/dev/null 2>&1
        # Let the HTTP Toolkit app know this ran succesfully
        curl --noproxy '*' -X POST "${callbackUrl}" >/dev/null 2>&1 &
    end

    echo 'HTTP Toolkit interception enabled'
`;

export const getPowerShellScript = (callbackUrl: string, env: { [name: string]: string }) => `${
        _.map(env, (value, key) => `    $Env:${key} = "${value.replace(/"/g, '`"')}"`).join('\n')
    }

    # We add a few special hooks just for Invoke-WebRequest.
    # First, we override the default proxy to use the env var value:
    $PSDefaultParameterValues["invoke-webrequest:proxy"] = $Env:HTTP_PROXY
    # Then we disable cert checks completely - all traffic will go to us, we'll handle HTTPS upstream
    $PSDefaultParameterValues["invoke-webrequest:SkipCertificateCheck"] = $True

    # Let the HTTP Toolkit app know this ran succesfully
    Start-Job -ScriptBlock { Invoke-WebRequest "${callbackUrl}" -NoProxy -Method 'POST' } | out-null

    Write-Host 'HTTP Toolkit interception enabled'
`;

// Find the relevant user shell config file, add the above line to it, so that
// shells launched with HTTP_TOOLKIT_ACTIVE set use the interception PATH.
export const editShellStartupScripts = async () => {
    await resetShellStartupScripts();

    // The key risk here is that one of these scripts (or some other process) will be
    // overriding PATH itself, so we need to append some PATH reset logic. The main
    // offenders are: nvm config's in .bashrc/.bash_profile, OSX's path_helper and
    // git-bash ignoring the inherited $PATH.

    // .profile is used by Dash, Bash sometimes, and by Sh:
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.profile')
        ],
        true, // We always write .profile
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Bash login shells use some other files by preference, if they exist.
    // Note that on OSX, all shells are login - elsewhere they only are at actual login time.
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.bash_profile'),
            path.join(os.homedir(), '.bash_login')
        ],
        false, // Do nothing if they don't exist - it falls back to .profile
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Bash non-login shells use .bashrc, if it exists:
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.bashrc')
        ],
        SHELL === 'bash', // If you use bash, we _always_ want to set this
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Zsh has its own files (both are actually used)
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.zshenv'),
            path.join(os.homedir(), '.zshrc')
        ],
        SHELL === 'zsh', // If you use zsh, we _always_ write a config file
        SH_SHELL_PATH_CONFIG
    ).catch(reportError);

    // Fish always uses the same config file
    appendToFirstExisting(
        [
            path.join(os.homedir(), '.config', 'fish', 'config.fish'),
        ],
        SHELL === 'fish' || await canAccess(path.join(os.homedir(), '.config', 'fish')),
        FISH_SHELL_PATH_CONFIG
    ).catch(reportError);
};

const removeConfigSectionsFromFile = async (path: string) => {
    let fileLines: string[];

    const targetPath = await getRealPath(path); // Follow symlinks, if present
    if (!targetPath) return; // File doesn't exist, no need to clean it up

    try {
        fileLines = (await readFile(targetPath, 'utf8')).split('\n');
    } catch (e) {
        // Silently skip any files we can't read
        return;
    }

    // Remove everything between each pair of start/end section markers
    let sectionStart = _.findIndex(fileLines, (l) => l.startsWith(START_CONFIG_SECTION));
    while (sectionStart !== -1) {
        let sectionEnd = _.findIndex(fileLines, (l) => l.startsWith(END_CONFIG_SECTION));

        if (sectionEnd === -1 || sectionEnd <= sectionStart) return; // Odd config file state - don't edit it
        fileLines.splice(sectionStart, (sectionEnd - sectionStart) + 1);
        sectionStart = _.findIndex(fileLines, (l) => l.startsWith(START_CONFIG_SECTION));
    }

    // Write & rename to ensure this is atomic, and avoid races here
    // as much as we reasonably can.
    const tempFile = targetPath + Date.now() + '.temp';
    await writeFile(tempFile, fileLines.join('\n'));
    return renameFile(tempFile, targetPath);
};

// Cleanup: strip our extra config line from all config files
// Good to do for tidiness, not strictly necessary (the config does nothing
// unless HTTP_TOOLKIT_ACTIVE is set anyway).
export const resetShellStartupScripts = () => {
    // For each possible config file, remove our magic line, if present
    return Promise.all([
        path.join(os.homedir(), '.profile'),
        path.join(os.homedir(), '.bash_profile'),
        path.join(os.homedir(), '.bash_login'),
        path.join(os.homedir(), '.bashrc'),
        path.join(os.homedir(), '.zshenv'),
        path.join(os.homedir(), '.zshrc'),
        path.join(os.homedir(), '.config', 'fish', 'config.fish'),
    ].map((configFile) =>
        removeConfigSectionsFromFile(configFile).catch(reportError)
    ));
};