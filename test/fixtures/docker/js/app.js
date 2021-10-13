const https = require('https');

const delay = (timeMs) => new Promise((resolve) => setTimeout(resolve, timeMs));

const targetUrl = process.argv[2];

(async function() {
    console.log('Starting JS container');

    while (true) {
        const response = await new Promise((resolve, reject) => {
            const req = https.get(targetUrl);
            req.on('response', resolve);
            req.on('error', reject);
        });
        console.log(`Got ${response.statusCode} response`);

        await delay(500);
    }
})();