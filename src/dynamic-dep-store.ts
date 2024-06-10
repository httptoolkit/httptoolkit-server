import * as path from 'path';
import * as fs from './util/fs';
import * as stream from 'stream';

import { HtkConfig } from './config';

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
    downloadStream.pipe(diskStream);

    downloadStream.on('error', (e) => {
        console.warn(`Failed to download dependency to ${depPath}:`, e);
        diskStream.destroy();
        fs.deleteFile(tmpDownloadPath).catch(() => {});
    });

    diskStream.on('finish', () => {
        fs.moveFile(tmpDownloadPath, depPath)
            .catch(console.warn);
    });

    return downloadStream;
}