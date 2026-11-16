import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'chai';

import {
    ensurePrivateDir,
    ensureRuntimeDir,
    getRuntimeDirPath
} from '../../src/util/runtime-dir';

const isPosix = process.platform !== 'win32';

async function expectInsecureDirError(promise: Promise<unknown>) {
    const error = await promise.then(() => undefined, (e: Error) => e);
    expect(error?.message).to.include('is not a private directory');
}

describe("Runtime directory", function () {

    let baseDir: string;
    const originalEnv = {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        TMPDIR: process.env.TMPDIR
    };

    beforeEach(async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'htk-runtime-dir-test-'));
    });

    afterEach(async () => {
        // process.env must be mutated in place, as os.tmpdir() reads the real environment
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(baseDir, { recursive: true, force: true });
    });

    describe("path selection", () => {

        before(function () {
            if (process.platform !== 'linux') this.skip();
        });

        it("uses XDG_RUNTIME_DIR when set", () => {
            process.env.XDG_RUNTIME_DIR = '/run/user/1234';
            expect(getRuntimeDirPath()).to.equal('/run/user/1234');
        });

        it("uses a per-user subdirectory of a shared /tmp", () => {
            delete process.env.XDG_RUNTIME_DIR;
            delete process.env.TMPDIR;
            expect(getRuntimeDirPath()).to.equal(`/tmp/httptoolkit-${process.getuid!()}`);
        });

        it("uses a custom TMPDIR directly", async () => {
            delete process.env.XDG_RUNTIME_DIR;
            process.env.TMPDIR = baseDir;
            expect(getRuntimeDirPath()).to.equal(baseDir);
            expect(await ensureRuntimeDir()).to.equal(baseDir);
        });
    });

    describe("private directory checks", () => {

        before(function () {
            if (!isPosix) this.skip();
        });

        it("creates a missing directory as private", async () => {
            const dir = path.join(baseDir, 'private');
            await ensurePrivateDir(dir, process.getuid!());

            const stats = await fs.lstat(dir);
            expect(stats.isDirectory()).to.equal(true);
            expect(stats.mode & 0o777).to.equal(0o700);
        });

        it("accepts an existing private directory", async () => {
            const dir = path.join(baseDir, 'private');
            await fs.mkdir(dir, { mode: 0o700 });
            await fs.writeFile(path.join(dir, 'file'), 'content');

            await ensurePrivateDir(dir, process.getuid!());
            expect(await fs.readFile(path.join(dir, 'file'), 'utf8')).to.equal('content');
        });

        it("replaces a world-writable directory that we own", async () => {
            const dir = path.join(baseDir, 'shared');
            await fs.mkdir(dir);
            await fs.chmod(dir, 0o777);
            await fs.writeFile(path.join(dir, 'planted'), 'content');

            await ensurePrivateDir(dir, process.getuid!());

            const stats = await fs.lstat(dir);
            expect(stats.mode & 0o777).to.equal(0o700);
            expect(await fs.readdir(dir)).to.deep.equal([]);

            const staleDirs = (await fs.readdir(baseDir)).filter((f) => f.startsWith('shared.stale-'));
            expect(staleDirs).to.have.length(1);
            expect(await fs.readdir(path.join(baseDir, staleDirs[0]))).to.deep.equal(['planted']);
        });

        it("replaces a symlink without touching its target", async () => {
            const target = path.join(baseDir, 'target');
            await fs.mkdir(target, { mode: 0o700 });
            await fs.writeFile(path.join(target, 'file'), 'content');
            const link = path.join(baseDir, 'link');
            await fs.symlink(target, link);

            await ensurePrivateDir(link, process.getuid!());

            expect((await fs.lstat(link)).isDirectory()).to.equal(true);
            expect(await fs.readdir(link)).to.deep.equal([]);
            expect(await fs.readdir(target)).to.deep.equal(['file']);
        });

        it("replaces a non-directory", async () => {
            const file = path.join(baseDir, 'file');
            await fs.writeFile(file, '', { mode: 0o600 });

            await ensurePrivateDir(file, process.getuid!());
            expect((await fs.lstat(file)).isDirectory()).to.equal(true);
        });

        describe("when the existing path cannot be moved", () => {
            // A read-only parent blocks renames, like the sticky bit does in /tmp
            // for entries owned by other users.
            let parentDir: string;

            beforeEach(async () => {
                parentDir = path.join(baseDir, 'parent');
                await fs.mkdir(parentDir);
            });

            afterEach(async () => {
                await fs.chmod(parentDir, 0o700);
            });

            it("rejects a world-writable directory", async () => {
                const dir = path.join(parentDir, 'shared');
                await fs.mkdir(dir);
                await fs.chmod(dir, 0o777);
                await fs.chmod(parentDir, 0o555);

                await expectInsecureDirError(ensurePrivateDir(dir, process.getuid!()));
                expect((await fs.lstat(dir)).mode & 0o777).to.equal(0o777);
            });

            it("rejects a directory owned by a different user", async () => {
                const dir = path.join(parentDir, 'other-user');
                await fs.mkdir(dir, { mode: 0o700 });
                await fs.chmod(parentDir, 0o555);

                await expectInsecureDirError(ensurePrivateDir(dir, process.getuid!() + 1));
            });
        });
    });
});
