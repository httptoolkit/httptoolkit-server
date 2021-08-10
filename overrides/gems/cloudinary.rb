# Remove this module from LOAD_PATH, so we can load the real one
gem_override_path = File.expand_path(__dir__)
$LOAD_PATH.reject! { |path| File.expand_path(path) == gem_override_path }

# Load the real module, and inject our settings
require 'cloudinary'
Cloudinary::config.api_proxy = ENV['HTTP_PROXY']

# Put this override directory back on LOAD_PATH
$LOAD_PATH.unshift(gem_override_path)