require 'net/http'

target_uri = URI(ARGV[0])

puts 'Starting Ruby container'

while true do
    res = Net::HTTP.get_response(target_uri)
    puts "Got #{res.code} response"
    sleep(0.5)
end