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

REM Create a php.ini that trusts our cert, and set the path in PHPRC so PHP uses it
FOR /F "tokens=* USEBACKQ" %%F IN (`php %WRAPPER_FOLDER%\build-php-config.php`) DO (
    SET PHPRC=%%F
)

REM Start PHP for real (but now using our tweaked config)
php %*