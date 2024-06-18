import * as path from 'path';
import { randomUUID } from 'crypto';
import * as child_process from 'child_process';
import * as Sentry from '@sentry/node';
import { RewriteFrames } from '@sentry/integrations';
import { IS_PROD_BUILD } from './constants';

let sentryInitialized = false;

export function initErrorTracking() {
    const packageJson = require('../package.json');

    let { SENTRY_DSN, CI } = process.env;

    const shouldBeEnabled = IS_PROD_BUILD && !CI;

    // Note that we disable all error reporting in CI envs, both our own & others. They
    // tend to be weird configurations that aren't representative so this isn't useful.

    if (!SENTRY_DSN && shouldBeEnabled) {
        // If we're a built binary, use the standard DSN automatically
        SENTRY_DSN = 'https://5838a5520ad44602ae46793727e49ef5@sentry.io/1371158';
    }

    if (SENTRY_DSN) {
        Sentry.init({
            dsn: SENTRY_DSN,
            release: packageJson.version,
            integrations: [
                new RewriteFrames({
                    // We're one dir down: either /bundle, or /src
                    root: process.platform === 'win32'
                        // Root must always be POSIX format, so we transform it on Windows:
                        ? path.posix.join(
                            __dirname
                                .replace(/^[A-Z]:/, '') // remove Windows-style prefix
                                .replace(/\\/g, '/'), // replace all `\\` instances with `/`
                            '..'
                        )
                        :  path.join(__dirname, '..')
                })
            ],
            beforeBreadcrumb(breadcrumb, hint) {
                if (breadcrumb.category === 'http') {
                    // Almost all HTTP requests sent by the server are actually forwarded HTTP from
                    // the proxy, so could be very sensitive. We need to ensure errors don't leak data.

                    // Remove all but the host from the breadcrumb data. The host is fairly safe & often
                    // useful for context, but the path & query could easily contain sensitive secrets.
                    if (breadcrumb.data && breadcrumb.data.url) {
                        const url = breadcrumb.data.url as string;
                        const hostIndex = url.indexOf('://') + 3;
                        const pathIndex = url.indexOf('/', hostIndex);
                        if (pathIndex !== -1) {
                            breadcrumb.data.url = url.slice(0, pathIndex);
                        }
                    }

                    if (hint) {
                        // Make sure we don't collect the full HTTP data in hints either.
                        delete hint.request;
                        delete hint.response;
                    }
                }
                return breadcrumb;
            },
            beforeSend(event, hint) {
                if (event.message) {
                    event.message = simplifyErrorMessages(event.message);
                }

                if (event.exception && event.exception.values) {
                    event.exception.values.forEach((value) => {
                        if (!value.value) return;
                        value.value = simplifyErrorMessages(value.value);
                    });
                }

                return event;
            }
        });

        Sentry.configureScope((scope) => {
            scope.setTag('platform', process.platform);
        });

        Sentry.configureScope((scope) => {
            // We use a random id to distinguish between many errors in one session vs
            // one error in many sessions. This isn't persisted and can't be used to
            // identify anybody between sessions.
            const randomId = randomUUID();
            scope.setUser({ id: randomId, username: `anon-${randomId}` });
        });

        // Include breadcrumbs for subprocess spawning, to trace interceptor startup details:
        const rawSpawn = child_process.spawn;
        (child_process as any).spawn = function (command: any, args?: any, options?: { [key: string]: string }) {
            const sanitizedOptions = { ...options,
                env: Object.entries((options && options.env) || {})
                    .map(([key, value]) => {
                        // Remove all actual env values from this reporting; only included our changed values.
                        const realValue = process.env[key];
                        if (value === realValue) return undefined;
                        else if (realValue) return [key, value.replace(realValue, '[...]')];
                        else return [key, value];
                    })
                    .filter((entry) => entry !== undefined)
            };

            addBreadcrumb('Spawning process', { data: { command, args, options: sanitizedOptions } });
            return rawSpawn.apply(this, arguments as any);
        };

        sentryInitialized = true;
    }
}

const simplifyErrorMessages = (input: string): string =>
    input
    // Strip any usernames that end up appearing within error values.
    // This helps to dedupe error reports, and it's good for privacy too
    .replace(/\/home\/[^\/]+\//g, '/home/<username>/')
    .replace(/\/Users\/[^\/]+\//g, '/Users/<username>/')
    .replace(/(\w):\\Users\\[^\\]+\\/gi, '$1:\\Users\\<username>\\')
    // Dedupe temp filenames in errors (from terminal script setup)
    .replace(/([a-zA-Z]+)\d{12,}\.temp/g, '$1<number>.temp');

export function addBreadcrumb(message: string, data: Sentry.Breadcrumb) {
    Sentry.addBreadcrumb(Object.assign({ message }, data));
}

export function logError(error: Error | string | unknown): undefined | Promise<void> {
    console.warn(error);
    if (!sentryInitialized) return;

    if (typeof error === 'string') {
        Sentry.captureMessage(error);
    } else {
        Sentry.captureException(error);
    }

    return Sentry.flush(500).then((sentSuccessfully) => {
        if (sentSuccessfully === false) console.log('Error reporting timed out');
    });
}