from httptoolkit_intercept import preload_real_module
preload_real_module('stripe')

import stripe, os
stripe.ca_bundle_path = os.environ['SSL_CERT_FILE']

# Re-export all public fields from Stripe
from stripe import *
# Load a few extra notable private fields, for max compatibility
from stripe import __path__, __file__, __doc__