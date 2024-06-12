import * as path from 'path';
import * as stream from 'stream';
import { CustomError } from '@httptoolkit/util';

import { HtkConfig } from './config';
import * as fs from './util/fs';

/**
 * This retrieves a stream for a dependency file, either from disk if it's already available
 * or by calling the fetch() function (and then saving the result to disk in parallel for
 * future calls).
 */
export async function getDependencyStream<K extends readonly string[]>(options: {
    config: HtkConfig,
    key: K,
    ext: `.${string}`,
    fetch: (key: K) => Promise<stream.Readable>
}) {
    const depPath = path.join(options.config.configPath, `${options.key.join('-')}${options.ext}`);

    if (await fs.canAccess(depPath)) {
        return fs.createReadStream(depPath);
    }

    const tmpDownloadPath = depPath + `.tmp-${Math.random().toString(36).slice(2)}`;
    const downloadStream = await options.fetch(options.key);
    const diskStream = fs.createWriteStream(tmpDownloadPath);
    const resultStream = new stream.PassThrough();

    downloadStream.pipe(diskStream);
    downloadStream.pipe(resultStream);

    downloadStream.on('error', (e) => {
        console.warn(`Failed to download dependency to ${depPath}:`, e);

        // Clean up the temp download file:
        diskStream.destroy();
        fs.deleteFile(tmpDownloadPath).catch(() => {});

        // Pass the error on to the client:
        resultStream.destroy(
            new CustomError(`${options.key.join('-')} dependency fetch failed: ${e.message ?? e}`, {
                cause: e
            })
        );
    });

    diskStream.on('finish', () => {
        fs.moveFile(tmpDownloadPath, depPath)
            .catch(console.warn);
    });

    return resultStream;
}