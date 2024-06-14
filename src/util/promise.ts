import { CustomError, delay } from '@httptoolkit/util';

export async function waitUntil<T extends unknown>(
    delayMs: number,
    tries: number,
    test: () => Promise<T>
): Promise<Exclude<T, false>> {
    let result = tries > 0 && await test()

    while (tries > 0 && !result) {
        tries = tries - 1;
        await delay(delayMs);
        result = await test();
    }

    if (!result) {
        throw new CustomError(`Wait loop failed after ${tries} retries`, {
            code: 'wait-loop-failed'
        });
    }
    else return result as Exclude<T, false>;
}

export class TimeoutError extends CustomError {
    constructor() {
        super('Timeout', { code: 'timeout' });
    }
}

export async function withTimeout<T>(
    timeoutMs: number,
    promise: Promise<T>
) {
    return Promise.race([
        promise,
        delay(timeoutMs, { unref: true })
            .then(() => { throw new TimeoutError(); })
    ]);
}