# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path(__dir__)
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Load http.rb, and inject our proxy settings as the default for all requests
require 'http'
module HTTP
    module RequestHttpToolkitExtensions
        def initialize(opts)
            if not opts[:proxy] or opts[:proxy].keys.size < 2
                proxy_from_env = URI(opts.fetch(:uri).to_s).find_proxy
                opts[:proxy] = {
                    proxy_address: proxy_from_env.host,
                    proxy_port: proxy_from_env.port
                }
            end
            super(opts)
        end
    end

    class Request
        prepend RequestHttpToolkitExtensions
    end
end

# Put this override directory back on LOAD_PATH
$LOAD_PATH.unshift(gem_override_path)