import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance, Browser } from '../browsers';
import { delay, readFile, deleteFolder } from '../util';
import { HideWarningServer } from '../hide-warning-server';
import { Interceptor } from '.';
import { reportError } from '../error-tracking';

const getBrowserDetails = async (config: HtkConfig, variant: string): Promise<Browser | undefined> => {
    const browsers = await getAvailableBrowsers(config.configPath);

    // Get the details for the first of these browsers that is installed.
    return _.find(browsers, b => b.name === variant);
};

abstract class ChromiumBasedInterceptor implements Interceptor {

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

        const certificatePem = await readFile(this.config.https.certPath, 'utf8');
        const spkiFingerprint = generateSPKIFingerprint(certificatePem);

        const hideWarningServer = new HideWarningServer(this.config);
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const browserDetails = await getBrowserDetails(this.config, this.variantName);

        const browser = await launchBrowser(hideWarningServer.hideWarningUrl, {
            browser: browserDetails ? browserDetails.name : this.variantName,
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
                `--ignore-certificate-errors-spki-list=${spkiFingerprint}`
            ]
        }, this.config.configPath);

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
                    deleteFolder(browserDetails.profile).catch(reportError);
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

export class FreshChrome extends ChromiumBasedInterceptor {

    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome');
    }

};

export class FreshChromeBeta extends ChromiumBasedInterceptor {

    id = 'fresh-chrome-beta';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-beta');
    }

};

export class FreshChromeDev extends ChromiumBasedInterceptor {

    id = 'fresh-chrome-dev';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-dev');
    }

};

export class FreshChromeCanary extends ChromiumBasedInterceptor {

    id = 'fresh-chrome-canary';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chrome-canary');
    }

};

export class FreshChromium extends ChromiumBasedInterceptor {

    id = 'fresh-chromium';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chromium');
    }

};

export class FreshChromiumDev extends ChromiumBasedInterceptor {

    id = 'fresh-chromium-dev';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'chromium-dev');
    }

};

export class FreshEdge extends ChromiumBasedInterceptor {

    id = 'fresh-edge';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge');
    }

};

export class FreshEdgeBeta extends ChromiumBasedInterceptor {

    id = 'fresh-edge-beta';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge-beta');
    }

};

export class FreshEdgeCanary extends ChromiumBasedInterceptor {

    id = 'fresh-edge-canary';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'msedge-canary');
    }

};

export class FreshBrave extends ChromiumBasedInterceptor {

    id = 'fresh-brave';
    version = '1.0.0';

    constructor(config: HtkConfig) {
        super(config, 'brave');
    }

};

export class FreshOpera extends ChromiumBasedInterceptor {

    id = 'fresh-opera';
    version = '1.0.1';

    constructor(config: HtkConfig) {
        super(config, 'opera');
    }

};