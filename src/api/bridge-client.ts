import * as http from 'http';

import { getDeferred } from '@httptoolkit/util';

import { getSocketPath } from './ui-operation-bridge';

export async function apiRequest(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: any
): Promise<any> {
    const result = getDeferred<any>();
    const socketPath = await getSocketPath();

    const req = http.request({
        method,
        path: urlPath,
        socketPath: socketPath,
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 2000
    }, (res) => {
        const chunks: Buffer[] = [];
        res.on('error', (err) => result.reject(err));
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode && res.statusCode >= 400) {
                try {
                    const body = JSON.parse(raw);
                    const message = body.message
                        || (typeof body.error === 'string' ? body.error : body.error?.message)
                        || `HTTP ${res.statusCode}`;
                    result.reject(new Error(message));
                } catch {
                    result.reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
                }
                return;
            }
            try {
                result.resolve(JSON.parse(raw));
            } catch {
                result.reject(new Error(`Unparseable response: ${raw}`));
            }
        });
    });

    req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
            result.reject(new Error('HTTP Toolkit is not running. Start HTTP Toolkit first.'));
        } else {
            result.reject(err);
        }
    });

    if (body) {
        req.write(JSON.stringify(body));
    }
    req.end();

    return result;
}
