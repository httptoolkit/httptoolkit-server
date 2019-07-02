import sys, os

try:
    import importlib
    if not hasattr(importlib, 'reload'):
        raise Exception('wrong importlib')
except:
    import imp
    importlib = imp

def _load_real_stripe():
    override_path = os.path.dirname(os.path.abspath(__file__))

    original_sys_path = list(sys.path)
    sys.path = [p for p in sys.path if p != override_path]
    del sys.modules['stripe']
    import stripe
    sys.path = original_sys_path

def _inject_http_toolkit_certificate():
    import stripe
    stripe.ca_bundle_path = os.environ['SSL_CERT_FILE']

_load_real_stripe()
_inject_http_toolkit_certificate()

# Re-export all public fields from Stripe
from stripe import *
# Load a few extra notable private fields, for max compatibility
from stripe import __path__, __file__, __doc__