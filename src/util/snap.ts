import os = require('os');
import path = require('path');

import fs = require('./fs');
import { streamToBuffer } from './stream';

export async function isSnap(bin: string) {
    if (os.platform() !== 'linux') return false;

    const binPath = await fs.resolveCommandPath(bin);
    if (!binPath) {
        throw new Error(`Can't resolve command ${bin}`);
    }

    // Most snaps directly run from the Snap bin folder:
    if (binPath.startsWith('/snap/bin/')) return true;

    // If not, the command might be a wrapper script - both chromium-browser
    // & firefox use these. Check the end and see if we recognize it:

    const fileSize = await fs.statFile(binPath);
    const stream = fs.createReadStream(binPath, {
        start: Math.max(fileSize.size - 100, 0)
    });
    const lastChunkOfFile = (await streamToBuffer(stream)).toString('utf8');

    return lastChunkOfFile.includes('exec /snap/bin/');
}

// For all Snaps, any data we want to inject needs to live inside the
// Snap's data directory - we put it in a .httptoolkit folder.
export async function getSnapConfigPath(appName: string) {
    const snapDataPath = path.join(
        os.homedir(),
        'snap',
        appName,
        'current'
    );

    if (!await fs.canAccess(snapDataPath)) {
        throw new Error(`Could not find Snap data path for ${appName}`);
    }

    return path.join(snapDataPath, '.httptoolkit');
}