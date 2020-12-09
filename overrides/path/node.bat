@echo off
SETLOCAL

REM Exclude ourselves from PATH within this script, to avoid recursing
set ORIGINALPATH=%PATH%
REM Get the current file's folder
set THIS_PATH=%~dp0
REM Strip the trailing slash from the folder
set WRAPPER_FOLDER=%THIS_PATH:~0,-1%
REM Remove that folder from PATH
call set PATH=%%PATH:%WRAPPER_FOLDER%;=%%

REM Get the real node path, store it in %REAL_NODE%
FOR /F "tokens=*" %%g IN ('where node') do (SET REAL_NODE=%%g)

REM Reset PATH, so its visible to node & subprocesses
set PATH=%ORIGINALPATH%

REM Start Node for real, with an extra arg to inject our logic
"%REAL_NODE%" -r "%WRAPPER_FOLDER%\..\js\prepend-node.js" %*