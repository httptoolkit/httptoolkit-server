import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as envPaths from 'env-paths';
import { getStandalone, generateCACertificate } from 'mockttp';

import { HttpToolkitServer } from './httptoolkit-server';

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
}) {
    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);

    const httpsConfig = await generateHTTPSConfig(configPath);

    // Start a standalone server
    const standalone = getStandalone({
        serverDefaults: {
            cors: false,
            https: httpsConfig
        }
    });
    standalone.start();

    // Start a HTK server
    const htkServer = new HttpToolkitServer({
        configPath,
        https: httpsConfig
    });
    await htkServer.start();

    console.log('Server started');
}
