import * as http from 'http';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getDeferred } from '@httptoolkit/util';

import { getSocketPath } from './ui-operation-bridge';

const execFileAsync = promisify(execFile);
let darwinTempDirPromise: Promise<string | undefined> | undefined;

function getDarwinTempDir(): Promise<string | undefined> {
    if (!darwinTempDirPromise) {
        darwinTempDirPromise = execFileAsync(
            '/usr/bin/getconf',
            ['DARWIN_USER_TEMP_DIR'],
            { encoding: 'utf8', timeout: 1000 }
        )
            .then(({ stdout }) => stdout.trim() || undefined)
            .catch(() => undefined);
    }

    return darwinTempDirPromise;
}

export async function apiRequest(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: any
): Promise<any> {
    const socketPaths = [await getSocketPath()];

    if (
        process.platform === 'linux' &&
        !process.env.XDG_RUNTIME_DIR &&
        process.getuid
    ) {
        socketPaths.push(path.join(
            '/run/user',
            `${process.getuid()}`,
            'httptoolkit-ctl.sock'
        ));
    } else if (process.platform === 'darwin') {
        const darwinTempDir = await getDarwinTempDir();
        const darwinSocketPath = darwinTempDir
            ? path.join(darwinTempDir, 'httptoolkit-ctl.sock')
            : undefined;

        if (darwinSocketPath && !socketPaths.includes(darwinSocketPath)) {
            socketPaths.push(darwinSocketPath);
        }
    }

    for (let i = 0; i < socketPaths.length; i++) {
        const socketPath = socketPaths[i];

        try {
            return await socketRequest(socketPath, method, urlPath, body);
        } catch (err: any) {
            const isConnectionFailure =
                err.code === 'ECONNREFUSED' || err.code === 'ENOENT';
            const hasFallback = i < socketPaths.length - 1;

            if (!isConnectionFailure || !hasFallback) {
                if (isConnectionFailure) {
                    throw new Error(
                        'HTTP Toolkit is not running. Start HTTP Toolkit first.'
                    );
                }
                throw err;
            }
        }
    }
}

function socketRequest(
    socketPath: string,
    method: 'GET' | 'POST',
    urlPath: string,
    body?: any
): Promise<any> {
    const result = getDeferred<any>();
    const req = http.request({
        method,
        path: urlPath,
        socketPath,
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

    req.on('error', (err) => result.reject(err));

    if (body) {
        req.write(JSON.stringify(body));
    }
    req.end();

    return result;
}
