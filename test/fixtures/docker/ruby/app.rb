require 'net/http'

target_uri = URI(ARGV[0])

puts 'Starting Ruby container'

while true do
    begin
        res = Net::HTTP.get_response(target_uri)
        puts "Got #{res.code} response"
    rescue => e
        STDERR.puts "Error: #{e.message}"
    end
    sleep(0.25)
end