import { getLocal, Mockttp } from 'mockttp';

import { readFile } from './util';
import { HtkConfig } from './config';

export class CertCheckServer {

    constructor(private config: HtkConfig) { }

    private server: Mockttp | undefined;

    async start(targetUrl?: string) {
        this.server = getLocal({ https: this.config.https, cors: true });
        await this.server.start();

        const certificatePem = await readFile(this.config.https.certPath);

        if (!targetUrl) targetUrl = this.server.urlFor('/spinner');

        await Promise.all([
            this.server.get('/test-https').thenReply(200),
            this.server.get('/download-cert').thenReply(200, certificatePem, {
                'Content-type': 'application/x-x509-ca-cert'
            }),
            this.server.get('/check-cert').thenReply(200, `
                <html>
                    <title>${this.config.appName} Certificate Setup</title>
                    <meta charset="UTF-8" />
                    <link href="http://fonts.googleapis.com/css?family=Lato" rel="stylesheet" />
                    <style>
                        body {
                            margin: 0;
                            padding: 20px;
                            background-color: #d8e2e6;
                            font-family: Lato, Arial;

                            position: absolute;
                            bottom: 0;
                            width: 100%;
                            box-sizing: border-box;
                            text-align: center;
                        }

                        body:not(.show-content) > * {
                            display: none;
                        }

                        p {
                            font-size: 16pt;
                        }

                        iframe {
                            display: none;
                        }
                    </style>
                    <script>
                        let installingCert = false;
                        const targetUrl = ${JSON.stringify(targetUrl)};

                        function ensureCertificateIsInstalled() {
                            const testUrl = window.location.href.replace('http://', 'https://').replace('check-cert', 'test-https');
                            const downloadUrl = window.location.href.replace('check-cert', 'download-cert');
                            const reportSuccessUrl = window.location.href.replace('check-cert', 'report-success');

                            fetch(testUrl)
                                .then(() => true)
                                .catch(() => false)
                                .then((certificateIsTrusted) => {
                                    if (certificateIsTrusted) {
                                        // Report success (ignoring errors) then continue.
                                        fetch(reportSuccessUrl).catch(() => {}).then(() => {
                                            window.location.replace(targetUrl);
                                        });
                                    } else {
                                        // Start trying to prompt the user to install the cert
                                        if (!installingCert) {
                                            installingCert = true;
                                            document.body.className = 'show-content';
                                            const iframe = document.createElement('iframe');
                                            iframe.src = downloadUrl;
                                            document.body.appendChild(iframe);
                                            setInterval(ensureCertificateIsInstalled, 500);
                                        }
                                    }
                                });
                            }
                            ensureCertificateIsInstalled();
                    </script>
                    <body>
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

                        <p>
                            To intercept HTTPS traffic, you need to trust the ${this.config.appName} certificate.
                            <br/>
                            This will only apply to this standalone Firefox profile, not your normal browser.
                        </p>
                        <p><strong>
                            Select 'Trust this CA to identify web sites' and press 'OK' to continue.
                        </strong></p>
                        <p>
                            Made a mistake? Quit Firefox and start again to retry.
                        </p>
                    </div>
                    </body>
                </html>
            `),
            this.server.get('/spinner').thenReply(200, `
                <html>
                    <title>${this.config.appName} Certificate Setup</title>
                    <meta charset="UTF-8" />
                    <style>
                        body {
                            margin: 20px;
                            background-color: #d8e2e6;
                        }
                    </style>
                    <body>
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
                    </div>
                    </body>
                </html>
            `),
        ]);
    }

    get host(): string {
        return this.server!.url
            .replace('https://', '');
    }

    get checkCertUrl(): string {
        return this.server!.url
            .replace('https://', 'http://')
            .replace(/\/?$/, '/check-cert');
    }

    async waitForSuccess(): Promise<void> {
        return new Promise<void>((resolve) =>
            this.server!.get('/report-success').thenCallback(() => {
                resolve();
                return { status: 200 };
            })
        );
    }

    async stop() {
        if (this.server) {
            await this.server.stop();
            this.server = undefined;
        }
    }
}