from httptoolkit_intercept import preload_real_module

preload_real_module('httplib')

import httplib, os, functools

# Re-export all public fields
from httplib import *
# Load a few extra notable private fields, for max compatibility
from httplib import __file__, __doc__

_httpProxy = os.environ['HTTP_PROXY']
[_proxyHost, _proxyPort] = _httpProxy.split('://')[1].split(':')
_certPath = os.environ['SSL_CERT_FILE']

# Redirect and then tunnel all plain HTTP connections:
_http_connection_init = HTTPConnection.__init__
@functools.wraps(_http_connection_init)
def _new_http_connection_init(self, host, port=None, *k, **kw):
    _http_connection_init(self, _proxyHost, _proxyPort, *k, **kw)
    self.set_tunnel(host, port)
HTTPConnection.__init__ = _new_http_connection_init

def _build_default_context():
    import ssl
    context = ssl.SSLContext(ssl.PROTOCOL_SSLv23)
    context.options |= ssl.OP_NO_SSLv2
    context.options |= ssl.OP_NO_SSLv3
    return context

# Redirect & tunnel HTTPS connections, and inject our CA certificate:
_https_connection_init = HTTPSConnection.__init__
@functools.wraps(_https_connection_init)
def _new_https_connection_init(self, host, port=None, *k, **kw):
    context = None
    if 'context' in kw:
        context = kw.get('context')
    elif len(k) > 7:
        context = k[7]

    if context == None:
        context = kw['context'] = _build_default_context()

    context.load_verify_locations(_certPath)

    _https_connection_init(self, _proxyHost, _proxyPort, *k, **kw)
    self.set_tunnel(host, port)
HTTPSConnection.__init__ = _new_https_connection_init