/**
 * Intercept calls to require() certain modules, to monkey-patch them.
 *
 * This modules intercepts all require calls. For all modules previously
 * registered via wrapModule, it runs the registered wrapper on the loaded
 * module before it is returned to the original require() call.
 */

// Grab the built-in module loader that we're going to intercept
const mod = require('module');
const realLoad = mod._load;

const wrappers = {};

// Either false, or a list (initially empty) of modules whose wrapping is being
// delayed. This is important for modules who require other modules that need
// wrapping, to avoid issues with circular requires.
let wrappingBlocked = false;

function fixModule(requestedName, filename, loadedModule) {
    const wrapper = wrappers[requestedName];

    if (wrapper) {
        wrappingBlocked = wrapper.shouldBlockWrapping ? [] : false;

        // wrap can either return a replacement, or mutate the module itself.
        const fixedModule = wrapper.wrap(loadedModule) || loadedModule;

        if (fixedModule !== loadedModule && mod._cache[filename] && mod._cache[filename].exports) {
            mod._cache[filename].exports = fixedModule;
        }

        if (wrappingBlocked) {
            wrappingBlocked.forEach(function (modDetails) {
                fixModule(modDetails.requestedName, modDetails.filename, modDetails.loadedModule);
            });
            wrappingBlocked = false;
        }

        return fixedModule;
    } else {
        return loadedModule;
    }
}

// Our hook into require():
mod._load = function (requestedName, parent, isMain) {
    const filename = mod._resolveFilename(requestedName, parent, isMain);
    let loadedModule = realLoad.apply(this, arguments);

    // Should always be set, but check just in case. This also allows
    // users to disable interception explicitly, if need be.
    if (!process.env.HTTP_TOOLKIT_ACTIVE) return loadedModule;

    if (wrappingBlocked !== false) {
        wrappingBlocked.push({
            requestedName: requestedName,
            filename: filename,
            loadedModule: loadedModule
        });
    } else {
        loadedModule = fixModule(requestedName, filename, loadedModule);
    }

    return loadedModule;
};

// Register a wrapper for a given name. If shouldBlockWrapping is set, all wrapping
// of modules require'd during the modules wrapper function will be delayed until
// after it completes.
module.exports = function wrapModule(
    requestedName,
    wrapperFunction,
    shouldBlockWrapping
) {
    wrappers[requestedName] = {
        wrap: wrapperFunction,
        shouldBlockWrapping: shouldBlockWrapping || false
    };
};