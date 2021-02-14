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
const dockerContext = {
    context: DOCKER_FIXTURES,
    src: fs.readdirSync(DOCKER_FIXTURES),
};

async function buildAndRun(dockerfile: string) {
    const imageName = `test-${dockerfile.split('.')[0]}:latest`;

    const buildStream = await docker.buildImage(dockerContext, {
        dockerfile,
        t: imageName
    });

    buildStream.on('data', (output) => {
        const data = JSON.parse(output);
        if (data.stream) console.log(data.stream.replace(/\n$/, ''));
    });

    // Wait for the build to complete
    await new Promise((resolve) => buildStream.on('end', resolve));

    // Run the container, using its default entrypoint
    docker.run(imageName, [], process.stdout, {
        HostConfig: { AutoRemove: true }
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

    it("should intercept external JS requests", async function () {
        this.timeout(20000);
        const { interceptor, server } = await interceptorSetup;
        const mainRule = await server.get('https://example.com').thenReply(404);

        await buildAndRun('external-request-js.Dockerfile');

        await interceptor.activate(server.port);
        await delay(1000);

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
    });

});