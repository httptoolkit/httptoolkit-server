import { reportError } from './error-tracking';

const ffiPromise = import('ffi-napi')
    .catch(reportError);

const INTERNET_OPTION_REFRESH = 37;
const INTERNET_OPTION_SETTINGS_CHANGED = 39;

export async function markProxySettingsChanged() {
    const ffi = await ffiPromise;
    if (!ffi) return;

    let inet = ffi.Library('wininet', {
        'InternetSetOptionW': ["bool", ['int', 'int', 'int', 'int']]
    });

    inet.InternetSetOptionW(0, INTERNET_OPTION_REFRESH, 0, 0);
    inet.InternetSetOptionW(0, INTERNET_OPTION_SETTINGS_CHANGED, 0, 0);
}