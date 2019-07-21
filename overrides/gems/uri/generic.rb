# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path('..', __dir__) # parent dir, we're a subfolder
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Load uri/generic, and inject our proxy settings as the default for all requests
require 'uri/generic'
module URI
    class Generic
        def find_proxy
            # Real code for this avoids it in various cases, if some CGI env vars
            # are set, or for 127.*.*.* requests. We want to ensure we use it always.
            URI.parse(ENV['HTTP_PROXY'])
        end
    end
end

# Put this override directory back on LOAD_PATH
$LOAD_PATH.unshift(gem_override_path)