import sys
import time
import requests

targetUrl = sys.argv[1]

print('Starting Python container')
while True:
    resp = requests.get(targetUrl)
    print('Got {0} response'.format(resp.status_code))
    time.sleep(0.5)