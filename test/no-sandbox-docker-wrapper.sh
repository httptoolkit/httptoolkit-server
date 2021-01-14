#!/bin/bash
trap : SIGTERM SIGINT

# We need to inject a --no-sandbox option, because inside Docker Chrome/Electron apps
# can't start their sandbox, so without this it refuses to start at all.

# It's assumed that this is copied/linked into a file in /usr/local/bin to wrap a
# binary with the same name (e.g. google-chrome) in /usr/bin:
/usr/bin/$(basename $0) --no-sandbox "$@" &
APP_PID=$!

wait $APP_PID

WAIT_EXIT_CODE=$?

# If this script gets killed, kill the app with the same signal
if [[ WAIT_EXIT_CODE -gt 128 ]]
then
    kill -$(($WAIT_EXIT_CODE - 128)) $APP_PID
fi