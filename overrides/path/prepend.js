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

// Intercept calls to require() certain modules, to monkey-patch/wrap them.

// Primarily exists to intercept http/https, but could be used for any
// other modules in future if required.

// For HTTP/HTTPS, we inject a global agent that adds our proxy settings as
// the default for all HTTP requests. We could do this upfront, but instead
// it's deferred until the first require(), in case the user cares about
// require order (e.g. if they're mocking out the 'http' module completely).

const alreadyIntercepted = [];

// Normally false, but can be set to a list of modules to defer interception so
// we can use the required modules as part of the monkey patching process.
// E.g. global-agent requires http & https, so we would otherwise get circular
// requires that can cause problems here.
let delayedInterception = false;

const mod = require('module');
const realLoad = mod._load;

// Given a just-loaded module's name, do whatever is required to set up interception
function fixModule(name) {
    if (name === 'http' || name === 'https') {
        delayedInterception = [];

        interceptAllHttp();

        delayedInterception.forEach(function (modDetails) {
            fixModule(modDetails.name);
        });
    }
}

// Our hook into require():
mod._load = function (name) {
    const loadedModule = realLoad.apply(this, arguments);

    // Should always be set, but check just in case. This also allows users to disable
    // interception explicitly, if need be.
    if (!process.env.HTTP_TOOLKIT_ACTIVE) return loadedModule;

    // Don't mess with modules if we've seen them before
    if (alreadyIntercepted.indexOf(name) >= 0) return loadedModule;
    else alreadyIntercepted.push(name);

    if (delayedInterception !== false) {
        delayedInterception.push({ name: name, loadedModule: loadedModule });
    } else {
        fixModule(name);
    }

    return loadedModule;
};