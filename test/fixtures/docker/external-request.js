const https = require('https');

const delay = (timeMs) => new Promise((resolve) => setTimeout(resolve, timeMs));

(async function() {
    console.log('Starting external request container');

    while (true) {
        const response = await new Promise((resolve, reject) => {
            const req = https.get("https://example.com");
            req.on('response', resolve);
            req.on('error', reject);
        });
        console.log(`Got ${response.statusCode} response`);

        await delay(500);
    }
})();