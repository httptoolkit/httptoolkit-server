from httptoolkit_intercept import preload_real_module

preload_real_module('httplib2')

import httplib2, os, functools

# Re-export all public fields
from httplib2 import *
# Load a few extra notable private fields, for max compatibility
from httplib2 import __file__, __doc__

_certPath = os.environ['SSL_CERT_FILE']

# Ensure all connections trust our cert:
_http_init = httplib2.Http.__init__
@functools.wraps(_http_init)
def _new_http_init(self, *k, **kw):
    kList = list(k)
    if len(kList) > 3:
        kList[3] = _certPath
    else:
        kw['ca_certs'] = _certPath
    _http_init(self, *kList, **kw)
httplib2.Http.__init__ = _new_http_init