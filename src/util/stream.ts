import * as stream from 'stream';

export function streamToArray<T extends unknown>(input: stream.Readable) {
    return new Promise<T[]>((resolve, reject) => {
        const chunks: T[] = [];
        input.on('data', (d) => chunks.push(d));
        input.on('end', () => resolve(chunks));
        input.on('error', reject);
    });
};

export async function streamToBuffer(input: stream.Readable) {
    const chunks = await streamToArray<Uint8Array>(input);
    return Buffer.concat(chunks);
};