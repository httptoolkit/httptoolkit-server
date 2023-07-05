import { expect } from 'chai';
import * as mockttp from 'mockttp';

import { ResponseStreamEvents, sendRequest } from '../../src/client/client';
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
            expect(await request.body.getText()).to.equal('Request body')

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

        const responseParts = await streamToArray<any>(responseStream);

        expect(responseParts.length).to.equal(2);
        expect(responseParts[0]).to.deep.equal({
            type: 'response-head',
            statusCode: 200,
            statusMessage: 'Custom status message',
            headers: [
                ['custom-HEADER', 'custom-VALUE']
            ]
        });

        expect(responseParts[1].type).equal('response-body-part');
        expect(responseParts[1].data.toString()).to.equal('Mock response body');
    })
});