import _ from 'lodash';
import * as path from 'path';
import { SpawnOptions } from 'child_process';

import { delay, isErrorLike } from '@httptoolkit/util';

import { APP_ROOT } from '../constants';
import { HtkConfig } from '../config';
import { logError } from '../error-tracking';

import { isSnap, getSnapConfigPath } from '../util/snap';

import { launchBrowser, BrowserInstance, getBrowserDetails } from '../browsers';
import { readFile, canAccess, deleteFolder } from '../util/fs';
import { windowsKill, spawnToResult } from '../util/process-management';
import { MessageServer } from '../message-server';
import { CertCheckServer } from '../cert-check-server';
import { Interceptor } from '.';

const FIREFOX_PREF_REGEX = /\w+_pref\("([^"]+)", (.*)\);/

let profileSetupBrowser: BrowserInstance | undefined;

export const NSS_DIR = path.join(APP_ROOT, 'nss');

const testCertutil = (command: string, options?: SpawnOptions) => {
    return spawnToResult(command, ['-h'], options)
        .then((output) =>
            output.exitCode === 1 &&
            output.stderr.includes("Utility to manipulate NSS certificate databases")
        )
        .catch((e: any) => {
            if (!isErrorLike(e) || e.code !== 'ENOENT') {
                console.log(`Failed to run ${command}`);
                console.log(e);
            }
            return false;
        });
};

const getCertutilCommand = _.memoize(async () => {
    // If a working certutil is available in our path, we're all good
    if (await testCertutil('certutil')) return { command: 'certutil' };

    // If not, try to use the relevant bundled version
    const bundledCertUtil = path.join(NSS_DIR, process.platform, 'certutil');
    if (process.platform !== 'linux') {
        if (await testCertutil(bundledCertUtil)) {
            return { command: bundledCertUtil };
        } else {
            throw new Error("No certutil available");
        }
    }

    const certutilEnv = {
        ...process.env,
        // The linux bundle includes most required libs, but we need to make sure it's
        // in the search path so they get used, in case they're not installed elsewhere.
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH
            ? `${path.join(NSS_DIR, process.platform)}:${process.env.LD_LIBRARY_PATH}`
            : path.join(NSS_DIR, process.platform)
    };

    if (await testCertutil(bundledCertUtil, { env: certutilEnv })) {
        return { command: bundledCertUtil, options: { env: certutilEnv } };
    } else {
        throw new Error("No certutil available");
    }
});

abstract class Firefox implements Interceptor {
    readonly abstract id: string;
    readonly abstract version: string;

    protected constructor(
        private config: HtkConfig,
        private variantName: string,
        private pathName: string = variantName + '-profile',
    ) {}

    private readonly activeBrowsers: _.Dictionary<BrowserInstance> = {};


    isActive(proxyPort: number | string) {
        const browser = this.activeBrowsers[proxyPort];
        return !!browser && !!browser.pid;
    }

    async isActivable() {
        const firefoxBrowser = await getBrowserDetails(this.config.configPath, this.variantName);

        return !!firefoxBrowser && // Must have Firefox installed
            parseInt(firefoxBrowser.version.split('.')[0], 0) >= 58 && // Must use cert9.db
            await getCertutilCommand().then(() => true).catch(() => false) // Must have certutil available
    }

