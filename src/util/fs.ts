import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import rimraf from 'rimraf';
import { lookpath } from 'lookpath';
import { isErrorLike } from '@httptoolkit/util';

export const statFile = fs.promises.stat;
export const readFile = fs.promises.readFile;
export const readDir = fs.promises.readdir;
export const readLink = fs.promises.readlink;
export const deleteFile = fs.promises.unlink;
export const deleteFolder = promisify(rimraf);
export const checkAccess = fs.promises.access;
export const chmod = fs.promises.chmod;
export const mkDir = fs.promises.mkdir;
export const writeFile = fs.promises.writeFile;
export const copyFile = fs.promises.copyFile;
export const appendOrCreateFile = fs.promises.appendFile;

export const createReadStream = fs.createReadStream;
export const createWriteStream = fs.createWriteStream;

export const copyRecursive = async (from: string, to: string) => {
    // fs.cp is only available in Node 16.7.0+
    if (!fs.cp) throw new Error("fs.cp not available");

    return new Promise<void>((resolve, reject) => {
        fs.cp(from, to, { recursive: true }, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

export const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

// Takes a path, follows any links present (if possible) until we reach a non-link file. This
// does *not* check that the final path is accessible - it just removes any links en route.
// This will return undefined if a target path does not resolve at all.
export const getRealPath = async (targetPath: string): Promise<string | undefined> => {
    while (true) {
        try {
            const linkTarget = await readLink(targetPath);
            // Links are often relative, so we need to resolve them against the link parent directory:
            targetPath = path.resolve(path.dirname(targetPath), linkTarget);
        } catch (e: any) {
            // Target file does not exist:
            if (e.code === 'ENOENT') return undefined;
            // Not a link, or some other error:
            else return targetPath;
        }
    }
};

export const ensureDirectoryExists = (path: string) =>
    checkAccess(path).catch(() => mkDir(path, { recursive: true }));

export const resolveCommandPath = (path: string): Promise<string | undefined> =>
    lookpath(path);

export const commandExists = (path: string): Promise<boolean> =>
    resolveCommandPath(path).then((result) => result !== undefined);

export const createTmp = (options: tmp.Options = {}) => new Promise<{
    path: string,
    fd: number,
    cleanupCallback: () => void
}>((resolve, reject) => {
    tmp.file(options, (err, path, fd, cleanupCallback) => {
        if (err) return reject(err);
        resolve({ path, fd, cleanupCallback });
    });
});

export const moveFile = async (oldPath: string, newPath: string) => {
    try {
        await fs.promises.rename(oldPath, newPath);
    } catch (e) {
        if (isErrorLike(e) && e.code === 'EXDEV') {
            // Cross-device - can't rename files across partions etc.
            // In that case, we fallback to copy then delete:
            await copyFile(oldPath, newPath);
            await deleteFile(oldPath);
        }
    }
};