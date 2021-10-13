import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import {
    getAvailableBrowsers,
    launchBrowser,
    BrowserInstance,
    Browser,
    LaunchOptions
} from '../browsers';
import { delay } from '../util/promise';
import { readFile, deleteFolder } from '../util/fs';
import { listRunningProcesses, windowsClose, waitForExit } from '../util/process-management';
import { HideWarningServer } from '../hide-warning-server';
import { Interceptor } from '.';
import { reportError } from '../error-tracking';

const getBrowserDetails = async (config: HtkConfig, variant: string): Promise<Browser | undefined> => {
    const browsers = await getAvailableBrowsers(config.configPath);

    // Get the details for the first of these browsers that is installed.
    return _.find(browsers, b => b.name === variant);
};

const getChromiumLaunchOptions = async (
    browser: string,
    config: HtkConfig,
    proxyPort: number,
    hideWarningServer: HideWarningServer
): Promise<LaunchOptions & { options: Required<LaunchOptions>['options'] }> => {
    const certificatePem = await readFile(config.https.certPath, 'utf8');
    const spkiFingerprint = generateSPKIFingerprint(certificatePem);

    return {
        browser,
        proxy: `https://127.0.0.1:${proxyPort}`,
        noProxy: [
            // Force even localhost requests to go through the proxy
            // See https://bugs.chromium.org/p/chromium/issues/detail?id=899126#c17
            '<-loopback>',
            // Don't intercept our warning hiding requests. Note that this must be
            // the 2nd rule here, or <-loopback> would override it.
            hideWarningServer.host
        ],
        options: [
            // Trust our CA certificate's fingerprint:
            `--ignore-certificate-errors-spki-list=${spkiFingerprint}`,
            // Avoid annoying extra network noise:
            '--disable-background-networking'
        ]
    };
}

abstract class FreshChromiumBasedInterceptor implements Interceptor {

    readonly abstract id: string;
    readonly abstract version: string;

    private readonly activeBrowsers: _.Dictionary<BrowserInstance> = {};

    constructor(
        private config: HtkConfig,
        private variantName: string
    ) { }


    isActive(proxyPort: number | string) {
        const browser = this.activeBrowsers[proxyPort];
        return !!browser && !!browser.pid;
    }

    async isActivable() {
        const browserDetails = await getBrowserDetails(this.config, this.variantName)
        return !!browserDetails;
    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const hideWarningServer = new HideWarningServer(this.config);
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const browserDetails = await getBrowserDetails(this.config, this.variantName);

        const browser = await launchBrowser(hideWarningServer.hideWarningUrl,
            await getChromiumLaunchOptions(
                browserDetails ? browserDetails.name : this.variantName,
                this.config,
                proxyPort,
                hideWarningServer
            )
        , this.config.configPath);

        if (browser.process.stdout) browser.process.stdout.pipe(process.stdout);
        if (browser.process.stderr) browser.process.stderr.pipe(process.stderr);

        await hideWarningServer.completedPromise;
        await hideWarningServer.stop();

        this.activeBrowsers[proxyPort] = browser;
        browser.process.once('close', async () => {
            delete this.activeBrowsers[proxyPort];

            // Opera has a launch proc that exits immediately in Windows, so we can't clear the profile there.
            if (process.platform === 'win32' && this.variantName === 'opera') return;
            await delay(1000); // No hurry, make sure the browser & related processes have all cleaned up

            if (Object.keys(this.activeBrowsers).length === 0 && browserDetails && _.isString(browserDetails.profile)) {
                // If we were the last browser, and we have a profile path, and it's in our config
                // (just in case something's gone wrong) -> delete the profile to reset everything.

                const profilePath = browserDetails.profile;
                if (!profilePath.startsWith(this.config.configPath)) {
                    reportError(
                        `Unexpected ${this.variantName} profile location, not deleting: ${profilePath}`
                    );
                } else {
                    const profileFolder = browserDetails.profile;
                    deleteFolder(profileFolder)
                    .catch(async() => {
                        // After 1 error, wait a little and retry
                        await delay(1000);
                        await deleteFolder(profileFolder);
                    }).catch(console.warn); // If it still fails, just give up, not a big deal
                }
            }
        });

        // Delay the approx amount of time it normally takes the browser to really open, just to be sure
        await delay(500);
    }

