@echo off
SETLOCAL

REM Exclude ourselves from PATH within this script, to avoid recursing
set ORIGINALPATH=%PATH%
set WRAPPER_FOLDER=%HTTP_TOOLKIT_OVERRIDE_PATH%\path
call set PATH=%%PATH:%WRAPPER_FOLDER%;=%%

REM Get the real node path, store it in %REAL_NODE%
FOR /F "tokens=*" %%g IN ('where node') do (SET REAL_NODE=%%g)

REM Reset PATH, so its visible to node & subprocesses
set PATH=%ORIGINALPATH%

REM Start Node for real, with an extra arg to inject our logic
"%REAL_NODE%" %*