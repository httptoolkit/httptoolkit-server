import * as _ from 'lodash';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { CertCheckServer } from '../cert-check-server';

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

        // TODO: Change james launcher so I can pass a profile here,
        // so things persist across launches. Permanently? Yes, probably.

        const browser = await launchBrowser(certCheckServer.checkCertUrl, {
            browser: 'firefox',
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

                // Disable 'new FF available' messages

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

        browsers[proxyPort] = browser;
        browser.process.once('exit', () => {
            certCheckServer.stop();
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