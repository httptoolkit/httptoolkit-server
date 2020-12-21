#!/bin/bash
trap : SIGTERM SIGINT

# We need to inject a --no-sandbox option, because inside Docker Chrome cannot start its
# sandbox, and without this it refuses to start at all.
/usr/bin/google-chrome --no-sandbox "$@" &
CHROME_PID=$!

wait $CHROME_PID

WAIT_EXIT_CODE=$?

# If this script gets killed, kill Chrome with the same signal
if [[ WAIT_EXIT_CODE -gt 128 ]]
then
    kill -$(($WAIT_EXIT_CODE - 128)) $CHROME_PID
fi