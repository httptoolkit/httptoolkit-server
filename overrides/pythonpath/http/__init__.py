# This module _must_ trigger the import for http.client. We need to ensure we preload
# the real http module (or import http & import http.server don't work properly), but
# if we do that before importing the client, the client can never be intercepted.

# There might be a cleaner alternative, but for now we just aggressively pre-intercept
# the client instead.

from . import client