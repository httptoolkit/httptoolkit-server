HTTP Toolkit Server [![Travis Build Status](https://img.shields.io/travis/httptoolkit/httptoolkit-server.svg)](https://travis-ci.org/httptoolkit/httptoolkit-server) [![Version](https://img.shields.io/npm/v/httptoolkit-server.svg)](https://npmjs.org/package/httptoolkit-server)
===================

The non-browser part of [HTTP Toolkit](https://httptoolkit.tech/).

This server is runnable standalone as a CLI, or importable into other modules to be run programmatically.

When run it:

* Configures & runs a standalone [Mockttp](https://npmjs.com/package/mockttp) server, to proxy traffic.
* Starts a HTTP toolkit server, which provides various httptoolkit features that live outside the browser, including:
  * Reading & changing the Mockttp server configuration
  * Querying, starting & stopping traffic interceptors on the local machine/network.
