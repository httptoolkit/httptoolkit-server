export function delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export const IS_PROD_BUILD = !!process.env.HTTPTOOLKIT_SERVER_BINPATH;

export const ALLOWED_ORIGINS = IS_PROD_BUILD
    ? [
        // Prod builds only allow HTTPS app.httptoolkit.tech usage. This
        // ensures that no other sites/apps can communicate with your server
        // whilst you have the app open. If they could (requires an HTTP mitm),
        // they would be able to start proxies & interceptors. It's not remote
        // execution, but it's definitely not desirable.
        /^https:\/\/app\.httptoolkit\.tech$/
    ]
    : [
        // Dev builds can use the main site, or local sites, even if those
        // use HTTP. Note that HTTP here could technically open you to the risk
        // above, but it'd require a DNS MitM too (to stop local.httptoolkit.tech
        // resolving to localhost and never hitting the network).
        /^https?:\/\/localhost(:\d+)?$/,
        /^http:\/\/local\.httptoolkit\.tech(:\d+)?$/,
        /^https:\/\/app\.httptoolkit\.tech$/
    ]