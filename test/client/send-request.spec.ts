import { expect } from 'chai';
import * as mockttp from 'mockttp';

import { sendRequest } from '../../src/client/client';

describe("The HTTP client API", () => {

    const mockServer = mockttp.getLocal({ debug: true });

    beforeEach(() => mockServer.start());
    afterEach(() => mockServer.stop());

    it("should send requests", async () => {
        await mockServer.forAnyRequest().thenCallback(async (request) => {
            expect(request.url).to.equal(`http://localhost:${mockServer.port}/path?qwe=asd`);
            expect(request.method).to.equal('POST');
            expect(
                request.rawHeaders.find(([key]) => key === 'CUSTOM-header')
            ).to.deep.equal(['CUSTOM-header', 'CUSTOM-value']);
            expect(await request.body.getText()).to.equal('Request body')

            return {
                statusCode: 200,
                statusMessage: 'Custom status message',
                headers: { 'custom-HEADER': 'custom-VALUE' },
                rawBody: Buffer.from('Mock response body')
            };
        });

        const response = await sendRequest({
            url: mockServer.urlFor('/path?qwe=asd'),
            method: 'POST',
            headers: [
                ['host', `localhost:${mockServer.port}`],
                ['content-length', '12'],
                ['CUSTOM-header', 'CUSTOM-value']
            ],
            rawBody: Buffer.from('Request body')
        }, {});

        expect(response.statusCode).to.equal(200);
        expect(response.statusMessage).to.equal('Custom status message');
        expect(response.headers).to.deep.equal([
            ['custom-HEADER', 'custom-VALUE']
        ]);
        expect(response.rawBody!.toString()).to.equal('Mock response body');
    })
});