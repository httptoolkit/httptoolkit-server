import { getLocal, Mockttp } from 'mockttp';

import { HtkConfig } from './config';
import { getDeferred } from './util/promise';

export class MessageServer {

    constructor(
        private config: HtkConfig,
        private message: string
    ) { }

    private server: Mockttp | undefined;

    private messageSeen = getDeferred();

    async start() {
        this.server = getLocal({ https: this.config.https, cors: true });
        await this.server.start();

        await this.server.get('/')
            .thenCallback(() => {
                console.log('Request to message server received');
                this.messageSeen.resolve();

                return {
                    statusCode: 200,
                    body: `
                        <html>
                            <title>${this.config.appName}</title>
                            <meta charset="UTF-8" />
                            <link href="http://fonts.googleapis.com/css?family=Lato" rel="stylesheet" />
                            <style>
                                body {
                                    margin: 0;
                                    padding: 20px;
                                    background-color: #d8e2e6;
                                    font-family: Lato, Arial;

                                    position: absolute;
                                    top: 50%;
                                    transform: translateY(-50%);

                                    width: 100%;
                                    box-sizing: border-box;
                                    text-align: center;
                                }

                                p {
                                    font-size: 16pt;
                                }

                                iframe {
                                    display: none;
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

                                <p>
                                    ${this.message}
                                </p>
                            </div>
                            </body>
                        </html>
                    `
                };
            });
    }

    get host(): string {
        return this.server!.url
            .replace('https://', '');
    }

    get url(): string {
        return this.server!.url.replace('https://', 'http://');
    }

    async waitForSuccess(): Promise<void> {
        await this.messageSeen.promise;
    }

    async stop() {
        if (this.server) {
            await this.server.stop();
            this.server = undefined;
        }
    }
}