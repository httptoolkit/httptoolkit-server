#!/bin/bash

set -e

ls -la *

tar -xvzf ./distributables/v*/httptoolkit-server-*-$1-x64.tar.gz

./httptoolkit-server/bin/httptoolkit-server start &
SERVER_PID=$!

sleep 5

# CSRF protection fully blocks unrecognized/missing origin requests:
WITH_ORIGIN="-HOrigin: https://app.httptoolkit.tech"
AS_JSON="-HContent-Type: application/json"

# Can start a Mockttp server:
curl "$WITH_ORIGIN" "$AS_JSON" -v --fail 'http://127.0.0.1:45456/start?port=\{"startPort":8000,"endPort":65535\}' -d '{}'

# Can query the API server version:
curl "$WITH_ORIGIN" "$AS_JSON" -v --fail http://127.0.0.1:45457/ -d '{"query": "query getVersion { version }"}'

# Can get config
curl "$WITH_ORIGIN" "$AS_JSON" -v --fail http://127.0.0.1:45457/ -d '{"query": "query getConfig { config { certificateContent certificatePath certificateFingerprint } }"}'

# Can query interceptors
curl "$WITH_ORIGIN" "$AS_JSON" -v --fail http://127.0.0.1:45457/ -d '{"query": "query getInterceptors { interceptors { id version, metadata isActivable isActive(proxyPort: 8000) } }"}'

# ^ This will fail if they receive anything but a 200 result.
# This ensures that the server is startable, and has minimal functionality for launch.