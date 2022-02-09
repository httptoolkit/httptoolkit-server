@echo off

REM Extract the tarball. Tar doesn't support wildcards on windows, DIR only supports one wildcard, so we have to do this mess:
cd distributables
set GET_TAR="dir /b httptoolkit-server-*-win32-x64.tar.gz"
FOR /F "tokens=*" %%i IN (' %GET_TAR% ') DO SET TAR_PATH=%%i

tar -xvzf %TAR_PATH%

echo Starting server...

START "server" .\httptoolkit-server\bin\httptoolkit-server start

REM The closest we can get to a 10 second delay on Windows in CI, ick:
ping -n 10 127.0.0.1 >NUL

echo Testing server...

REM CSRF protection fully blocks unrecognized/missing origin requests:
set WITH_ORIGIN="-HOrigin: https://app.httptoolkit.tech"
set AS_JSON="-HContent-Type: application/json"

REM Can start a Mockttp server:
curl %WITH_ORIGIN% %AS_JSON% -v --fail -X POST "http://127.0.0.1:45456/start?port=\{\"startPort\":8000,\"endPort\":65535\}" || goto :error

REM Can query the API server version:
curl %WITH_ORIGIN% %AS_JSON% -v --fail http://127.0.0.1:45457/ -d "{\"query\": \"query getVersion { version }\"}" || goto :error

REM Can get config
curl %WITH_ORIGIN% %AS_JSON% -v --fail http://127.0.0.1:45457/ -d "{\"query\": \"query getConfig { config { certificateContent certificatePath certificateFingerprint } }\"}" || goto :error

REM Can query interceptors
curl %WITH_ORIGIN% %AS_JSON% -v --fail http://127.0.0.1:45457/ -d "{\"query\": \"query getInterceptors { interceptors { id version, metadata isActivable isActive(proxyPort: 8000) } }\"}" || goto :error

REM Can trigger update (can't test that it actually updates, unfortunately)
curl %WITH_ORIGIN% %AS_JSON% -v --fail http://127.0.0.1:45457/ -d "{\"query\": \"mutation TriggerUpdate { triggerUpdate }\"}" || goto :error

REM ^ This will fail if they receive anything but a 200 result.
REM This ensures that the server is startable, and has minimal functionality for launch.

goto :success

:error
set err=%errorlevel%

taskkill /FI "WindowTitle eq server*" /T /F
echo Test failed with error #%err%.
exit /b %err%

:success
echo All good.

REM Shut down by matching title passed to START to run in the background
taskkill /FI "WindowTitle eq server*" /T /F || goto :success