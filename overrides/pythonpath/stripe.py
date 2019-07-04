try:
    import importlib
    if not hasattr(importlib, 'reload'):
        raise Exception('wrong importlib')
except:
    import imp
    importlib = imp

def _load_real_stripe():
    # Importing this at the top level breaks after deleting sys.modules['stripe'],
    # in Python 2. Some interesting internal issues there, but this works in Py 2 & 3.
    import sys, os

    override_path = os.path.dirname(os.path.abspath(__file__))

    original_sys_path = list(sys.path)

    sys.path = [p for p in sys.path if p != override_path]
    del sys.modules['stripe']
    import stripe

    sys.path = original_sys_path

_load_real_stripe()

import stripe, os
stripe.ca_bundle_path = os.environ['SSL_CERT_FILE']

# Re-export all public fields from Stripe
from stripe import *
# Load a few extra notable private fields, for max compatibility
from stripe import __path__, __file__, __doc__