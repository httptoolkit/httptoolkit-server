<?php
    stream_context_set_default(
        array(
            'http' => array('proxy' => str_replace('http://', '', getenv('HTTPS_PROXY')))
        )
    );

    // We've overridden php.ini to ensure this runs. We should go back to
    // php.ini, check if there was a previous value, and ensure that
    // gets run as well, to make sure we don't break anything.
    $phpIniLocation = php_ini_loaded_file();
    if ($phpIniLocation) {
        $phpIniContents = parse_ini_file($phpIniLocation);
        if ($phpIniContents['auto_prepend_file']) {
            require($phpIniContents['auto_prepend_file']);
        }
    }
?>