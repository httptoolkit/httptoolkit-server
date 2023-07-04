import * as stream from 'stream';

export function streamToBuffer(input: stream.Readable) {
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        input.on('data', (d) => chunks.push(d));
        input.on('end', () => resolve(Buffer.concat(chunks)));
        input.on('error', reject);
    });
};