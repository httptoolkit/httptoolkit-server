import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import { streamToBuffer } from '../util/stream';

export type RawHeaders = Array<[key: string, value: string]>;

export interface RequestDefinition {
    method: string;
    url: string;
    headers: RawHeaders;
    rawBody?: Uint8Array;
}

export interface RequestOptions {
}

export interface ResponseDefinition {
    statusCode: number;
    statusMessage?: string;
    headers: RawHeaders;
    rawBody?: Buffer;
}

export async function sendRequest(
    requestDefn: RequestDefinition,
    options: RequestOptions
): Promise<ResponseDefinition> {
    const url = new URL(requestDefn.url);

    const request = (url.protocol === 'https' ? https : http).request(requestDefn.url, {
        method: requestDefn.method,

        // Node supports sending raw headers via [key, value, key, value] array, but we need an
        // 'any' as the types don't believe it:
        headers: flattenPairedRawHeaders(requestDefn.headers) as any
    });

    if (requestDefn.rawBody?.byteLength) {
        request.end(requestDefn.rawBody);
    } else {
        request.end();
    }

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        request.on('error', reject);
        request.on('response', resolve);
    });

    const body = await streamToBuffer(response);

    return {
        statusCode: response.statusCode!,
        statusMessage: response.statusMessage,
        headers: pairFlatRawHeaders(response.rawHeaders),
        rawBody: body
    }
}

/**
 * Turn node's _very_ raw headers ([k, v, k, v, ...]) into our slightly more convenient
 * pairwise tuples [[k, v], [k, v], ...] RawHeaders structure.
 */
export function pairFlatRawHeaders(flatRawHeaders: string[]): RawHeaders {
    const result: RawHeaders = [];
    for (let i = 0; i < flatRawHeaders.length; i += 2 /* Move two at a time */) {
        result[i/2] = [flatRawHeaders[i], flatRawHeaders[i+1]];
    }
    return result;
}

/**
 * Turn our raw headers [[k, v], [k, v], ...] tuples into Node's very flat
 * [k, v, k, v, ...] structure.
 */
export function flattenPairedRawHeaders(rawHeaders: RawHeaders): string[] {
    return rawHeaders.flat();
}