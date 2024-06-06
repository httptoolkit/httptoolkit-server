import { delay } from '@httptoolkit/util';

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
