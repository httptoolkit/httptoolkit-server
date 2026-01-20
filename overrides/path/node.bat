@echo off
SETLOCAL

REM Exclude ourselves from PATH within this script, to avoid recursing
set ORIGINALPATH=%PATH%
set WRAPPER_FOLDER=%HTTP_TOOLKIT_OVERRIDE_PATH%\path
call set PATH=%%PATH:%WRAPPER_FOLDER%;=%%

REM Get the real node path, store it in %REAL_NODE%
FOR /F "tokens=*" %%g IN ('where node') do (
    SET REAL_NODE=%%g
    GOTO :Break
)
:Break

REM Reset PATH, so its visible to node & subprocesses
set PATH=%ORIGINALPATH%

REM Check if our config is already inside NODE_OPTIONS, if so then we don't actually
REM need to do anything.
REM NODE_OPTIONS includes forward slash paths even on Windows for some reason, so
REM check for that instead.
set "OVERRIDE_PATH_POSIX=%HTTP_TOOLKIT_OVERRIDE_PATH:\=/%"
echo "%NODE_OPTIONS%" | findstr /C:"%OVERRIDE_PATH_POSIX%" >nul 2>&1
if %errorlevel% equ 0 (
    "%REAL_NODE%" %*
) else (
    "%REAL_NODE%" --require "%WRAPPER_FOLDER%\..\js\prepend-node.js" %*
)