Hello world

<?php

$stdout = fopen('php://stdout', 'w');

fwrite($stdout, 'Running PHP');

while (true) {
    $cURL = curl_init();
    $setopt_array = array(
        CURLOPT_URL => $_GET['target'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array()
    );
    curl_setopt_array($cURL, $setopt_array);
    curl_exec($cURL);
    $httpcode = curl_getinfo($cURL, CURLINFO_HTTP_CODE);
    fwrite($stdout, "Got ".$httpcode." response");
    curl_close($cURL);

    sleep(1);
}

?>