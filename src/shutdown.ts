import { delay } from '@httptoolkit/util';
import { logError } from './error-tracking';

type ShutdownHandler = () => Promise<unknown>;
const shutdownHandlers: Array<ShutdownHandler> = [];

export function registerShutdownHandler() {
    process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
    process.on('SIGINT', () => shutdown(0, 'SIGINT'));
}

export function addShutdownHandler(handler: ShutdownHandler) {
    shutdownHandlers.push(handler);
}

export async function shutdown(code: number, cause: string) {
    console.log(`Shutting down after ${cause}...`);

    const shutdownPromises = Promise.all(shutdownHandlers.map(
        async (handler) => {
            try {
                await handler();
            } catch (e) {
                logError(e);
            }
        }
    ));

    await Promise.race([
        shutdownPromises,
        delay(2000) // After 2 seconds, we just close anyway, we're done.
    ]);

    process.exit(code);
}

