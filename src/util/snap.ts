import os = require('os');
import path = require('path');

import fs = require('./fs');

export async function isSnap(bin: string) {
    if (os.platform() !== 'linux') return false;

    const binPath = await fs.resolveCommandPath(bin);
    if (!binPath) {
        throw new Error(`Can't resolve command ${bin}`);
    }

    // Most snaps directly run from the Snap bin folder:
    if (binPath.startsWith('/snap/bin/')) return true;

    // Firefox is the only known example that doesn't - it uses a
    // wrapper script, so we just look for that:
    if (binPath === '/usr/bin/firefox') {
        const content = await fs.readFile(binPath);
        return content.includes('exec /snap/bin/firefox');
    }

    return false;
}

// For all Snaps, any data we want to inject needs to live inside the
// Snap's data directory - we put it in a .httptoolkit folder.
export const getSnapConfigPath = (appName: string) => {
    return path.join(
        os.homedir(),
        'snap',
        appName,
        'current',
        '.httptoolkit'
    );
}