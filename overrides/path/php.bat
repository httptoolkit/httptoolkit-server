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

REM Start PHP for real, with extra args to override certain configs
php -d "openssl.cafile=%SSL_CERT_FILE%" -d "curl.cainfo=%SSL_CERT_FILE%" -d "auto_prepend_file=%WRAPPER_FOLDER%\prepend.php" %*