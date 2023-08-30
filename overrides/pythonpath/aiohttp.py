from httptoolkit_intercept import preload_real_module
preload_real_module('aiohttp')

import functools, aiohttp

# Re-export all public fields, and a few notable private fields for max compatibility:
from aiohttp import *
from aiohttp import __path__, __file__, __doc__

# Forcibly enable environment trust for all sessions:
_session_init = aiohttp.ClientSession.__init__
@functools.wraps(_session_init)
def _new_client_session_init(self, *k, **kw):
    _session_init(self,*k, **dict(kw, trust_env=True))
aiohttp.ClientSession.__init__ = _new_client_session_init