/*
    --require'd by node before loading any other modules.
    This file sets up a global agent for both the http
    and https modules, so they pick up the proxy from
    the environment.

    Tested against Node 6, 8, 10 and 12.
*/

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

// Grab the built-in module loader that we're going to intercept
const mod = require('module');
const realLoad = mod._load;

// Intercept calls to require() certain modules, to monkey-patch/wrap them.

// Primarily exists to intercept http/https, but could be used for any
// other modules in future if required.

// For HTTP/HTTPS, we inject a global agent that adds our proxy settings as
// the default for all HTTP requests. We could do this upfront, but instead
// it's deferred until the first require(), in case the user cares about
// require order (e.g. if they're mocking out the 'http' module completely).

// Normally false, but can be set to a list of modules to defer interception so
// we can use the required modules as part of the monkey patching process.
// E.g. global-agent requires http & https, so we would otherwise get circular
// requires that can cause problems here.
let delayedInterception = false;

// Given a just-loaded module's name, do whatever is required to set up interception
// This must return the resulting module, but due to delayed interception, that isn't
// used if it's hit in a circular require. Works for now, but needs careful thought.
// All fixes must be idempotent (must not cause problems if run repeatedly).
function fixModule(requestedName, filename, loadedModule) {
    let fixedModule = loadedModule;

    if (requestedName === 'http' || requestedName === 'https') {
        delayedInterception = [];

        interceptAllHttp();

        delayedInterception.forEach(function (modDetails) {
            fixModule(modDetails.requestedName, modDetails.filename, modDetails.loadedModule);
        });
        delayedInterception = false;
    } else if (requestedName === 'axios') {
        // Disable built-in proxy support, to let global-agent/tunnel take precedence
        // Supported back to the very first release of Axios
        fixedModule.defaults.proxy = false;
    } else if (
        requestedName === 'request' &&
        loadedModule.defaults && // Request >= 2.17 (before that, proxy support isn't a problem anyway)
        !loadedModule.INTERCEPTED_BY_HTTPTOOLKIT // Make this idempotent
    ) {
        // Disable built-in proxy support, to let global-agent/tunnel take precedence
        fixedModule = loadedModule.defaults({ proxy: false });
        fixedModule.INTERCEPTED_BY_HTTPTOOLKIT = true;
    } else if (
        requestedName === 'superagent' &&
        !global.GLOBAL_AGENT && // Works automatically with global-agent
        !loadedModule.INTERCEPTED_BY_HTTPTOOLKIT // Make this idempotent
    ) {
        loadedModule.INTERCEPTED_BY_HTTPTOOLKIT = true;

        // Global tunnel doesn't successfully reconfigure superagent.
        // To fix it, we forcibly override the agent property on every request.
        const originalRequestMethod = loadedModule.Request.prototype.request;
        fixedModule.Request.prototype.request = function () {
            if (this.url.indexOf('https:') === 0) {
                this._agent = require('https').globalAgent;
            } else {
                this._agent = require('http').globalAgent;
            }
            return originalRequestMethod.apply(this, arguments);
        };
    } else if (requestedName === 'stripe' && !loadedModule.INTERCEPTED_BY_HTTPTOOLKIT) {
        fixedModule = Object.assign(function () {
            const result = loadedModule.apply(this, arguments);

            if (global.GLOBAL_AGENT) {
                // Set by global-agent in Node 10+
                result.setHttpAgent(global.GLOBAL_AGENT.HTTPS_PROXY_AGENT);
            } else {
                // Set by global-tunnel in Node < 10 (or global-agent in 11.7+)
                result.setHttpAgent(require('https').globalAgent);
            }

            return result;
        }, fixedModule);
        fixedModule.INTERCEPTED_BY_HTTPTOOLKIT = true;
    }

    // Very carefully overwrite node's built-in module cache:
    if (fixedModule !== loadedModule && mod._cache[filename] && mod._cache[filename].exports) {
        mod._cache[filename].exports = fixedModule;
    }

    return fixedModule;
}

// Our hook into require():
mod._load = function (requestedName, parent, isMain) {
    const filename = mod._resolveFilename(requestedName, parent, isMain);
    let loadedModule = realLoad.apply(this, arguments);

    // Should always be set, but check just in case. This also allows users to disable
    // interception explicitly, if need be.
    if (!process.env.HTTP_TOOLKIT_ACTIVE) return loadedModule;

    if (delayedInterception !== false) {
        delayedInterception.push({
            requestedName: requestedName,
            filename: filename,
            loadedModule: loadedModule
        });
    } else {
        loadedModule = fixModule(requestedName, filename, loadedModule);
    }

    return loadedModule;
};