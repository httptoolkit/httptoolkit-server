import * as _ from 'lodash';
import { expect } from 'chai';
import * as mockttp from 'mockttp';
import { delay } from '@httptoolkit/util';

import { HttpClient } from '../../src/client/http-client';
import { streamToArray } from '../../src/util/stream';

describe("The HTTP client API", () => {

    const mockServer = mockttp.getLocal();

    beforeEach(() => mockServer.start());
    afterEach(() => mockServer.stop());

    it("should send requests", async () => {
        await mockServer.forAnyRequest().thenCallback(async (request) => {
            expect(request.url).to.equal(`http://localhost:${mockServer.port}/path?qwe=asd`);
            expect(request.method).to.equal('POST');
            expect(request.rawHeaders).to.deep.equal([
                ['host', `localhost:${mockServer.port}`],
                ['content-length', '12'],
                ['CUSTOM-header', 'CUSTOM-value']
            ]);
            expect(await request.body.getText()).to.equal('Request body');

            return {
                statusCode: 200,
                statusMessage: 'Custom status message',
                headers: {
                    'custom-HEADER': 'custom-VALUE',
                    'Transfer-Encoding': 'chunked'
                },
                trailers: { 'custom-TRAILER': 'trailer-VALUE' },
                rawBody: Buffer.from('Mock response body')
            };
        });

        const client = new HttpClient({});
        const responseStream = await client.sendRequest({
            url: mockServer.urlFor('/path?qwe=asd'),
            method: 'POST',
            headers: [
                ['host', `localhost:${mockServer.port}`],
                ['content-length', '12'],
                ['CUSTOM-header', 'CUSTOM-value']
            ],
            rawBody: Buffer.from('Request body')
        }, {});

        const responseEvents = await streamToArray<any>(responseStream);

        expect(responseEvents.length).to.equal(5);
        expect(_.omit(responseEvents[0], 'timestamp', 'startTime')).to.deep.equal({
            type: 'request-start'
        });
        expect(_.omit(responseEvents[1], 'timestamp')).to.deep.equal({
            type: 'response-head',
            statusCode: 200,
            statusMessage: 'Custom status message',
            headers: [
                ['custom-HEADER', 'custom-VALUE'],
                ['Transfer-Encoding', 'chunked']
            ]
        });

        expect(responseEvents[2].type).equal('response-body-part');
        expect(responseEvents[2].rawBody.toString()).to.equal('Mock response body');

        expect(_.omit(responseEvents[3], 'timestamp')).to.deep.equal({
            type: 'response-trailers',
            trailers: [
                ['custom-TRAILER', 'trailer-VALUE']
            ]
        });

        expect(_.omit(responseEvents[4], 'timestamp')).to.deep.equal({
            type: 'response-end'
        });
    });

    it("should stop requests if cancelled", async () => {
        await mockServer.forAnyRequest().thenTimeout();

        const requests: any[] = [];
        mockServer.on('request', (req) => requests.push(req));
        const aborts: any[] = [];
        mockServer.on('abort', (req) => aborts.push(req));

        const abortController = new AbortController();

        const client = new HttpClient({});
        const responseStream = await client.sendRequest({
            url: mockServer.url,
            method: 'GET',
            headers: [['host', `localhost:${mockServer.port}`]]
        }, {
            abortSignal: abortController.signal
        });

        const responseEvents: any[] = [];
        responseStream.on('data', (d) => responseEvents.push(d));
        responseStream.on('error', (e) => responseEvents.push(e));
        await delay(50);

        expect(requests.length).to.equal(1);
        expect(aborts.length).to.equal(0);

        // Start is emitted immediately:
        expect(responseEvents.length).to.equal(1);
        expect(_.omit(responseEvents[0], 'timestamp', 'startTime')).to.deep.equal({
            type: 'request-start'
        });

        abortController.abort();
        await delay(50);

        expect(requests.length).to.equal(1);
        expect(aborts.length).to.equal(1); // <-- Server sees the request cancelled

        // Only other events is a thrown error:
        expect(responseEvents.length).to.equal(2);
        expect(responseEvents[1]).to.be.instanceOf(Error);
        expect(responseEvents[1].code).to.be.oneOf([
            // Depends on the Node version you're testing with:
            'ECONNRESET',
            'ABORT_ERR'
        ]);
    });

    describe("given an upstream proxy", () => {

        const proxyServer = mockttp.getLocal();

        beforeEach(() => proxyServer.start());
        afterEach(() => proxyServer.stop());

        it("should forward requests via the proxy", async () => {
            const passthroughRule = await proxyServer.forAnyRequest().thenPassThrough();
            const targetRule = await mockServer.forAnyRequest().thenReply(200);

            const client = new HttpClient({});
            const responseStream = await client.sendRequest({
                url: mockServer.url,
                method: 'GET',
                headers: [['host', `localhost:${mockServer.port}`]]
            }, {
                proxyConfig: {
                    proxyUrl: proxyServer.url
                }
            });
            await new Promise((resolve) => {
                responseStream.on('end', resolve);
                responseStream.resume(); // Without this, it buffers the response data
            });

            // Both the proxy & target server successfully received the requests:
            const proxiedRequests = await passthroughRule.getSeenRequests();
            expect(proxiedRequests.length).to.equal(1);

            const targetServerRequests = await targetRule.getSeenRequests();
            expect(targetServerRequests.length).to.equal(1);
        });

    });
});