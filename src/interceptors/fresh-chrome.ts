import * as _ from 'lodash';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';

let browser: BrowserInstance | undefined;

export class FreshChrome {
    id = 'fresh-chrome';
    version = '1.0.0';

    constructor(private configPath: string) { }

    get isActive() {
        return browser != null && !!browser.pid;
    }

    async checkIfAvailable() {
        const browsers = await getAvailableBrowsers(this.configPath);

        return _(browsers)
            .map(b => b.name)
            .includes('chrome')

    }

    async activate() {
        if (this.isActive) return;

        browser = await launchBrowser('https://example.com', {
            browser: 'chrome'
        }, this.configPath);
    }

    async deactivate() {
        if (this.isActive) {
            browser!.process.kill();

            await new Promise((resolve) => browser!.process.on('exit', resolve));

            browser = undefined;
        }
    }
};