    async deactivate(proxyPort: number | string) {
        if (this.isActive(proxyPort)) {
            const browser = this.activeBrowsers[proxyPort];
            const exitPromise = new Promise((resolve) => browser!.process.once('close', resolve));
            browser!.stop();
            await exitPromise;
        }
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(this.activeBrowsers).map((proxyPort) => this.deactivate(proxyPort))
        );
    }
};

abstract class ExistingChromiumBasedInterceptor implements Interceptor {

    readonly abstract id: string;
    readonly abstract version: string;

    private activeBrowser: { // We can only intercept one instance
        proxyPort: number,
        browser: BrowserInstance
    } | undefined;

    constructor(
        private config: HtkConfig,
        private variantName: string
    ) { }

    async browserDetails() {
        return getBrowserDetails(this.config, this.variantName);
    }

    isActive(proxyPort: number | string) {
        const activeBrowser = this.activeBrowser;
        return !!activeBrowser &&
            activeBrowser.proxyPort === proxyPort &&
            !!activeBrowser.browser.pid;
    }

    async isActivable() {
        if (this.activeBrowser) return false;
        return !!await this.browserDetails();
    }

    async findExistingPid(): Promise<number | undefined> {
        const processes = await listRunningProcesses();

        const browserDetails = await this.browserDetails();
        if (!browserDetails) {
            throw new Error("Can't intercept existing browser without browser details");
        }

        const browserProcesses = processes.filter((proc) => {
            if (process.platform === 'darwin') {
                if (!proc.command.startsWith(browserDetails.command)) return false;

                const appBundlePath = proc.command.substring(browserDetails.command.length);

                // Only *.app/Contents/MacOS/* is the main app process:
                return appBundlePath.match(/^\/Contents\/MacOS\//);
            } else {
                return proc.bin && (
                    // Find a binary that exactly matches the specific command:
                    proc.bin === browserDetails.command ||
                    // Or whose binary who's matches the path for this specific variant:
                    proc.bin.includes(`${browserDetails.name}/${browserDetails.type}`)
                );
            }
        });

        const defaultRootProcess = browserProcesses.find(({ args }) =>
            args !== undefined &&
            // Find the main process, skipping any renderer/util processes
            !args.includes('--type=') &&
            // Also skip any non-default profile processes (e.g. our own fresh Chromes)
            !args.includes('--user-data-dir')
        );

        return defaultRootProcess && defaultRootProcess.pid;
    }

    async activate(proxyPort: number, options: { closeConfirmed: boolean } = { closeConfirmed: false }) {
        if (!this.isActivable()) return;

        const hideWarningServer = new HideWarningServer(this.config);
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const existingPid = await this.findExistingPid();
        if (existingPid) {
            if (!options.closeConfirmed) {
                // Fail, with metadata requesting the UI to confirm that Chrome should be killed
                throw Object.assign(
                    new Error(`Not killing ${this.variantName}: not confirmed`),
                    { metadata: { closeConfirmRequired: true }, reportable: false }
                );
            }

            if (process.platform === 'win32') {
                windowsClose(existingPid);

                try {
                    await waitForExit(existingPid);
                } catch (e) {
                    // Try again, but less gently this time:
                    process.kill(existingPid);
                    await waitForExit(existingPid);
                }
            } else {
                process.kill(existingPid);
                await waitForExit(existingPid);
            }
        }

        const browserDetails = await getBrowserDetails(this.config, this.variantName);
        const launchOptions = await getChromiumLaunchOptions(
            browserDetails ? browserDetails.name : this.variantName,
            this.config,
            proxyPort,
            hideWarningServer
        );

        // Remove almost all default arguments. Each of these changes behaviour in maybe unexpected
        // ways, notably including --disable-restore which actively causes problems.
        launchOptions.skipDefaults = true;
        launchOptions.options.push(
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-popup-blocking', // Required for hide-warning -> amiusing hop
            // If we killed something, use --restore-last-session to ensure it comes back:
            ...(existingPid ? ['--restore-last-session'] : []),
            // Passing the URL here instead of passing it to launchBrowser ensures that it isn't
            // opened in a separate window when launching on Mac
            hideWarningServer.hideWarningUrl
        );

        const browser = await launchBrowser("", {
            ...launchOptions,
            skipDefaults: true,
            profile: null // Enforce that we use the default profile
        }, this.config.configPath);

        if (browser.process.stdout) browser.process.stdout.pipe(process.stdout);
        if (browser.process.stderr) browser.process.stderr.pipe(process.stderr);

        await hideWarningServer.completedPromise;
        await hideWarningServer.stop();

        this.activeBrowser = { browser, proxyPort };
        browser.process.once('close', async () => {
            delete this.activeBrowser;
        });

        // Delay the approx amount of time it normally takes the browser to really open, just to be sure
        await delay(500);
    }

    async deactivate(proxyPort: number | string) {
        if (this.isActive(proxyPort)) {
            const { browser } = this.activeBrowser!;

            if (process.platform === 'win32') {
                // Try to cleanly close if we can, rather than killing Chrome directly:
                try {
                    await windowsClose(browser!.pid)
                        .then(() => waitForExit(browser!.pid));
                    return;
                } catch (e) {} // If this fails/times out, kill like we do elsewhere:
            }

            const exitPromise = new Promise((resolve) => browser!.process.once('close', resolve));
            browser!.stop();
            await exitPromise;
        }
    }

    async deactivateAll(): Promise<void> {
        if (this.activeBrowser) {
            await this.deactivate(this.activeBrowser.proxyPort);
        }
    }
};

export class FreshChrome extends FreshChromiumBasedInterceptor {

    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome');
    }

};

