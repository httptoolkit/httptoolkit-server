import * as _ from 'lodash';
import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';

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

    // Wait for the build to complete
    await new Promise((resolve) => buildStream.on('end', resolve));
    console.log(`${dockerFolder} container built`);

    // Run the container, using its default entrypoint
    docker.run(imageName, [], process.stdout, {
        HostConfig: { AutoRemove: true },
        Cmd: [argument]
    });

    await delay(500); // Wait for the container to be ready
    console.log('Container started');
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
        'Python'
    ].forEach((target) => {
        it(`should intercept external ${target} requests`, async function () {
            this.timeout(20000);
            const { interceptor, server } = await interceptorSetup;
            const mainRule = await server.get('https://example.com').thenReply(404);

            await buildAndRun(target.toLowerCase(), 'https://example.com');

            await interceptor.activate(server.port);
            console.log('Container intercepted');
            await delay(1000);

            const seenRequests = await mainRule.getSeenRequests();
            expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
        });
    });

});