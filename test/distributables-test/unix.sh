#!/bin/bash

set -e

ls -la *

tar -xzf ./distributables/v*/httptoolkit-server-*-$1-x64.tar.gz

echo "\nStarting server..."

./httptoolkit-server/bin/httptoolkit-server start &
SERVER_PID=$!

echo "Waiting for server..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:45456/ >/dev/null 2>&1; then
        echo "Server is up"
        break
    fi
    sleep 1
done

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
curl $CURL_OPTIONS "$WITH_ORIGIN" http://127.0.0.1:45457/version

echo "\nCan get config?"
curl $CURL_OPTIONS "$WITH_ORIGIN" http://127.0.0.1:45457/config

echo "\nCan query interceptors?"
curl $CURL_OPTIONS "$WITH_ORIGIN" http://127.0.0.1:45457/interceptors

echo "\nCan trigger update?"
# (can't test that it actually updates, unfortunately)
curl $CURL_OPTIONS "$WITH_ORIGIN" -X POST http://127.0.0.1:45457/update

# ^ This will fail if they receive anything but a 200 result.
# This ensures that the server is startable, and has minimal functionality for launch.