http-toolkit-server
===================

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/http-toolkit-server.svg)](https://npmjs.org/package/http-toolkit-server)
[![Downloads/week](https://img.shields.io/npm/dw/http-toolkit-server.svg)](https://npmjs.org/package/http-toolkit-server)
[![License](https://img.shields.io/npm/l/http-toolkit-server.svg)](https://github.com/pimterry/http-toolkit-server/blob/master/package.json)

The non-browser part of [HTTP Toolkit](https://httptoolkit.tech/).

This server is runnable standalone as a CLI, or importable into other modules to be run programmatically.

When run it:

* Configures & runs a standalone [Mockttp](https://npmjs.com/package/mockttp) server, to proxy traffic.
* Starts a HTTP toolkit server, which provides various http-toolkit features that live outside the browser, including:
  * Reading & changing the Mockttp server configuration
  * Querying, starting & stopping traffic interceptors on the local machine/network.
