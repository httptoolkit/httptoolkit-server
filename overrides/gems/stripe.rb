# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path(__dir__)
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Load stripe, and inject our certificate
require 'stripe'
Stripe.ca_bundle_path=ENV['SSL_CERT_FILE']

# Put this override directory back on LOAD_PATH
$LOAD_PATH.unshift(gem_override_path)