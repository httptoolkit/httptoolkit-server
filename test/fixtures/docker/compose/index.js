const http = require('http');
const https = require('https');

const makeRequest = async (method, url) => {
    const sendRequest = url.startsWith('https') ? https.request : http.request;

    const request = sendRequest(url, { method });
    request.end();

    return new Promise((resolve, reject) => {
        request.on('response', resolve);
        request.on('error', reject);
    });
};

const SERVER_PORT = 8000;

const DOCKER_TARGET_URL = `http://${process.env.TARGET}:${SERVER_PORT}/`;
const SELF_LOCALHOST_TARGET_URL = `http://localhost:${SERVER_PORT}/`;
const SELF_HOSTNAME_TARGET_URL = `http://${process.env.HOSTNAME}:${SERVER_PORT}/`;
const EXTERNAL_TARGET_URL = `https://example.test/`; // Never normally reachable

const server = http.createServer((req, res) => {
    res.writeHead(200).end();
});

server.listen(SERVER_PORT, () => {
    console.log('Server started');
});

const pollInterval = setInterval(async () => {
    console.log("Sending requests to ",
        DOCKER_TARGET_URL,
        SELF_LOCALHOST_TARGET_URL,
        SELF_HOSTNAME_TARGET_URL,
        EXTERNAL_TARGET_URL
    );
    const responses = await Promise.all([
        makeRequest("POST", DOCKER_TARGET_URL).catch(e => e), // Will return 200
        makeRequest("POST", SELF_LOCALHOST_TARGET_URL).catch(e => e), // Will return 200
        makeRequest("POST", SELF_HOSTNAME_TARGET_URL).catch(e => e), // Will return 200
        makeRequest("GET", EXTERNAL_TARGET_URL).catch(e => e) // Will not resolve
    ]);

    // ^ This will always fail normally, because the external request fails. Will only pass if it's
    // intercepted such that both external & all internal requests are successful at the same time.

    if (responses.every(r => !(r instanceof Error) && r.statusCode === 200)) {
        console.log("All requests ok");
        clearInterval(pollInterval);

        // Exit OK, but after a delay, so the other container can still make requests to us.
        setTimeout(() => {
            process.exit(0);
        }, 500);
    } else {
        console.log("Requests failed with", responses.map(r => r.message || r.statusCode));
    }
}, 250);