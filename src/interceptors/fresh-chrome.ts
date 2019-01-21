import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { delay } from '../util';
import { HideChromeWarningServer } from '../hide-chrome-warning-server';
import { Interceptor } from '.';

const readFile = promisify(fs.readFile);

let browsers: _.Dictionary<BrowserInstance> = {};

// Should we launch Chrome, or Chromium, or do we have nothing available at all?
const getChromeBrowserName = async (config: HtkConfig): Promise<string | undefined> => {
    const browsers = await getAvailableBrowsers(config.configPath);

    return _(browsers)
        .map(b => b.name)
        .intersection(['chrome', 'chromium'])
        .value()[0];
};

export class FreshChrome implements Interceptor {
    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        return !!(await getChromeBrowserName(this.config));
    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const certificatePem = await readFile(this.config.https.certPath, 'utf8');
        const spkiFingerprint = generateSPKIFingerprint(certificatePem);

        const hideWarningServer = new HideChromeWarningServer();
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const browser = await launchBrowser(hideWarningServer.hideWarningUrl, {
            // Try to launch Chrome if we're not sure - it'll trigger a config update,
            // and might find a new install.
            browser: (await getChromeBrowserName(this.config)) || 'chrome',
            proxy: `https://localhost:${proxyPort}`,
            // Don't intercept our warning hiding requests
            noProxy: hideWarningServer.host,
            options: [
                `--ignore-certificate-errors-spki-list=${spkiFingerprint}`
            ]
        }, this.config.configPath);

        await hideWarningServer.completedPromise;
        await hideWarningServer.stop();

        browsers[proxyPort] = browser;
        browser.process.once('exit', () => {
            delete browsers[proxyPort];
        });

        // Delay the approx amount of time it normally takes Chrome to really open
        await delay(500);
    }

    async deactivate(proxyPort: number) {
        if (this.isActive(proxyPort)) {
            const browser = browsers[proxyPort];
            const exitPromise = new Promise((resolve) => browser!.process.once('exit', resolve));
            browser!.stop();
            await exitPromise;
        }
    }
};