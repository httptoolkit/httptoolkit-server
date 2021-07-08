import * as _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';
import * as stream from 'stream';

import { expect } from 'chai';

import * as Docker from 'dockerode';

import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';
import { delay } from '../../src/util';

const interceptorSetup = setupInterceptor('docker-all');

const docker = new Docker();
const DOCKER_FIXTURES = path.join(__dirname, '..', 'fixtures', 'docker');

async function buildAndRun(dockerFolder: string, argument: string) {
    const imageName = `test-${dockerFolder}:latest`;

    const dockerContext = {
        context: path.join(DOCKER_FIXTURES, dockerFolder),
        src: fs.readdirSync(path.join(DOCKER_FIXTURES, dockerFolder)),
    };

    const buildStream = await docker.buildImage(dockerContext, {
        dockerfile: 'Dockerfile',
        t: imageName
    });

    buildStream.on('data', (output) => {
        const data = JSON.parse(output);
        if (data.stream) console.log(data.stream.replace(/\n$/, ''));
    });

    // Wait for the build to complete without errors:
    await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(buildStream, (err: Error | null, stream: Array<{ error?: string }>) => {
            if (err) reject(err);

            const firstError = stream.find((msg) => !!msg.error);
            if (firstError) reject(new Error(firstError.error));

            resolve();
        });
    });
    console.log(`${dockerFolder} container built`);

    // Run the container, using its default entrypoint
    const outputStream = new stream.PassThrough();
    docker.run(imageName, [], outputStream, {
        HostConfig: { AutoRemove: true },
        Cmd: [argument]
    });

    outputStream.pipe(process.stdout);

    // The promise that docker.run returns waits for the container to *finish*. To wait until the
    // container has started, we wait for the first stream output:
    await new Promise((resolve) => outputStream.on('data', resolve));
}

async function killAllContainers() {
    const containers = await docker.listContainers()
    await Promise.all(containers.map(c =>
        docker.getContainer(c.Id).stop({ t: 0 })
    ));
}

describe('Docker interceptor', function () {

    beforeEach(async () => {
        const { server } = await interceptorSetup;
        await server.start();
    });

    afterEach(async () => {
        const { server, interceptor } = await interceptorSetup;
        await killAllContainers();
        await interceptor.deactivate(server.port);
        await server.stop();
    });

    itIsAvailable(interceptorSetup);

    [
        'JS',
        'Python',
        'Java'
    ].forEach((target) => {
        it(`should intercept external ${target} requests`, async function () {
            this.timeout(20000);
            const { interceptor, server } = await interceptorSetup;
            const mainRule = await server.get('https://example.com').thenReply(404);

            await buildAndRun(target.toLowerCase(), 'https://example.com');

            await interceptor.activate(server.port);
            console.log('Container intercepted');

            await new Promise((resolve) => server.on('response', resolve));

            const seenRequests = await mainRule.getSeenRequests();
            expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
        });
    });

});