import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

import * as fs from './fs';

const SHARED_TMP_DIRS = ['/tmp', '/var/tmp'];

/**
 * The directory for runtime files (sockets, temporary copies of resources, etc) that should
 * be accessible only to the current user.
 *
 * On Linux we use XDG_RUNTIME_DIR when available. Otherwise, if the system temp directory
 * is shared between users, we use a per-user subdirectory within it. Elsewhere (Windows,
 * Mac's TMPDIR) the temp directory is already per-user.
 *
 * This only computes the path - use ensureRuntimeDir before trusting its contents.
 */
export function getRuntimeDirPath(): string {
    return resolveRuntimeDir().path;
}

function resolveRuntimeDir(): { path: string, ownerUid?: number } {
    if (process.platform === 'win32') return { path: os.tmpdir() };

    if (process.platform === 'linux' && process.env.XDG_RUNTIME_DIR) {
        return { path: process.env.XDG_RUNTIME_DIR };
    }

    const tmpDir = os.tmpdir();
    const uid = process.getuid?.();
    if (SHARED_TMP_DIRS.includes(tmpDir) && uid !== undefined) {
        return { path: path.join(tmpDir, `httptoolkit-${uid}`), ownerUid: uid };
    }

    return { path: tmpDir };
}

/**
 * Returns the runtime directory path, creating it if required and verifying that it's
 * private to this user if we're responsible for it. Rejects if the directory has been
 * created insecurely, e.g. pre-created by another user.
 */
export async function ensureRuntimeDir(): Promise<string> {
    const { path: runtimeDir, ownerUid } = resolveRuntimeDir();
    if (ownerUid !== undefined) await ensurePrivateDir(runtimeDir, ownerUid);
    return runtimeDir;
}

export async function ensurePrivateDir(dir: string, expectedUid: number) {
    if (await createOrCheckPrivateDir(dir, expectedUid)) return;

    // If we're allowed to move the existing path (in a sticky dir like /tmp: only if it's ours,
    // or we're root) we move it aside and start fresh. We rename rather than delete, as
    // recursively deleting content that others may be able to write to is open to symlink races.
    const stalePath = `${dir}.stale-${crypto.randomBytes(8).toString('hex')}`;
    try {
        await fs.renameFile(dir, stalePath);
    } catch {
        throw insecureDirError(dir);
    }
    console.warn(`Moved insecure runtime directory ${dir} aside to ${stalePath}`);

    if (!await createOrCheckPrivateDir(dir, expectedUid)) throw insecureDirError(dir);
}

async function createOrCheckPrivateDir(dir: string, expectedUid: number): Promise<boolean> {
    await fs.mkDir(dir, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
    });

    const stats = await fs.lstatFile(dir);
    return stats.isDirectory() && stats.uid === expectedUid && (stats.mode & 0o077) === 0;
}

const insecureDirError = (dir: string) => new Error(
    `Runtime directory ${dir} is not a private directory owned by the current user. ` +
    'It may have been created by another user. Remove it and restart HTTP Toolkit.'
);
