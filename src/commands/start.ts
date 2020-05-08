// Import types only from TS
type ErrorTrackingModule = typeof import('../error-tracking');
type IndexTypeModule = typeof import('../index');

import * as path from 'path';
import { promises as fs } from 'fs'
import * as semver from 'semver';
import * as rimraf from 'rimraf';

import { IS_PROD_BUILD } from '../constants';

function maybeBundleImport<T>(moduleName: string): T {
    if (IS_PROD_BUILD || process.env.OCLIF_TS_NODE === '0') {
        // Full package: try to explicitly load the bundle
        try {
            return require('../../bundle/' + moduleName);
        } catch (e) {
            // Fallback (bundle is included in real package)
            console.log(`Could not load bundle ${moduleName}, loading raw`);
            return require('../' + moduleName);
        }
    } else {
        // Npm or dev: run the raw code
        return require('../' + moduleName);
    }
}
const { initErrorTracking, reportError } = maybeBundleImport<ErrorTrackingModule>('error-tracking');
initErrorTracking();

import { Command, flags } from '@oclif/command'

const { runHTK } = maybeBundleImport<IndexTypeModule>('index');

class HttpToolkitServer extends Command {
    static description = 'start the HTTP Toolkit server'

    static flags = {
        version: flags.version({char: 'v'}),
        help: flags.help({char: 'h'}),

        config: flags.string({char: 'c', description: 'optional path in which to store config files'}),
        token: flags.string({char: 't', description: 'optional token to authenticate local server access'}),
    }

    async run() {
        const { flags } = this.parse(HttpToolkitServer);

        this.cleanupOldServers(); // Async cleanup old server versions

        await runHTK({
            configPath: flags.config,
            authToken: flags.token
        }).catch(async (error) => {
            await reportError(error);
            throw error;
        });
    }

    // On startup, we want to kill any downloaded servers that are not longer necessary
    async cleanupOldServers() {
        const { dataDir, version: currentVersion } = this.config;

        const serverUpdatesPath = process.env.OCLIF_CLIENT_HOME ||
            path.join(dataDir, 'client');

        // Be careful - if the server path isn't clearly ours somehow, ignore it.
        if (!serverUpdatesPath.split(path.sep).includes('httptoolkit-server')) {
            reportError(`Unexpected server path (${serverUpdatesPath}), ignoring`);
            return;
        }

        const serverPaths= await fs.readdir(serverUpdatesPath)
            .catch((e) => {
                if (e.code === 'ENOENT') return null;
                else throw e;
            });
        if (!serverPaths) return; // No server update path means we're all good

        // Similarly, if the folder contains anything unexpected, be careful and do nothing.
        if (serverPaths.some((filename) =>
            !semver.valid(filename.replace(/\.partial\.\d+$/, '')) &&
            filename !== 'bin' &&
            filename !== 'current'
        )) {
            console.log(serverPaths);
            reportError(
                `Server path (${serverUpdatesPath}) contains unexpected content, ignoring`
            );
            return;
        }

        if (serverPaths.every((filename) => {
            const version = semver.valid(filename.replace(/\.partial\.\d+$/, ''));
            return !version || semver.lt(version, currentVersion);
        })) {
            // If everything is outdated, just drop the whole folder. Useful if you start
            // a new server standalone (not just from an update), because otherwise the
            // update dir can end up in a broken state. Better to clear it completely.
            console.log("Downloaded server directory is entirely outdated, deleting it");
            rimraf(serverUpdatesPath, (error) => {
                if (error) reportError(error);
            });
        } else {
            // Some of the servers are outdated, but not all (maybe it includes us).
            // Async delete all server versions older than this currently running version.
            serverPaths.forEach((filename) => {
                const version = semver.valid(filename.replace(/\.partial\.\d+$/, ''));

                if (version && semver.lt(version, currentVersion)) {
                    console.log(`Deleting old server ${filename}`);
                    rimraf(path.join(serverUpdatesPath, filename), (error) => {
                        if (error) reportError(error);
                    });
                }
            });
        }
    }
}

export = HttpToolkitServer;
