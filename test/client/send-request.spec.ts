import { expect } from 'chai';
import * as mockttp from 'mockttp';

import { ResponseStreamEvents, sendRequest } from '../../src/client/client';
import { streamToArray } from '../../src/util/stream';
import { delay } from '../../src/util/promise';

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
                headers: { 'custom-HEADER': 'custom-VALUE' },
                rawBody: Buffer.from('Mock response body')
            };
        });

        const responseStream = sendRequest({
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

        expect(responseEvents.length).to.equal(2);
        expect(responseEvents[0]).to.deep.equal({
            type: 'response-head',
            statusCode: 200,
            statusMessage: 'Custom status message',
            headers: [
                ['custom-HEADER', 'custom-VALUE']
            ]
        });

        expect(responseEvents[1].type).equal('response-body-part');
        expect(responseEvents[1].rawBody.toString()).to.equal('Mock response body');
    });

    it("should stop requests if cancelled", async () => {
        await mockServer.forAnyRequest().thenTimeout()

        const requests: any[] = [];
        mockServer.on('request', (req) => requests.push(req));
        const aborts: any[] = [];
        mockServer.on('abort', (req) => aborts.push(req));

        const abortController = new AbortController();

        const responseStream = sendRequest({
            url: mockServer.url,
            method: 'GET',
            headers: [['host', `localhost:${mockServer.port}`]]
        }, {
            abortSignal: abortController.signal
        });

        const responseEvents: any[] = [];
        responseStream.on('data', (d) => responseEvents.push(d));
        responseStream.on('error', (e) => responseEvents.push(e));
        await delay(10);

        expect(requests.length).to.equal(1);
        expect(aborts.length).to.equal(0);
        expect(responseEvents.length).to.equal(0);

        abortController.abort();
        await delay(10);

        expect(requests.length).to.equal(1);
        expect(aborts.length).to.equal(1); // <-- Server sees the request cancelled

        // Only emitted event is a thrown error:
        expect(responseEvents.length).to.equal(1);
        expect(responseEvents[0]).to.be.instanceOf(Error);
        expect(responseEvents[0].code).to.be.oneOf([
            // Depends on the Node version you're testing with:
            'ECONNRESET',
            'ABORT_ERR'
        ]);
    })
});