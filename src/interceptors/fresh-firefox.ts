import { promisify } from 'util';
import * as _ from 'lodash';
import * as rimraf from 'rimraf';
import * as path from 'path';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { CertCheckServer } from '../cert-check-server';

const deleteFolder = promisify(rimraf);

let browsers: _.Dictionary<BrowserInstance> = {};

export class FreshFirefox {
    id = 'fresh-firefox';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        const browsers = await getAvailableBrowsers(this.config.configPath);

        return _(browsers)
            .map(b => b.name)
            .includes('firefox')

    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const certCheckServer = new CertCheckServer(this.config);
        await certCheckServer.start('https://amiusing.httptoolkit.tech');

        const firefoxProfile = path.join(this.config.configPath, 'firefox-profile');

        const browser = await launchBrowser(certCheckServer.checkCertUrl, {
            browser: 'firefox',
            profile: firefoxProfile,
            proxy: `localhost:${proxyPort}`,
            // Don't intercept our cert testing requests
            noProxy: certCheckServer.host,
            prefs: {
                // By default james-launcher only configures HTTP, so we need to add HTTPS:
                'network.proxy.ssl': '"localhost"',
                'network.proxy.ssl_port': proxyPort,

                // Disable the noisy captive portal check requests
                'network.captive-portal-service.enabled': false,

                // Disable some annoying tip messages
                'browser.chrome.toolbar_tips': false,

                // Ignore available updates:
                "app.update.auto": false,
                "browser.startup.homepage_override.mstone": "ignore",

                // Disable exit warnings:
                "browser.showQuitWarning": false,
                "browser.tabs.warnOnClose": false,
                "browser.tabs.warnOnCloseOtherTabs": false,

                // Disable various first-run things:
                "browser.uitour.enabled": false,
                'browser.usedOnWindows10': true,
                "browser.usedOnWindows10.introURL": "",
                'datareporting.healthreport.service.firstRun': false,
                'toolkit.telemetry.reportingpolicy.firstRun': false,
                'browser.reader.detectedFirstArticle': false,
                "datareporting.policy.dataSubmissionEnabled": false,
                "datareporting.policy.dataSubmissionPolicyAccepted": false,
                "datareporting.policy.dataSubmissionPolicyBypassNotification": true
            }
        }, this.config.configPath);

        let success = false;
        certCheckServer.waitForSuccess().then(() => {
            success = true;
        }).catch(console.warn);

        browsers[proxyPort] = browser;
        browser.process.once('exit', () => {
            certCheckServer.stop();
            delete browsers[proxyPort];
            if (!success) {
                deleteFolder(firefoxProfile).catch(console.warn);
            }
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