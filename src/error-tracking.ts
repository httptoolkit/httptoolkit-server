import * as Sentry from '@sentry/node';

let sentryInitialized = false;

export function initErrorTracking() {
    const packageJson = require('../package.json');
    
    let { SENTRY_DSN } = process.env;
    if (!SENTRY_DSN && process.env.HTTPTOOLKIT_SERVER_BINPATH) {
        // If we're a built binary, use the standard DSN automatically
        SENTRY_DSN = 'https://f6775276f60042bea6d5e951ca1d0e91@sentry.io/1371158';
    }

    if (SENTRY_DSN) {
        Sentry.init({ dsn: SENTRY_DSN, release: packageJson.version });
        Sentry.configureScope((scope) => {
            scope.setTag('platform', process.platform);
        });
        sentryInitialized = true;
    }
}

export function reportError(error: Error | string) {
    console.warn(error);
    if (!sentryInitialized) return;

    if (typeof error === 'string') {
        Sentry.captureMessage(error);
    } else {
        Sentry.captureException(error);
    }
}