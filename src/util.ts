export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const IS_PROD_BUILD = !!process.env.HTTPTOOLKIT_SERVER_BINPATH;