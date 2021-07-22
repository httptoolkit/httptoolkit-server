import * as _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';

import { expect } from 'chai';

import * as Docker from 'dockerode';

import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';
import { delay } from '../../src/util';

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
    console.log(`${dockerFolder} image built`);

    // Run the container, using its default entrypoint
    const container = await docker.createContainer({
        Image: imageName,
        HostConfig: { AutoRemove: true },
        Cmd: [argument],
        Tty: true,
    });

    const stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true
    });

    stream.setEncoding('utf8');
    stream.pipe(process.stdout);

    console.log('Container created');

    container.start();

    // The promise that docker.run returns waits for the container to *finish*. To wait until the
    // container has started, we wait for the first stream output:
    await new Promise((resolve) => stream.on('data', resolve));

    return container.id;
}

async function killAllContainers() {
    const containers = await docker.listContainers()
    await Promise.all(containers.map(c =>
        docker.getContainer(c.Id).stop({ t: 0 })
    ));
}

const interceptorSetup = setupInterceptor('docker-container');

describe('Docker single-container interceptor', function () {

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
        'Java',
        'Python',
        'Ruby',
        'Go'
    ].forEach((target) => {
        it(`should intercept external ${target} requests`, async function () {
            this.timeout(60000);
            const { interceptor, server } = await interceptorSetup;
            const mainRule = await server.get('https://example.com').thenReply(404);

            const containerId = await buildAndRun(target.toLowerCase(), 'https://example.com');

            await delay(500);
            expect(
                (await interceptor.getMetadata!('summary')).map(({ id }: any) => id)
            ).to.include(containerId);

            await interceptor.activate(server.port, { containerId });
            console.log('Container intercepted');

            await new Promise((resolve) => server.on('response', resolve));

            const seenRequests = await mainRule.getSeenRequests();
            expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
        });
    });

});