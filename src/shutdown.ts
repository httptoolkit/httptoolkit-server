import { reportError } from './error-tracking';

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

    await Promise.all(shutdownHandlers.map(
        async (handler) => {
            try {
                handler();
            } catch (e) {
                reportError(e);
            }
        }
    ));

    process.exit(0);
}

