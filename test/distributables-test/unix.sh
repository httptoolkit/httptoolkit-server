#!/bin/bash

set -e

ls -la *

tar -xvzf ./distributables/v*/httptoolkit-server-*-$1-x64.tar.gz

echo "\nStarting server..."

./httptoolkit-server/bin/httptoolkit-server start &
SERVER_PID=$!

sleep 5

echo "\nTesting server..."

# CSRF protection fully blocks unrecognized/missing origin requests:
CURL_OPTIONS="--silent --fail -i"
WITH_ORIGIN="-HOrigin: https://app.httptoolkit.tech"
AS_JSON="-HContent-Type: application/json"

echo "\nCan start a Mockttp server"?
# Uses the default config from the UI:
curl $CURL_OPTIONS "$WITH_ORIGIN" "$AS_JSON" 'http://127.0.0.1:45456/start' \
    --data '{"plugins":{"http":{"options":{"cors":false,"suggestChanges":false,"http2":"fallback","https":{"tlsPassthrough":[]}}},"webrtc":{}}}'

echo "\nCan query the API server version?"
curl $CURL_OPTIONS "$WITH_ORIGIN" "$AS_JSON" http://127.0.0.1:45457/ \
    --data '{"query": "query getVersion { version }"}'

echo "\nCan get config?"
curl $CURL_OPTIONS "$WITH_ORIGIN" "$AS_JSON" http://127.0.0.1:45457/ \
    --data '{"query": "query getConfig { config { certificateContent certificatePath certificateFingerprint } }"}'

echo "\nCan query interceptors?"
curl $CURL_OPTIONS "$WITH_ORIGIN" "$AS_JSON" http://127.0.0.1:45457/ \
    --data '{"query": "query getInterceptors { interceptors { id version, metadata isActivable isActive(proxyPort: 8000) } }"}'

echo "\nCan trigger update?"
# (can't test that it actually updates, unfortunately)
curl $CURL_OPTIONS "$WITH_ORIGIN" "$AS_JSON" http://127.0.0.1:45457/ \
    --data '{"query": "mutation TriggerUpdate { triggerUpdate }"}'

# ^ This will fail if they receive anything but a 200 result.
# This ensures that the server is startable, and has minimal functionality for launch.