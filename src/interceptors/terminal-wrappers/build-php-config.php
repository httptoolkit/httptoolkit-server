<?php

/*
When run by php, this file grabs the current php.ini config,
writes a new temporary one to disk that trusts your local
HTTP Toolkit CA certificate, and then logs the path of that.

If future PHP instances are started with PHPRC=[that path],
then they'll start exactly the same way as normal, except
they'll automatically trust the certificate.
*/

// Like the built-in parse_ini_file, but handles duplicate keys
// correctly (instead of overwriting them).
function read_ini_file($file){
    $arr = array();
    $handle = fopen($file, "r");
    $currentSection = $arr;

    while (($line = fgets($handle)) !== false) {
        $parsed = parse_ini_string($line, true);

        if (empty($parsed)) {
            continue;
        }

        if ($line[0] == '[') {
            # Start of a new section
            $sectionName = key($parsed);
            $arr[$sectionName] = array();
            $currentSection = &$arr[$sectionName];
        } else {
            # key=value - insert into the current section
            $key = key($parsed);
            $value = $parsed[$key];

            if (isset($currentSection[$key])) {
                # Duplicate: turn the value into an array
                if (!is_array($currentSection[$key])) {
                    $tmp = $currentSection[$key];
                    $currentSection[$key] = array($tmp);
                }
                $currentSection[$key][] = $value;
            } else {
                # New value: add it bare
                $currentSection[$key] = $value;
            }
        }
    }
    fclose($handle);

    return $arr;
}

// PHP has no ini writing methods available: build one.
// Based on https://gist.github.com/edvardHua/a9830a68ae68f57cd892a8a2903a1fb4
function write_ini_file($assoc_arr, $path) {
    $content = "";
    foreach ($assoc_arr as $key => $elem) {
        $content .= "[" . $key . "]\n";
        foreach ($elem as $key2 => $elem2) {
            if (is_array($elem2)) {
                for ($i = 0; $i < count($elem2); $i++) {
                    // php.ini allows (requires, for extensions) duplicate keys
                    $content .= $key2 . " = \"" . $elem2[$i] . "\"\n";
                }
            } else if ($elem2 == "") {
                $content .= $key2 . " = \n";
            } else {
                $content .= $key2 . " = \"" . $elem2 . "\"\n";
            }
        }
    }
    if (!$handle = fopen($path, 'w')) {
        return false;
    }
    if (!fwrite($handle, $content)) {
        return false;
    }
    fclose($handle);
    return true;
}

// Get the contents of the current config file
$phpIniLocation = php_ini_loaded_file();
if ($phpIniLocation) {
    $phpIniContents = read_ini_file($phpIniLocation);
} else {
    $phpIniContents = array();
}

// Edit the config to trust our HTTPS certificate
if ($phpIniContents['openssl']) {
    $phpIniContents['openssl']['openssl.cafile'] = getenv('SSL_CERT_FILE');
} else {
    $phpIniContents['openssl'] = array('openssl.cafile' => getenv('SSL_CERT_FILE'));
}

if ($phpIniContents['curl']) {
    $phpIniContents['curl']['curl.cainfo'] = getenv('SSL_CERT_FILE');
} else {
    $phpIniContents['curl'] = array('curl.cainfo' => getenv('SSL_CERT_FILE'));
}

// Create a new config file that the real PHP instance will use
$newPhpIni = tempnam(sys_get_temp_dir(), 'httptoolkit-php.ini');
write_ini_file($phpIniContents, $newPhpIni);

// Log the new config path to use
echo $newPhpIni;
?>