import sys
is_python_2 = sys.version_info[0] < 3

def makeRequests(base_url):
    import grequests
    grequests.map([grequests.get(base_url + '/grequests')])

    import httplib2
    httplib2.Http().request(base_url + '/httplib2')

    if not is_python_2:
        import httpx, asyncio
        asyncio.run(httpx.get(base_url + '/httpx'))

    import requests
    requests.get(base_url + "/requests")

    import urlfetch
    urlfetch.fetch(base_url + '/urlfetch')

    import urllib3
    urllib3.PoolManager().request('GET', base_url + '/urllib3')

    if is_python_2:
        import urllib2
        urllib2.urlopen(base_url + '/urllib2')
    else:
        import urllib.request
        urllib.request.urlopen(base_url + '/urllib.request')

makeRequests('http://example.com/python')
makeRequests('https://example.com/python')

try:
    import stripe
    stripe.api_key = 'sk_test_hunter2'
    stripe.Charge.list()
except:
    pass

try:
    import boto3
    boto3.resource('s3').buckets.all()
except:
    pass