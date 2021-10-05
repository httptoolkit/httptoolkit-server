import { promisify } from 'util';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { lookpath } from 'lookpath';

export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function waitUntil<T extends unknown>(
    delayMs: number,
    tries: number,
    test: () => Promise<T>
): Promise<Exclude<T, false>> {
    let result = tries > 0 && await test()

    while (tries > 0 && !result) {
        tries = tries - 1;
        await delay(delayMs);
        result = await test();
    }

    if (!result) throw new Error(`Wait loop failed`);
    else return result as Exclude<T, false>;
}

export type ErrorLike = Partial<Error> & {
    // Various properties we might want to look for on errors:
    code?: string,
    cmd?: string,
    signal?: string
};

// Useful to easily cast and then examine errors that are otherwise 'unknown':
export function isErrorLike(error: any): error is ErrorLike {
    return typeof error === 'object' && (
        error instanceof Error ||
        error.message ||
        error.code ||
        error.stack
    )
}

export interface Deferred<T> {
    resolve: (arg: T) => void,
    reject: (e?: Error) => void,
    promise: Promise<T>
}

export function getDeferred<T = void>(): Deferred<T> {
    let resolve: undefined | ((arg: T) => void) = undefined;
    let reject: undefined | ((e?: Error) => void) = undefined;

    let promise = new Promise<T>((resolveCb, rejectCb) => {
        resolve = resolveCb;
        reject = rejectCb;
    });

    // TS thinks we're using these before they're assigned, which is why
    // we need the undefined types, and the any here.
    return { resolve, reject, promise } as any;
}

export const statFile = promisify(fs.stat);
export const readFile = promisify(fs.readFile);
export const readDir = promisify(fs.readdir);
export const deleteFile = promisify(fs.unlink);
export const checkAccess = promisify(fs.access);
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