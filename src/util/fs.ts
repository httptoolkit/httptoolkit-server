import { promisify } from 'util';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { lookpath } from 'lookpath';

import { isErrorLike } from './error';

export const statFile = promisify(fs.stat);
export const readFile = promisify(fs.readFile);
export const readDir = promisify(fs.readdir);
export const deleteFile = promisify(fs.unlink);
export const checkAccess = promisify(fs.access);
export const chmod = promisify(fs.chmod);
export const mkDir = promisify(fs.mkdir);
export const writeFile = promisify(fs.writeFile);
export const renameFile = promisify(fs.rename);
export const copyFile = promisify(fs.copyFile);

export const canAccess = (path: string) => checkAccess(path).then(() => true).catch(() => false);

export const deleteFolder = promisify(rimraf);

export const ensureDirectoryExists = (path: string) =>
    checkAccess(path).catch(() => mkDir(path, { recursive: true }));

export const commandExists = (path: string): Promise<boolean> =>
    lookpath(path).then((result) => result !== undefined);

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
        await renameFile(oldPath, newPath);
    } catch (e) {
        if (isErrorLike(e) && e.code === 'EXDEV') {
            // Cross-device - can't rename files across partions etc.
            // In that case, we fallback to copy then delete:
            await copyFile(oldPath, newPath);
            await deleteFile(oldPath);
        }
    }
};