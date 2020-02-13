import * as _ from 'lodash';
import * as path from 'path';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { CertCheckServer } from '../cert-check-server';
import { delay, windowsKill, readFile, canAccess, deleteFolder } from '../util';
import { Interceptor } from '.';
import { reportError } from '../error-tracking';

const FIREFOX_PREF_REGEX = /\w+_pref\("([^"]+)", (.*)\);/

let certInstallBrowser: BrowserInstance | undefined;
let browsers: _.Dictionary<BrowserInstance> = {};

export class FreshFirefox implements Interceptor {
    id = 'fresh-firefox';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    private readonly firefoxProfilePath = path.join(this.config.configPath, 'firefox-profile');

    isActive(proxyPort: number | string) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        const availableBrowsers = await getAvailableBrowsers(this.config.configPath);

        return _(availableBrowsers)
            .map(b => b.name)
            .includes('firefox')

    }

    async startFirefox(
        certCheckServer: CertCheckServer,
        proxyPort?: number,
        existingPrefs = {}
    ) {
        const initialUrl = certCheckServer.checkCertUrl;

        const browser = await launchBrowser(initialUrl, {
            browser: 'firefox',
            profile: this.firefoxProfilePath,
            proxy: proxyPort ? `127.0.0.1:${proxyPort}` : undefined,
            prefs: _.assign(
                existingPrefs,
                proxyPort ? {
                    // By default browser-launcher only configures HTTP, so we need to add HTTPS:
                    'network.proxy.ssl': '"127.0.0.1"',
                    'network.proxy.ssl_port': proxyPort,

                    // The above browser-launcher proxy settings should do this, but don't seem to
                    // reliably overwrite existing values, so we set them explicitly.
                    'network.proxy.http': '"127.0.0.1"',
                    'network.proxy.http_port': proxyPort,
                    // Don't intercept our cert testing requests
                    'network.proxy.no_proxies_on': "\"" + certCheckServer.host + "\"",
                    'network.proxy.http.no_proxies_on': "\"" + certCheckServer.host + "\"",

                    // Send localhost reqs via the proxy too
                    'network.proxy.allow_hijacking_localhost': true,
                } : {},
                {
                    // Disable the noisy captive portal check requests
                    'network.captive-portal-service.enabled': false,

                    // Disable some annoying tip messages
                    'browser.chrome.toolbar_tips': false,

                    // Ignore available updates:
                    "app.update.auto": false,
                    "browser.startup.homepage_override.mstone": "\"ignore\"",

                    // Disable exit warnings:
                    "browser.showQuitWarning": false,
                    "browser.tabs.warnOnClose": false,
                    "browser.tabs.warnOnCloseOtherTabs": false,

                    // Disable various first-run things:
                    "browser.uitour.enabled": false,
                    'browser.usedOnWindows10': true,
                    "browser.usedOnWindows10.introURL": "\"\"",
                    'datareporting.healthreport.service.firstRun': false,
                    'toolkit.telemetry.reportingpolicy.firstRun': false,
                    'browser.reader.detectedFirstArticle': false,
                    "datareporting.policy.dataSubmissionEnabled": false,
                    "datareporting.policy.dataSubmissionPolicyAccepted": false,
                    "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
                    "trailhead.firstrun.didSeeAboutWelcome": true,

                    // Refresh all state on shutdown:
                    "privacy.history.custom": true,
                    "privacy.sanitize.sanitizeOnShutdown": true,
                    "privacy.clearOnShutdown.cache": true,
                    "privacy.clearOnShutdown.cookies": true,
                    "privacy.clearOnShutdown.downloads": true,
                    "privacy.clearOnShutdown.formdata": true,
                    "privacy.clearOnShutdown.history": true,
                    "privacy.clearOnShutdown.offlineApps": true,
                    "privacy.clearOnShutdown.sessions": true,
                    "privacy.clearOnShutdown.siteSettings": true,
                    // Must be false, or 1st startup 2nd start opens a blank page, not the target URL:
                    "privacy.clearOnShutdown.openWindows": false
                }
            )
        }, this.config.configPath);

        if (browser.process.stdout) browser.process.stdout.pipe(process.stdout);
        if (browser.process.stderr) browser.process.stderr.pipe(process.stderr);

        const normalStop = browser.stop.bind(browser);
        browser.stop = async function () {
            if (process.platform === "win32") {
                // Firefox spawns a child process on Windows, and doesn't let us kill it at all.
                // To fix this, we kill all firefox instances that were started with this exact same URL.
                await windowsKill(`CommandLine Like '%\\\\firefox.exe%${initialUrl}'`);
            } else {
                normalStop();
            }
        };

        return browser;
    }

    async setupFirefoxProfile() {
        const certCheckServer = new CertCheckServer(this.config);
        await certCheckServer.start();

        let certInstalled: Promise<void> | true = certCheckServer.waitForSuccess().catch(reportError);

        certInstallBrowser = await this.startFirefox(certCheckServer);
        certInstallBrowser.process.once('close', () => {
            certCheckServer.stop();
            certInstallBrowser = undefined;

            if (certInstalled !== true) {
                reportError('Firefox certificate setup failed');
                deleteFolder(this.firefoxProfilePath).catch(console.warn);
            }
        });

        await certInstalled;
        certInstalled = true;

        await delay(200); // Tiny delay, so firefox can do initial setup tasks

        // Tell firefox to shutdown, and wait until it does.
        certInstallBrowser.stop();
        return new Promise((resolve) => {
            if (!certInstallBrowser) return resolve();
            else certInstallBrowser.process.once('close', resolve);
        });
    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort) || !!certInstallBrowser) return;

        const firefoxPrefsFile = path.join(this.firefoxProfilePath, 'prefs.js');

        let existingPrefs: _.Dictionary<any> = {};

        if (await canAccess(firefoxPrefsFile) === false) {
            /*
            First time, we do a separate pre-usage startup & stop, without the proxy, for certificate setup.
            This helps avoid initial Firefox profile setup request noise, and tidies up some awkward UX where
            firefox likes to open extra welcome windows/tabs on first run.
            */
            await this.setupFirefoxProfile();
        }

        const certCheckServer = new CertCheckServer(this.config);
        await certCheckServer.start('https://amiusing.httptoolkit.tech');

        // We need to preserve & reuse any existing preferences, to avoid issues
        // where on pref setup firefox behaves badly (opening a 2nd window) on OSX.
        const prefContents = await readFile(firefoxPrefsFile, {
            encoding: 'utf8'
        }).catch(() => '');

        existingPrefs = _(prefContents)
            .split('\n')
            .reduce((prefs: _.Dictionary<any>, line) => {
                const match = FIREFOX_PREF_REGEX.exec(line);
                if (match) {
                    prefs[match[1]] = match[2];
                }
                return prefs
            }, {});

        const browser = await this.startFirefox(certCheckServer, proxyPort, existingPrefs);

        let success = false;
        certCheckServer.waitForSuccess().then(() => {
            success = true;
        }).catch(reportError);

        browsers[proxyPort] = browser;
        browser.process.once('close', () => {
            certCheckServer.stop();
            delete browsers[proxyPort];
            if (!success) {
                reportError('Firefox certificate check failed');
                deleteFolder(this.firefoxProfilePath).catch(console.warn);
            }
        });

        // Delay the approx amount of time it normally takes Firefox to really open
        await delay(1000);
    }

    async deactivate(proxyPort: number | string) {
        if (this.isActive(proxyPort)) {
            const browser = browsers[proxyPort];
            const closePromise = new Promise((resolve) => browser.process.once('close', resolve));
            browser.stop();
            await closePromise;
        }
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(browsers).map((proxyPort) => this.deactivate(proxyPort))
        );
        if (certInstallBrowser) {
            certInstallBrowser.stop();
            return new Promise((resolve) => certInstallBrowser!.process.once('close', resolve));
        }
    }
};