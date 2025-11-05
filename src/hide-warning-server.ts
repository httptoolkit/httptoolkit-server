import { getLocal, type Mockttp } from 'mockttp';
import type { HtkConfig } from './config.d.ts';
import { EPHEMERAL_PORT_RANGE } from './constants.ts';

// The first tab that opens in a new Chrome/Edge window warns about dangerous flags.
// Closing it and immediately opening a new one is a bit cheeky, but
// is completely gets rid that, more or less invisibly:

export class HideWarningServer {

    private config: HtkConfig;
    private options: { delay: number | undefined } = { delay: undefined };

    constructor(
        config: HtkConfig,
        options: { delay: number | undefined } = { delay: undefined }
    ) {
        this.config = config;
        this.options = options;
    }

    private server: Mockttp = getLocal();

    // Resolved once the server has seen at least once
    // request for the warning-hiding page.
    public completedPromise = new Promise<void>((resolve) => {
        this.server.on('request', (req) => {
            if (req.url.includes('hide-warning')) {
                resolve();
            }
        });
    })

    async start(targetUrl: string) {
        await this.server.start(EPHEMERAL_PORT_RANGE);

        await this.server.forGet('/hide-warning').thenReply(200, `
            <html>
                <title>HTTP Toolkit Warning Fix</title>
                <meta charset="UTF-8" />
                <style>
                    body { background-color: #d8e2e6; }
                </style>
                <script>
                    const targetUrl = ${JSON.stringify(targetUrl)};
                    window.open(targetUrl, '_blank');

                    ${this.options.delay === undefined
                        ? 'window.close();'
                        // In some cases (Opera) closing too quickly can make the browser
                        // crash, so we delay eeeeeever so slightly:
                        : `setTimeout(() => {
                            window.close();
                        }, ${this.options.delay});`
                    }

                </script>
                <body>
                    This page should disappear momentarily. If it doesn't, click
                    <a href="${targetUrl}">this link</a>.
                </body>
            </html>
        `, { "content-type": "text/html" });
    }

    get host(): string {
        return this.server!.url
            .replace('https://', '');
    }

    get hideWarningUrl(): string {
        return this.server.url.replace(/\/?$/, '/hide-warning');
    }

    async stop() {
        await this.server.stop();
    }
}