/**
 * --require'd by node before loading any other modules. The --require
 * option is injected both using NODE_OPTIONS and with a node wrapper in
 * PATH to handle various potential cases (node dedupes --require anyway).
 *
 * This file sets up a global agent for the http & https modules,
 * plus tweaks various other HTTP clients that need nudges, so they
 * all correctly pick up the proxy from the environment.
 *
 * Tested against Node 6, 8, 10, 12 and 14.
*/

const wrapModule = require('./wrap-require');

let httpAlreadyIntercepted = false;

function interceptAllHttp() {
    if (httpAlreadyIntercepted) return;
    httpAlreadyIntercepted = true;

    const MAJOR_NODEJS_VERSION = parseInt(process.version.slice(1).split('.')[0], 10);

    if (MAJOR_NODEJS_VERSION >= 10) {
        // `global-agent` works with Node.js v10 and above.
        const globalAgent = require('global-agent');
        globalAgent.bootstrap();
    } else {
        // `global-tunnel-ng` works only with Node.js v10 and below.
        const globalTunnel = require('global-tunnel-ng');
        globalTunnel.initialize();
    }
}

wrapModule('http', interceptAllHttp, true);
wrapModule('https', interceptAllHttp, true);

wrapModule('axios', function wrapAxios (loadedModule) {
    // Global agent handles this automatically, if used (i.e. Node >= 10)
    if (global.GLOBAL_AGENT) return;

    // Disable built-in proxy support, to let global-tunnel take precedence
    // Supported back to the very first release of Axios
    loadedModule.defaults.proxy = false;
});

wrapModule('request', function wrapRequest (loadedModule) {
    // Global agent handles this automatically, if used (i.e. Node >= 10)
    if (global.GLOBAL_AGENT) return;

    // Is this Request >= 2.17?
    // Before then proxy support isn't a problem anyway
    if (!loadedModule.defaults) return;

    // Have we intercepted this already?
    if (loadedModule.INTERCEPTED_BY_HTTPTOOLKIT) return;

    const fixedModule = loadedModule.defaults({ proxy: false });
    fixedModule.INTERCEPTED_BY_HTTPTOOLKIT = true;
    return fixedModule;
});

wrapModule('superagent', function wrapSuperagent (loadedModule) {
    // Global agent handles this automatically, if used (i.e. Node >= 10)
    if (global.GLOBAL_AGENT) return;

    // Have we intercepted this already?
    if (loadedModule.INTERCEPTED_BY_HTTPTOOLKIT) return;
    loadedModule.INTERCEPTED_BY_HTTPTOOLKIT = true;

    // Global tunnel doesn't successfully reconfigure superagent.
    // To fix it, we forcibly override the agent property on every request.
    const originalRequestMethod = loadedModule.Request.prototype.request;
    loadedModule.Request.prototype.request = function () {
        if (this.url.indexOf('https:') === 0) {
            this._agent = require('https').globalAgent;
        } else {
            this._agent = require('http').globalAgent;
        }
        return originalRequestMethod.apply(this, arguments);
    };
});

wrapModule('undici', function wrapUndici (loadedModule) {
    const ProxyAgent = loadedModule.ProxyAgent;
    const setGlobalDispatcher = loadedModule.setGlobalDispatcher;

    // Old Undici release, which can't be intercepted:
    if (!ProxyAgent || !setGlobalDispatcher) return;

    setGlobalDispatcher(
        new ProxyAgent(process.env.HTTP_PROXY)
    );
});

wrapModule('stripe', function wrapStripe (loadedModule) {
    if (loadedModule.INTERCEPTED_BY_HTTPTOOLKIT) return;

    return Object.assign(
        function () {
            const result = loadedModule.apply(this, arguments);

            // Set by global-tunnel in Node < 10 (or global-agent in 11.7+)
            result.setHttpAgent(require('https').globalAgent);
            return result;
        },
        loadedModule,
        { INTERCEPTED_BY_HTTPTOOLKIT: true }
    );
});