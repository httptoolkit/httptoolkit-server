import { promisify } from 'util';
import * as fs from 'fs';

import { getLocal, Mockttp } from 'mockttp';

import { HttpsPathOptions } from 'mockttp/dist/util/tls';

const readFile = promisify(fs.readFile);

// Make the types for some of the browser code below happy.
let targetUrl: string;
let installingCert: boolean;

// Check if an HTTPS cert to a server using the certificate succeeds
// If it doesn't, redirect to the certificate itself (the browser will prompt to install)
// Note that this function is stringified, and run in the browser, not here in node.
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

export class CertCheckServer {

    constructor(private config: { https: HttpsPathOptions }) { }

    private server: Mockttp | undefined;

    async start(targetUrl: string) {
        this.server = getLocal({ https: this.config.https, cors: true });
        await this.server.start();

        const certificatePem = await readFile(this.config.https.certPath);

        await Promise.all([
            this.server.get('/test-https').thenReply(200),
            this.server.get('/download-cert').thenReply(200, certificatePem, {
                'Content-type': 'application/x-x509-ca-cert'
            }),
            this.server.get('/check-cert').thenReply(200, `
                <html>
                    <title>HTTP Toolkit Certificate Setup</title>
                    <meta charset="UTF-8" />
                    <link href="http://fonts.googleapis.com/css?family=Lato" rel="stylesheet" />
                    <style>
                        body {
                            margin: 20px;
                            background-color: #d8e2e6;
                            font-family: Lato, Arial;
                        }

                        body:not(.show-content) > * {
                            display: none;
                        }

                        h1 {
                            font-size: 36pt;
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

                        ${ensureCertificateIsInstalled.toString()}
                        ensureCertificateIsInstalled();
                    </script>
                    <body>
                        <h1>
                            Configuring Firefox to use HTTP Toolkit
                        </h1>
                        <p>
                            To intercept HTTPS traffic, you need to trust the HTTP Toolkit certificate.
                        </p>
                        <p>
                            Select 'Trust this CA to identify web sites' and press 'OK' to continue.
                        </p>

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
            `)
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