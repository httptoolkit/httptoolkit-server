import * as fs from 'fs';
import * as path from 'path';
import * as getBrowserLauncher from '@james-proxy/james-browser-launcher';
import { LaunchOptions, BrowserInstance } from '@james-proxy/james-browser-launcher';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const deleteFile = promisify(fs.unlink);

const browserConfigPath = (configPath: string) => path.join(configPath, 'browsers.json');

export { BrowserInstance };

export async function checkBrowserConfig(configPath: string) {
    // It's not clear why, but sometimes the browser config can become corrupted, so it's not valid JSON
    // If that happens JBL doesn't catch it, so we crash. To avoid that, we check it here on startup.

    const browserConfig = browserConfigPath(configPath);
    return readFile(browserConfig, 'utf8')
    .then((contents) => JSON.parse(contents))
    .catch((error) => {
        if (error.code === 'ENOENT') return;

        console.warn('Failed to read browser config on startup', error);
        return deleteFile(browserConfig).catch((err) => {
            console.error('Failed to clear broken config file:', err);
        });
    });
}

async function getLauncher(configPath: string) {
    return await promisify(getBrowserLauncher)(browserConfigPath(configPath));
}

export const getAvailableBrowsers = async (configPath: string) => {
    return (await getLauncher(configPath)).browsers;
};

export const launchBrowser = async (url: string, options: LaunchOptions, configPath: string) => {
    const launcher = await getLauncher(configPath);
    return await promisify(launcher)(url, options);
};