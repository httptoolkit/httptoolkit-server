import * as path from 'path';

import { delay } from '@httptoolkit/util';
import Docker from 'dockerode';

export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Label applied to all Docker containers created by tests, to allow targeted cleanup
// without interfering with system containers or the app's own labels (tech.httptoolkit.docker.*).
export const TEST_CONTAINER_LABEL = 'tech.httptoolkit.test';

// Remove all containers matching a label filter, polling until they're fully
// gone from Docker's perspective (not just API-removed but still visible).
export async function removeTestContainers(docker: Docker, label: string) {
    const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [label] })
    });

    await Promise.all(containers.map(c =>
        docker.getContainer(c.Id).remove({ force: true }).catch(() => {})
    ));

    // Poll until Docker confirms no matching containers remain:
    for (let i = 0; i < 20; i++) {
        const remaining = await docker.listContainers({
            all: true,
            filters: JSON.stringify({ label: [label] })
        });
        if (remaining.length === 0) return;
        await delay(100);
    }
}