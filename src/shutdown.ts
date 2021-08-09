import { reportError } from './error-tracking';
import { delay } from './util/promise';

type ShutdownHandler = () => Promise<unknown>;
const shutdownHandlers: Array<ShutdownHandler> = [];

export function registerShutdownHandler() {
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

export function addShutdownHandler(handler: ShutdownHandler) {
    shutdownHandlers.push(handler);
}

async function shutdown() {
    console.log('Shutting down...');

    const shutdownPromises = Promise.all(shutdownHandlers.map(
        async (handler) => {
            try {
                await handler();
            } catch (e) {
                reportError(e);
            }
        }
    ));

    await Promise.race([
        shutdownPromises,
        delay(2000) // After 2 seconds, we just close anyway, we're done.
    ]);

    process.exit(0);
}

