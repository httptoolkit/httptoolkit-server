import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { delay } from '../util';
import { HideChromeWarningServer } from '../hide-chrome-warning-server';

const readFile = promisify(fs.readFile);

let browsers: _.Dictionary<BrowserInstance> = {};

export class FreshChrome {
    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        const browsers = await getAvailableBrowsers(this.config.configPath);

        return _(browsers)
            .map(b => b.name)
            .includes('chrome')

    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const certificatePem = await readFile(path.join(this.config.configPath, 'ca.pem'), 'utf8');
        const spkiFingerprint = generateSPKIFingerprint(certificatePem);

        const hideWarningServer = new HideChromeWarningServer();
        await hideWarningServer.start('https://amiusing.httptoolkit.tech');

        const browser = await launchBrowser(hideWarningServer.hideWarningUrl, {
            browser: 'chrome',
            proxy: `https://localhost:${proxyPort}`,
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
            browser!.process.kill();
            await new Promise((resolve) => browser!.process.once('exit', resolve));
        }
    }
};