import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

import * as _ from 'lodash';
import { generateSPKIFingerprint } from 'mockttp';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';

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

        const browser = await launchBrowser('https://example.com', {
            browser: 'chrome',
            proxy: `https://localhost:${proxyPort}`,
            options: [
                `--ignore-certificate-errors-spki-list=${spkiFingerprint}`
            ]
        }, this.config.configPath);

        browsers[proxyPort] = browser;
        browser.process.once('exit', () => {
            delete browsers[proxyPort];
        });
    }

    async deactivate(proxyPort: number) {
        if (this.isActive(proxyPort)) {
            const browser = browsers[proxyPort];
            browser!.process.kill();
            await new Promise((resolve) => browser!.process.once('exit', resolve));
        }
    }
};