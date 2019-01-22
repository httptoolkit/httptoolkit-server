import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';

import * as getBrowserLauncherCb from '@james-proxy/james-browser-launcher';
import { LaunchOptions, BrowserInstance } from '@james-proxy/james-browser-launcher';

import { reportError } from './error-tracking';

const statFile = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const deleteFile = promisify(fs.unlink);
const getBrowserLauncher = promisify(getBrowserLauncherCb);

const browserConfigPath = (configPath: string) => path.join(configPath, 'browsers.json');

export { BrowserInstance };

export async function checkBrowserConfig(configPath: string) {
    // It's not clear why, but sometimes the browser config can become corrupted, so it's not valid JSON
    // If that happens JBL doesn't catch it, so we crash. To avoid that, we check it here on startup.

    const browserConfig = browserConfigPath(configPath);
    return Promise.all([
        // Check the file is readable and parseable
        readFile(browserConfig, 'utf8')
            .then((contents) => JSON.parse(contents)),

        // Check the file is relatively recent
        statFile(browserConfig)
            .then((stats) => {
                if (Date.now() - stats.mtime.valueOf() > 1000 * 60 * 60 * 24) {
                    return deleteFile(browserConfig).catch((err) => {
                        console.error('Failed to clear outdated config file');
                        reportError(err);
                    });
                };
            })
    ])
    .catch((error) => {
        if (error.code === 'ENOENT') return;

        console.warn('Failed to read browser config on startup', error);
        return deleteFile(browserConfig).catch((err) => {
            console.error('Failed to clear broken config file:', err);
            reportError(err);
        });
    })
}

// It's not safe to call getBrowserLauncher in parallel, as config files can
// get corrupted. We use a mutex to serialize it.
const getLauncherMutex = new Mutex();

function getLauncher(configPath: string) {
    return getLauncherMutex.runExclusive(() =>
        getBrowserLauncher(browserConfigPath(configPath))
    );
}

export const getAvailableBrowsers = async (configPath: string) => {
    return (await getLauncher(configPath)).browsers;
};

export const launchBrowser = async (url: string, options: LaunchOptions, configPath: string) => {
    const launcher = await getLauncher(configPath);
    return await promisify(launcher)(url, options);
};