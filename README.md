HTTP Toolkit Server [![Build Status](https://github.com/httptoolkit/httptoolkit-server/workflows/CI/badge.svg)](https://github.com/httptoolkit/httptoolkit-server/actions) [![Version](https://img.shields.io/npm/v/httptoolkit-server.svg)](https://npmjs.org/package/httptoolkit-server)
===================

This repo contains the backend for [HTTP Toolkit](https://httptoolkit.tech), a beautiful, cross-platform & open-source HTTP(S) debugging proxy, analyzer & client.

Looking to file bugs, request features or send feedback? File an issue or vote on existing ones at [github.com/httptoolkit/httptoolkit](https://github.com/httptoolkit/httptoolkit).

## What is this?

HTTP Toolkit runs everything possible within [the web UI](https://github.com/httptoolkit/httptoolkit-ui), written as a standard single-page web application. There's a couple of necessary things you can't do in a web application though, especially:

* Start a locally running proxy server (here using [Mockttp](https://npmjs.com/package/mockttp))
* Launch local applications preconfigured for interception

This server exposes an API that is used by the web UI, exposing these actions and some other related information - see [`src/api/rest-api.ts`](src/api/rest-server.ts) for the full API details.

This server is runnable standalone as a CLI using [oclif](http://oclif.io), or can be imported into other modules to be run programmatically. The available interceptors are defined in [`src/interceptors`](src/interceptors), and some of these also use other services in here, e.g. [`src/cert-check-server.ts`](src/cert-check-server.ts) automatically checks if a certificate is trusted by a browser client, and downloads or installs (depending on the client) the certificate if not.

Note that the set of interceptors available in HTTP Toolkit depends on both the interceptors available on your server and the interceptors defined in the UI - new interceptors will need to be added to both.

This server is typically used by users via [httptoolkit-desktop](https://github.com/httptoolkit/httptoolkit-desktop), which builds the server and web UI into an electron application, and starts & stops the server in the background whenever that app is run. Each time the desktop app is built, a new electron app is created containing the latest release from this repo.

Once the server has installed it automatically updates in the background periodically, pulling new releases from the github releases of this repo.

## Contributing

If you want to add new interceptors, change/fix existing interceptor behaviour (but not their UI) or reconfigure how the underlying proxy server is set up, then you're in the right place :+1:.

To get started:

* Clone this repo.
* `npm install`
* `npm start`
* A [Mockttp](https://npmjs.com/package/mockttp) standalone server will start on port 45456, and a graphql management server on 45457.
* Either make requests to the servers by hand, use the production UI by opening `https://app.httptoolkit.tech` in a Chromium-based browser, or start and use a local UI by:
    * Setting up the web UI locally (see [httptoolkit/httptoolkit-ui#contributing](https://github.com/httptoolkit/httptoolkit-ui#contributing)).
    * Running `npm run start:web` there to start the UI without its own server.
    * Opening `http://local.httptoolkit.tech:8080` in a Chromium-based browser

A few things to be aware of:

* If you're looking to add a new interceptor, those also need to be registered in `src/interceptors/index.ts`, and will also need to be added to [the UI](https://github.com/httptoolkit/httptoolkit-ui) to make that available.
* Tests (both unit & integration) can be run with `npm test`, or `npm run test:unit`/`npm run test:integration` to run just the unit/integration tests.
* Note that the integration tests assume the required applications are installed and some docker images are already pulled. See [ci.yml](.github/workflows/ci.yml) and the [build-base](https://github.com/httptoolkit/act-build-base/) image for an example of how to set this up (or just run the tests, look at the errors, and install whatever's missing).
* If running the server in serious use (self-hosting, or long-term ongoing development) you probably want to set a `HTK_SERVER_TOKEN` env var with a random key, and pass this similarly to the UI as an `authToken=<token>` URL parameter. This is useful because the API is very powerful (it can launch arbitrary applications on your machine). The API only listens on localhost and blocks CORS requests, so strictly speaking this shouldn't be necessary, but it is useful as a stronger guarantee & defense in depth. This is handled automatically in the production desktop app.