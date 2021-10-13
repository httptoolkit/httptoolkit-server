export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

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

    if (!result) throw new Error(`Wait loop failed`);
    else return result as Exclude<T, false>;
}

export interface Deferred<T> {
    resolve: (arg: T) => void,
    reject: (e?: Error) => void,
    promise: Promise<T>
}

export function getDeferred<T = void>(): Deferred<T> {
    let resolve: undefined | ((arg: T) => void) = undefined;
    let reject: undefined | ((e?: Error) => void) = undefined;

    let promise = new Promise<T>((resolveCb, rejectCb) => {
        resolve = resolveCb;
        reject = rejectCb;
    });

    // TS thinks we're using these before they're assigned, which is why
    // we need the undefined types, and the any here.
    return { resolve, reject, promise } as any;
}