# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path('..', __dir__) # parent dir, we're a subfolder
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Override net/http, the built-in HTTP module to inject our cert
# This isn't necessary with OpenSSL (doesn't hurt), but LibreSSL ignores
# the SSL_CERT_FILE setting, so we need to be more explicit:
require 'net/http'
module Net
    module HTTPHttpToolkitExtensions
        def ca_file=(path)
            # If you try to use a certificate, use ours instead
            super(ENV['SSL_CERT_FILE'])
        end

        def cert_store=(store)
            # If you try to use a whole store of certs, use ours instead
            self.ca_file = ENV['SSL_CERT_FILE']
        end

        def use_ssl=(val)
            # If you try to use SSL, make sure you trust our cert first
            self.ca_file = ENV['SSL_CERT_FILE']
            super(val)
        end
    end

    class HTTP
        prepend HTTPHttpToolkitExtensions
    end
end

# Put this override directory back on LOAD_PATH
$LOAD_PATH.unshift(gem_override_path)