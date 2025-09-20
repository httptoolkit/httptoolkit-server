@echo off
SETLOCAL

REM Exclude ourselves from PATH within this script, to avoid recursing
set ORIGINALPATH=%PATH%
set WRAPPER_FOLDER=%HTTP_TOOLKIT_OVERRIDE_PATH%\path
call set PATH=%%PATH:%WRAPPER_FOLDER%;=%%

REM Get the real php path, store it in %REAL_PHP%
FOR /F "tokens=*" %%g IN ('where php') do (SET REAL_PHP=%%g)

REM Reset PATH, so its visible to php & subprocesses
set PATH=%ORIGINALPATH%

REM Reset PHP_INI_SCAN_DIR, removing our override path
call set PHP_INI_SCAN_DIR=%%PHP_INI_SCAN_DIR:%HTTP_TOOLKIT_OVERRIDE_PATH%\php;=%%
call set PHP_INI_SCAN_DIR=%%PHP_INI_SCAN_DIR:%HTTP_TOOLKIT_OVERRIDE_PATH%\php=%%

REM Start PHP for real, with extra args to override certain configs
"%REAL_PHP%" -d "openssl.cafile=%SSL_CERT_FILE%" -d "curl.cainfo=%SSL_CERT_FILE%" -d "auto_prepend_file=%WRAPPER_FOLDER%\..\php\prepend.php" %*