import sys
import time
import requests

targetUrl = sys.argv[1]

print('Starting Python container')
while True:
    try:
        resp = requests.get(targetUrl)
        print('Got {0} response'.format(resp.status_code))
    except Exception as e:
        print('Error: {0}'.format(e), file=sys.stderr)
    time.sleep(0.25)