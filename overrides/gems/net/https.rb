# require 'net/https' is not necessary in modern ruby, as net/http
# can handle HTTPS all by itself. That said, it's still used in
# places, and its use of require_relative to load 'http' means that
# it avoids our net/http hook.

# When using standard OpenSSL that's not a big problem, because
# we also set SSL_CERT_FILE, which ensures we trust the certificate.
# In some environments though (default Mac Ruby installs) that
# variable is ignored, and so the net/http hook is *necessary*.

# All this file does is import our hooked HTTP version, before
# running the real module as normal, to guarantee the hook is
# always in place in every case.

require_relative 'http'

# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path('..', __dir__) # parent dir, we're a subfolder
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Load the real net/https module as normal
require 'net/https'

# Put this override directory back on LOAD_PATH again
$LOAD_PATH.unshift(gem_override_path)