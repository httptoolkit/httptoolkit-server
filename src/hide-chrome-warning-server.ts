import { getLocal, Mockttp } from 'mockttp';

// Make the types for some of the browser code below happy.
let targetUrl: string;

// The first tab that opens opens with a Chrome warning about dangerous flags
// Closing it and immediately opening a new one is a bit cheeky, but
// is completely gets rid that, more or less invisibly.
function jumpToNewTab() {
    window.open(targetUrl, '_blank');
    window.close();
}

export class HideChromeWarningServer {

    private server: Mockttp = getLocal();

    // Resolved once the server has seen at least once
    // request for the warning-hiding page.
    public completedPromise = new Promise<void>((resolve) => {
        this.server.on('request', (req) => {
            if (req.url.includes('hide-chrome-warning')) {
                resolve();
            }
        });
    })

    async start(targetUrl: string) {
        await this.server.start();

        await this.server.get('/hide-chrome-warning').thenReply(200, `
            <html>
                <title>HTTP Toolkit Chrome Warning Fix</title>
                <meta charset="UTF-8" />
                <style>
                    body { background-color: #d8e2e6; }
                </style>
                <script>
                    const targetUrl = ${JSON.stringify(targetUrl)};

                    ${jumpToNewTab.toString()}
                    jumpToNewTab();
                </script>
                <body>
                    This page should disappear momentarily. If it doesn't, click
                    <a href="${targetUrl}">this link</a>
                </body>
            </html>
        `);
    }

    get hideWarningUrl(): string {
        return this.server.url.replace(/\/?$/, '/hide-chrome-warning');
    }

    async stop() {
        await this.server.stop();
    }
}