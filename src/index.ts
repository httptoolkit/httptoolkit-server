import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as envPaths from 'env-paths';
import { getStandalone, generateCACertificate } from 'mockttp';
import { Mutex } from 'async-mutex';

import updateCommand from '@oclif/plugin-update/lib/commands/update';

import { HttpToolkitServer } from './httptoolkit-server';
import { checkBrowserConfig } from './browsers';
import { reportError } from './error-tracking';
import { delay } from './util';

const canAccess = util.promisify(fs.access);
const mkDir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);

const ensureDirectoryExists = (path: string) =>
    canAccess(path).catch(() => mkDir(path, { recursive: true }));

async function generateHTTPSConfig(configPath: string) {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    await Promise.all([
        canAccess(keyPath, fs.constants.R_OK),
        canAccess(certPath, fs.constants.R_OK)
    ]).catch(() => {
        const newCertPair = generateCACertificate({
            commonName: 'HTTP Toolkit CA'
        });

        return Promise.all([
            writeFile(keyPath, newCertPair.key),
            writeFile(certPath, newCertPair.cert)
        ]);
    });

    return {
        keyPath,
        certPath,
        keyLength: 2048 // Reasonably secure keys please
    };
}

export async function runHTK(options: {
    configPath?: string
} = {}) {
    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);
    await checkBrowserConfig(configPath);

    const httpsConfig = await generateHTTPSConfig(configPath);

    // Start a standalone server
    const standalone = getStandalone({
        serverDefaults: {
            cors: false,
            https: httpsConfig
        }
    });
    standalone.start({
        port: 45456,
        host: 'localhost'
    });

    // Start a HTK server
    const htkServer = new HttpToolkitServer({
        configPath,
        https: httpsConfig
    });

    const updateMutex = new Mutex();
    htkServer.on('update-requested', () => {
        updateMutex.runExclusive(() =>
            (<Promise<void>> updateCommand.run(['stable']))
            .catch((error) => {
                // Received successful update that wants to restart the server
                if (error.code === 'EEXIT') {
                    // Block future update checks for one hour.

                    // If we don't, we'll redownload the same update again every check.
                    // We don't want to block it completely though, in case this server
                    // stays open for a very long time.
                    return delay(1000 * 60 * 60);
                }

                console.log(error);
                reportError('Failed to check for updates');
            })
        );
    });

    await htkServer.start();

    console.log('Server started');
}
