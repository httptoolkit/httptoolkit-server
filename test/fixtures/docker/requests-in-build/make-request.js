const https = require('https');

const targetUrl = process.argv[2];

(async function() {
    console.log(`Making request to ${targetUrl}`);

    const response = await new Promise((resolve) => {
        const req = https.get(targetUrl);
        req.on('response', resolve);
        req.on('error', () => process.exit(1));
    });

    console.log(`Got ${response.statusCode} response`);
})();