export class ExistingChrome extends ExistingChromiumBasedInterceptor {

    id = 'existing-chrome';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome');
    }

};

export class FreshChromeBeta extends FreshChromiumBasedInterceptor {

    id = 'fresh-chrome-beta';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-beta');
    }

};

export class FreshChromeDev extends FreshChromiumBasedInterceptor {

    id = 'fresh-chrome-dev';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-dev');
    }

};

export class FreshChromeCanary extends FreshChromiumBasedInterceptor {

    id = 'fresh-chrome-canary';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-canary');
    }

};

export class FreshChromium extends FreshChromiumBasedInterceptor {

    id = 'fresh-chromium';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chromium');
    }

};

export class FreshChromiumDev extends FreshChromiumBasedInterceptor {

    id = 'fresh-chromium-dev';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chromium-dev');
    }

};

export class FreshEdge extends FreshChromiumBasedInterceptor {

    id = 'fresh-edge';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge');
    }

};

export class FreshEdgeBeta extends FreshChromiumBasedInterceptor {

    id = 'fresh-edge-beta';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge-beta');
    }

};

export class FreshEdgeDev extends FreshChromiumBasedInterceptor {

    id = 'fresh-edge-dev';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge-dev');
    }

};

export class FreshEdgeCanary extends FreshChromiumBasedInterceptor {

    id = 'fresh-edge-canary';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge-canary');
    }

};

export class FreshBrave extends FreshChromiumBasedInterceptor {

    id = 'fresh-brave';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'brave');
    }

};

export class FreshOpera extends FreshChromiumBasedInterceptor {

    id = 'fresh-opera';
    version = '1.0.3';

    constructor(config: HtkConfig) {
        super(config, 'opera');
    }

};