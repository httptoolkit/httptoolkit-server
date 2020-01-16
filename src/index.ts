import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as envPaths from 'env-paths';
import { getStandalone, generateCACertificate } from 'mockttp';
import * as forge from 'node-forge';
import { Mutex } from 'async-mutex';

import updateCommand from '@oclif/plugin-update/lib/commands/update';

import { HttpToolkitServer } from './httptoolkit-server';
import { checkBrowserConfig } from './browsers';
import { reportError } from './error-tracking';
import { delay, ALLOWED_ORIGINS } from './util';
import { registerShutdownHandler } from './shutdown';

const canAccess = util.promisify(fs.access);
const mkDir = util.promisify(fs.mkdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const ensureDirectoryExists = (path: string) =>
    canAccess(path).catch(() => mkDir(path, { recursive: true }));

async function generateHTTPSConfig(configPath: string) {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const [ certContent ] = await Promise.all([
        readFile(certPath, 'utf8').then((certContent) => {
            checkCertExpiry(certContent);
            return certContent;
        }),
        canAccess(keyPath, fs.constants.R_OK),
    ]).catch(async () => {
        // Cert doesn't exist, or is too close/past expiry. Generate a new one:

        const newCertPair = await generateCACertificate({
            commonName: 'HTTP Toolkit CA'
        });

        return Promise.all([
            writeFile(certPath, newCertPair.cert).then(() => newCertPair.cert),
            writeFile(keyPath, newCertPair.key)
        ]);
    });

    return {
        keyPath,
        certPath,
        certContent,
        keyLength: 2048 // Reasonably secure keys please
    };
}

function checkCertExpiry(contents: string): void {
    const cert = forge.pki.certificateFromPem(contents);
    const expiry = cert.validity.notAfter.valueOf();
    const remainingLifetime = expiry - Date.now();

    if (remainingLifetime < 1000 * 60 * 60 * 48) { // Next two days
        console.warn('Certificate expires soon - it must be regenerated');
        throw new Error('Certificate regeneration required');
    }
}

export async function runHTK(options: {
    configPath?: string
    authToken?: string
} = {}) {
    const startTime = Date.now();
    registerShutdownHandler();

    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);
    await checkBrowserConfig(configPath);

    const configCheckTime = Date.now();
    console.log('Config checked in', configCheckTime - startTime, 'ms');

    const httpsConfig = await generateHTTPSConfig(configPath);

    const certSetupTime = Date.now();
    console.log('Certificates setup in', certSetupTime - configCheckTime, 'ms');

    // Start a Mockttp standalone server
    const standalone = getStandalone({
        serverDefaults: {
            cors: false,
            https: httpsConfig
        },
        corsOptions: {
            strict: true,
            origin: ALLOWED_ORIGINS,
            maxAge: 86400 // Cache this result for as long as possible
        }
    });
    standalone.start({
        port: 45456,
        host: '127.0.0.1'
    });

    // Start a HTK server
    const htkServer = new HttpToolkitServer({
        configPath,
        authToken: options.authToken,
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

    console.log('Server started in', Date.now() - certSetupTime, 'ms');
    console.log('Total startup took', Date.now() - startTime, 'ms');
}
