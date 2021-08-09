import { getLocal, Mockttp } from 'mockttp';

import { HtkConfig } from './config';
import { getDeferred } from './util/promise';

const buildPage = (config: HtkConfig, style: string, script?: string, body?: string) =>
`<html>
    <head>
        <title>${config.appName} HTTPS Test</title>
        <meta charset="UTF-8" />
        <link href="http://fonts.googleapis.com/css?family=Lato" rel="stylesheet" />
        <style>
            body {
                margin: 0;
                padding: 20px;
            }

            ${style}
        </style>
        ${script}
    </head>
    <body>
        ${body}
    </body>
</html>`;

export class CertCheckServer {

    constructor(private config: HtkConfig) { }

    private server: Mockttp | undefined;

    private certCheckedSuccessfully = getDeferred<boolean>();

    async start(targetUrl: string) {
        this.server = getLocal({ https: this.config.https, cors: true });
        await this.server.start();

        await Promise.all([
            this.server.get('/test-https').thenCallback(() => {
                console.log('Request to /test-https successfully received');
                this.certCheckedSuccessfully.resolve(true);
                return { statusCode: 200 };
            }),
            this.server.get('/check-cert').thenCallback(() => {
                console.log('Request to /check-cert received');

                return {
                    statusCode: 200,
                    body: buildPage(this.config, `
                            body {
                                background-color: #d8e2e6;
                                font-family: Lato, Arial;

                                position: absolute;
                                top: 50%;
                                left: 50%;
                                transform: translate(-50%, -50%);
                                box-sizing: border-box;
                                text-align: center;
                            }

                            p {
                                font-size: 16pt;
                            }

                            iframe {
                                display: none;
                            }
                        `,`
                            <script>
                                let installingCert = false;
                                const targetUrl = ${JSON.stringify(targetUrl)};

                                function ensureCertificateIsInstalled() {
                                    const testUrl = window.location.href.replace('http://', 'https://').replace('check-cert', 'test-https');
                                    const failedUrl = window.location.href.replace('check-cert', 'failed-test');

                                    fetch(testUrl)
                                        .then(() => true)
                                        .catch(() => false)
                                        .then((certificateIsTrusted) => {
                                            if (certificateIsTrusted) {
                                                window.location.replace(targetUrl);
                                            } else {
                                                window.location.replace(failedUrl);
                                            }
                                        });
                                    }
                                    ensureCertificateIsInstalled();
                            </script>
                    `, `
                        <svg
                            version="1.1"
                            xmlns="http://www.w3.org/2000/svg"
                            xmlns:xlink="http://www.w3.org/1999/xlink"
                            x="0px"
                            y="0px"
                            width="400px"
                            height="400px"
                            viewBox="0 0 50 50"
                            style="enable-background:new 0 0 50 50;"
                        >
                            <path fill="#b6c2ca" d="M25.251,6.461c-10.318,0-18.683,8.365-18.683,18.683h4.068c0-8.071,6.543-14.615,14.615-14.615V6.461z">
                                <animateTransform
                                    attributeType="xml"
                                    attributeName="transform"
                                    type="rotate"
                                    from="0 25 25"
                                    to="360 25 25"
                                    dur="6s"
                                    repeatCount="indefinite"
                                />
                            </path>
                        </svg>
                    `)
                };
            }),
            this.server.get('/failed-test').thenCallback(() => {
                console.log('Request to /failed-test received');
                this.certCheckedSuccessfully.resolve(false);

                return {
                    statusCode: 200,
                    body: buildPage(this.config, `
                            body {
                                background-color: #d8e2e6;
                                font-family: Lato, Arial;

                                position: absolute;
                                top: 50%;
                                left: 50%;
                                transform: translate(-50%, -50%);
                                width: 60%;
                                box-sizing: border-box;
                                text-align: center;
                            }

                            p {
                                font-size: 16pt;
                            }

                            iframe {
                                display: none;
                            }
                        `, ``, `
                            <p>
                                This browser does not trust the HTTP Toolkit certificate authority, so HTTPS traffic can't be intercepted.
                            </p><p>
                                Closing the browser and starting it again from HTTP Toolkit will often resolve this. If not,
                                please file a bug at <strong>github.com/httptoolkit/httptoolkit</strong>.
                            </p>
                    `)
                };
            }),
        ]);
    }

    get host(): string {
        return this.server!.url
            .replace('https://', '');
    }

    get url(): string {
        return this.server!.url
            .replace('https://', 'http://')
            .replace(/\/?$/, '/check-cert');
    }

    async waitForSuccess(): Promise<void> {
        return this.certCheckedSuccessfully.promise
            .then((result) => {
                if (result !== true) throw new Error("Certificate check failed");
            });
    }

    async stop() {
        if (this.server) {
            await this.server.stop();
            this.server = undefined;
        }
    }
}