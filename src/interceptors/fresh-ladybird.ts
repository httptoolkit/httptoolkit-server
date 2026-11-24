import _ from 'lodash';
import * as path from 'path';

import { HtkConfig } from '../config';
import { launchBrowser, BrowserInstance, getBrowserDetails } from '../browsers';
import {
    canAccess,
    deleteFolder,
    ensureDirectoryExists,
    resolveRealPath,
    writeFile
} from '../util/fs';
import { waitUntil } from '../util/promise';
import { ensureRuntimeDir } from '../util/runtime-dir';
import { Interceptor } from '.';

const VARIANT_NAME = 'ladybird';

// Ladybird listens on a Unix socket inside its profile, and fails to start if that socket's
// path doesn't fit within the OS's limit for socket addresses.
const PROFILE_SOCKET_PATH = path.join('runtime', 'Ladybird.socket');
const MAX_SOCKET_PATH_LENGTH = process.platform === 'darwin' ? 103 : 107;

const isUsableProfilePath = (profilePath: string) =>
    Buffer.byteLength(path.join(profilePath, PROFILE_SOCKET_PATH)) <= MAX_SOCKET_PATH_LENGTH;

interface LadybirdSession {
    browser: BrowserInstance;
    // Resolves once the browser has exited and its profile has been cleaned up
    ended: Promise<void>;
}

export class FreshLadybird implements Interceptor {

    id = 'fresh-ladybird';
    version = '1.0.0';

    private readonly activeSessions: _.Dictionary<LadybirdSession> = {};
    private readonly lastSessionEnds: _.Dictionary<Promise<void>> = {};
    private readonly pendingOperations: _.Dictionary<Promise<void>> = {};

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number | string) {
        const session = this.activeSessions[proxyPort];
        return !!session && !!session.browser.pid;
    }

    async isActivable() {
        const browserDetails = await getBrowserDetails(this.config.configPath, VARIANT_NAME);
        return !!browserDetails;
    }

    // Each port has a single profile & browser instance, so overlapping launches or shutdowns
    // for the same port would interfere with each other.
    private runExclusively(proxyPort: number | string, operation: () => Promise<void>) {
        const previousOperation = this.pendingOperations[proxyPort] ?? Promise.resolve();
        const result = previousOperation.then(operation);
        this.pendingOperations[proxyPort] = result.catch(() => {});
        return result;
    }

    // Ladybird runs one instance per profile, so each proxy port needs its own
    private async getProfilePath(proxyPort: number | string) {
        // Ladybird resolves symlinks before building its socket path, so we must too
        const configPath = await resolveRealPath(this.config.configPath);
        const profilePath = path.join(configPath, `ladybird${proxyPort}`);
        if (isUsableProfilePath(profilePath)) return profilePath;

        const runtimeDir = await resolveRealPath(await ensureRuntimeDir());
        const fallbackPath = path.join(runtimeDir, `httptoolkit-ladybird-${proxyPort}`);
        if (isUsableProfilePath(fallbackPath)) return fallbackPath;

        throw new Error(
            `Ladybird profile paths are too long for a Unix socket: ${profilePath}, ${fallbackPath}`
        );
    }

    private async prepareProfile(profilePath: string) {
        // Clear any profile left behind by a session that wasn't cleaned up
        await deleteFolder(profilePath);

        const configPath = path.join(profilePath, 'config');
        await ensureDirectoryExists(configPath);
        await writeFile(path.join(configPath, 'Settings.json'), JSON.stringify({
            // Skip the welcome page, which otherwise opens in front of our own page
            firstRunComplete: true,
            // Avoid noise from update checks & content filter list updates
            backgroundNetworking: { enabled: false }
        }));
    }

    private launch(proxyPort: number, profilePath: string) {
        return launchBrowser(
            'https://amiusing.httptoolkit.tech',
            {
                browser: VARIANT_NAME,
                profile: profilePath,
                proxy: `http://127.0.0.1:${proxyPort}`,
                options: [`--certificate=${this.config.https.certPath}`]
            },
            this.config.configPath
        );
    }

    activate(proxyPort: number) {
        return this.runExclusively(proxyPort, async () => {
            const profilePath = await this.getProfilePath(proxyPort);

            if (this.isActive(proxyPort)) {
                // Ladybird is already running with this profile, so this opens our URL
                // there, and then this new process exits immediately.
                await this.launch(proxyPort, profilePath);
                return;
            }

            await this.lastSessionEnds[proxyPort];
            await this.prepareProfile(profilePath);

            const browser = await this.launch(proxyPort, profilePath);
            if (browser.process.stdout) browser.process.stdout.pipe(process.stdout);
            if (browser.process.stderr) browser.process.stderr.pipe(process.stderr);

            const session: LadybirdSession = {
                browser,
                ended: new Promise<void>((resolve) =>
                    browser.process.once('close', () => resolve())
                ).then(() => {
                    console.log('Ladybird closed');
                    if (this.activeSessions[proxyPort] === session) {
                        delete this.activeSessions[proxyPort];
                    }
                    // Every session starts from scratch, so nothing should outlive it
                    return deleteFolder(profilePath).catch(console.warn);
                })
            };
            this.activeSessions[proxyPort] = session;
            this.lastSessionEnds[proxyPort] = session.ended;

            // Until its socket exists, another launch with this profile won't find this
            // instance, and would start a second untracked instance instead of opening a
            // window here.
            const socketPath = path.join(profilePath, PROFILE_SOCKET_PATH);
            const started = await waitUntil(50, 200, async () =>
                this.activeSessions[proxyPort] !== session || await canAccess(socketPath)
            ).catch(() => false);

            if (this.activeSessions[proxyPort] !== session) {
                throw new Error('Ladybird exited before it finished starting up');
            }

            if (!started) {
                browser.stop();
                await session.ended;
                throw new Error('Ladybird did not finish starting up in time');
            }
        });
    }

    deactivate(proxyPort: number | string) {
        return this.runExclusively(proxyPort, async () => {
            const session = this.activeSessions[proxyPort];
            if (!session) return;

            session.browser.stop();
            await session.ended;
        });
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(this.activeSessions).map((proxyPort) => this.deactivate(proxyPort))
        );
    }
};