    async startFirefox(
        profilePath: string,
        initialServer: MessageServer | CertCheckServer,
        proxyPort?: number,
        existingPrefs = {}
    ) {
        const initialUrl = initialServer.url;

        const browser = await launchBrowser(initialUrl, {
            browser: this.variantName,
            profile: profilePath,
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
                    'network.proxy.no_proxies_on': "\"" + initialServer.host + "\"",
                    'network.proxy.http.no_proxies_on': "\"" + initialServer.host + "\"",


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

        console.log('Firefox started');

        if (browser.process.stdout) browser.process.stdout.pipe(process.stdout);
        if (browser.process.stderr) browser.process.stderr.pipe(process.stderr);

        const normalStop = browser.stop.bind(browser);
        browser.stop = async function () {
            if (process.platform === "win32") {
                // Firefox spawns a child process on Windows, and doesn't let us kill it at all.
                // To fix this, we kill all firefox instances that were started with this exact same URL.
                await windowsKill(`CommandLine Like '%\\\\firefox.exe%${initialUrl}'`).catch(console.log);
            } else {
                normalStop();
            }
        };

        return browser;
    }

    // Create the profile. We need to run FF to do its setup, then close it & edit more ourselves.
    async setupFirefoxProfile(profilePath: string) {
        const messageServer = new MessageServer(
            this.config,
            `HTTP Toolkit is preparing a Firefox profile, please wait...`
        );
        await messageServer.start();

        let messageShown: Promise<void> | true = messageServer.waitForSuccess().catch(logError);

        profileSetupBrowser = await this.startFirefox(profilePath, messageServer);
        profileSetupBrowser.process.once('close', (exitCode) => {
            console.log("Profile setup Firefox closed");
            messageServer.stop();
            profileSetupBrowser = undefined;

            if (messageShown !== true) {
                logError(`Firefox profile setup failed with code ${exitCode}`);
                deleteFolder(profilePath).catch(console.warn);
            }
        });

        await messageShown;
        messageShown = true;

        await delay(200); // Tiny delay, so firefox can do initial setup tasks

        // Tell firefox to shutdown, and wait until it does.
        profileSetupBrowser.stop();
        await new Promise<void>((resolve) => {
            if (!profileSetupBrowser) return resolve();
            else profileSetupBrowser.process.once('close', resolve);
        });

        // Once firefox has shut, rewrite the certificate database of the newly created profile:
        const certutil = await getCertutilCommand();
        const certUtilResult = await spawnToResult(
            certutil.command, [
                '-A',
                '-d', `sql:${profilePath}`,
                '-t', 'C,,',
                '-i', this.config.https.certPath,
                '-n', 'HTTP Toolkit'
            ],
            certutil.options || {}
        );

        if (certUtilResult.exitCode !== 0) {
            console.log(certUtilResult.stdout);
            console.log(certUtilResult.stderr);
            throw new Error(`Certutil firefox profile setup failed with code ${certUtilResult.exitCode}`);
        }
    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort) || !!profileSetupBrowser) return;

        const browserDetails = await getBrowserDetails(this.config.configPath, this.variantName);
        if (!browserDetails) throw new Error('Firefox could not be detected');

        const profilePath = await isSnap(browserDetails.command)
            ? path.join(await getSnapConfigPath(this.variantName), 'profile')
            : path.join(this.config.configPath, this.pathName);

        const firefoxPrefsFile = path.join(profilePath, 'prefs.js');

        let existingPrefs: _.Dictionary<any> = {};

        if (!await canAccess(firefoxPrefsFile)) {
            /*
            First time, we do a separate pre-usage startup & stop, without the proxy, for certificate setup.
            This helps avoid initial Firefox profile setup request noise, and tidies up some awkward UX where
            firefox likes to open extra welcome windows/tabs on first run.
            */
            await this.setupFirefoxProfile(profilePath);
        }

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

        const certCheckServer = new CertCheckServer(this.config);
        await certCheckServer.start("https://amiusing.httptoolkit.tech");

        const browser = await this.startFirefox(profilePath, certCheckServer, proxyPort, existingPrefs);

        let certCheckSuccessful: boolean | undefined;
        certCheckServer.waitForSuccess().then(() => {
            certCheckSuccessful = true;
        }).catch((e) => {
            certCheckSuccessful = false;
            logError(e);
        });

        this.activeBrowsers[proxyPort] = browser;
        browser.process.once('close', async (exitCode) => {
            console.log('Firefox closed');
            delete this.activeBrowsers[proxyPort];

            // It seems maybe this can happen when firefox is just updated - it starts and
            // closes immediately, but loses some settings along the way. In that case, the 2nd
            // run will still try to load the cert check server. Keep it up for a sec so
            // that users get a clean error in this case.
            await delay(2000);
            certCheckServer.stop();

            if (!certCheckSuccessful) {
                logError(`Firefox certificate check ${
                    certCheckSuccessful === false
                        ? "failed"
                        : "did not complete"
                } with FF exit code ${exitCode}`);
                deleteFolder(profilePath).catch(console.warn);
            }
        });

        // Wait until the cert check works before reporting success to the UI
        await certCheckServer.waitForSuccess();
    }

    async deactivate(proxyPort: number | string) {
        if (this.isActive(proxyPort)) {
            const browser = this.activeBrowsers[proxyPort];
            const closePromise = new Promise((resolve) => browser.process.once('close', resolve));
            browser.stop();
            await closePromise;
        }
    }

    async deactivateAll(): Promise<void> {
        await Promise.all(
            Object.keys(this.activeBrowsers).map((proxyPort) => this.deactivate(proxyPort))
        );
        if (profileSetupBrowser) {
            profileSetupBrowser.stop();
            return new Promise((resolve) => profileSetupBrowser!.process.once('close', resolve));
        }
    }
};

export class FreshFirefox extends Firefox {

    id = 'fresh-firefox';
    version = '1.2.0';

    constructor(config: HtkConfig) {
        super(config, 'firefox');
    }
};

export class FreshFirefoxDeveloper extends Firefox {

    id = 'fresh-firefox-dev';
    version = '1.2.0';

    constructor(config: HtkConfig) {
        super(config, 'firefox-developer');
    }
};

export class FreshFirefoxNightly extends Firefox {

    id = 'fresh-firefox-nightly';
    version = '1.2.0';

    constructor(config: HtkConfig) {
        super(config, 'firefox-nightly');
    }
};