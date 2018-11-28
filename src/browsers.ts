import * as path from 'path';
import * as getBrowserLauncher from '@james-proxy/james-browser-launcher';
import { Launch, LaunchOptions, BrowserInstance } from '@james-proxy/james-browser-launcher';
import { promisify } from 'util';

export { BrowserInstance };

async function getLauncher(configPath: string) {
    return await promisify(getBrowserLauncher)(path.join(configPath, 'browsers.json'));
}

export const getAvailableBrowsers = async (configPath: string) => {
    return (await getLauncher(configPath)).browsers;
};

export const launchBrowser = async (url: string, options: LaunchOptions, configPath: string) => {
    const launcher = await getLauncher(configPath);
    return await promisify(launcher)(url, options);
};