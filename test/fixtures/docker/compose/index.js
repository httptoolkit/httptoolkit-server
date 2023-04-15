const http = require('http');
const https = require('https');

// The 'none' network container can just shutdown immediately - we only want
// to check it starts OK, but we'll clearly never be able to proxy anything.
if (process.env.SKIP_REQUESTS) {
    console.log('Skipping');
    process.exit(0);
}

const makeRequest = async (url) => {
    const sendRequest = url.startsWith('https') ? https.request : http.request;

    const request = sendRequest(url);
    request.end();

    return new Promise((resolve, reject) => {
        request.on('response', resolve);
        request.on('error', reject);
    });
};

const getBody = (response) => new Promise((resolve, reject) => {
    let body = "";
    response.on('data', (d) => {
        body = body + d;
    });
    response.on('end', () => resolve(body));
    response.on('error', reject);
});

const SERVER_PORT = 9876;
const OUR_HOSTNAME = process.env.HOSTNAME;

const isOurHostname = (v) => v === OUR_HOSTNAME;
const isNotOurHostname = (v) => v !== OUR_HOSTNAME;
const is = (x) => (v) => v === x;

const TARGETS = [
    // Can we remotely resolve our own loopback address?
    [`http://localhost:${SERVER_PORT}/`, isOurHostname],
    [`http://127.0.0.1:${SERVER_PORT}/`, isOurHostname],
    // (This works because Mockttp replaces localhost addresses in requests with
    // the client's IP)

    // We can remote resolve our Docker hostname?
    [`http://${OUR_HOSTNAME}:${SERVER_PORT}/`, isOurHostname],
    // (This works because our hostname is picked up by the network monitor, so the
    // request is sent via the tunnel, and our DNS server routes it to our IP.

    // Can we resolve a mocked-only URL?
    [`https://example.test/`, is('Mock response')],
    // (This will always fail normally, but works in testing because we specifically
    // spot this and inject the response).
];

if (process.env.EXTRA_TARGET) {
    TARGETS.push([process.env.EXTRA_TARGET, isNotOurHostname]);
}

const server = http.createServer((req, res) => {
    res.writeHead(200).end(OUR_HOSTNAME);
});

server.listen(SERVER_PORT, () => {
    console.log('Server started');
});

const pollInterval = setInterval(async () => {
    console.log("Sending requests to ", TARGETS);

    const responses = await Promise.all(TARGETS.map(([target]) =>
        makeRequest(target).catch(e => e)
    ));

    // ^ This will always fail normally, because the external request fails. Will only pass if it's
    // intercepted such that both external & all internal requests are successful at the same time.

    if (responses.every((response) =>
        !(response instanceof Error) &&
        response.statusCode === 200
    )) {
        // Check the bodies, fail hard if any have the wrong content (i.e. went to the wrong host)
        const responseBodies = await Promise.all(responses.map(r => getBody(r)));
        responseBodies.forEach((body, i) => {
            const validateBody = TARGETS[i][1];
            if (!validateBody(body)) throw new Error(
                `Request ${i} to ${TARGETS[i][0]} unexpectedly returned ${body}`
            );
        });

        console.log("All requests ok");
        clearInterval(pollInterval);

        // Exit OK, but after a delay, so the other containers can still make requests to us.
        setTimeout(() => {
            process.exit(0);
        }, 5000);
    } else {
        console.log("Requests failed with", responses.map(r => r.message || r.statusCode));
    }
}, 250);