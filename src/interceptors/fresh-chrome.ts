import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance, Browser } from '../browsers';
import { delay, readFile, deleteFolder } from '../util';
import { HideWarningServer } from '../hide-warning-server';
import { Interceptor } from '.';
import { reportError } from '../error-tracking';

let browsers: _.Dictionary<BrowserInstance> = {};

// Which Chrome variant should we launch, and do we have one available at all?
const getChromeBrowserDetails = async (config: HtkConfig): Promise<Browser | undefined> => {
    const browsers = await getAvailableBrowsers(config.configPath);

    // Get the details for the first of these browsers that is installed.
    return ['chrome', 'chromium', 'chrome-beta', 'chrome-canary']
        .map((chromeName) => _.find(browsers, b => b.name === chromeName))
        .filter(Boolean)[0] as Browser;
};

export class FreshChrome implements Interceptor {
    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number | string) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        return !!(await getChromeBrowserDetails(this.config));
    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const certificatePem = await readFile(this.config.https.certPath, 'utf8');
        const spkiFingerprint = generateSPKIFingerprint(certificatePem);

        const hideWarningServer = new HideWarningServer();
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const chromeDetails = await getChromeBrowserDetails(this.config);

        const browser = await launchBrowser(hideWarningServer.hideWarningUrl, {
            // Try to launch Chrome if we're not sure - it'll trigger a config update,
            // and might find a new install.
            browser: chromeDetails ? chromeDetails.name : 'chrome',
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

        browsers[proxyPort] = browser;
        browser.process.once('close', () => {
            delete browsers[proxyPort];

            if (Object.keys(browsers).length === 0 && chromeDetails && _.isString(chromeDetails.profile)) {
                // If we were the last browser, and we have a profile path, and it's in our config
                // (just in case something's gone wrong) -> delete the profile to reset everything.

                const profilePath = chromeDetails.profile;
                if (!profilePath.startsWith(this.config.configPath)) {
                    reportError(`Unexpected Chrome profile location, not deleting: ${profilePath}`);
                } else {
                    deleteFolder(chromeDetails.profile).catch(reportError);
                }
            }
        });

        // Delay the approx amount of time it normally takes Chrome to really open
        await delay(500);
    }

    async deactivate(proxyPort: number | string) {
        if (this.isActive(proxyPort)) {
            const browser = browsers[proxyPort];
            const exitPromise = new Promise((resolve) => browser!.process.once('close', resolve));
            browser!.stop();
            await exitPromise;
        }
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(browsers).map((proxyPort) => this.deactivate(proxyPort))
        );
    }
};