import _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';

import { expect } from 'chai';

import { delay } from '@httptoolkit/util';
import Docker from 'dockerode';
import fetch from 'node-fetch';

import { FIXTURES_DIR } from '../../test-util';
import { setupInterceptor, itIsAvailable } from './interceptor-test-utils';
import { waitForDockerStream } from '../../../src/interceptors/docker/docker-utils';

const docker = new Docker();
const DOCKER_FIXTURES = path.join(FIXTURES_DIR, 'docker');

async function buildAndRun(dockerFolder: string, options: {
    arguments?: string[],
    attach?: boolean,
    portBindings?: { [key: string]: {} },
} = {}) {
    const shouldAttach = options.attach ?? true;
    const containerArguments = options.arguments ?? [];
    const portBindings = options.portBindings ?? {};

    const imageName = `test-${dockerFolder}:latest`;

    const dockerContext = {
        context: path.join(DOCKER_FIXTURES, dockerFolder),
        src: fs.readdirSync(path.join(DOCKER_FIXTURES, dockerFolder)),
    };

    const buildStream = await docker.buildImage(dockerContext, {
        dockerfile: 'Dockerfile',
        t: imageName
    });

    buildStream.on('data', (output: Buffer) => {
        output.toString().split('\n').filter(line => !!line).forEach((line) => {
            const data = JSON.parse(line);
            if (data.stream) console.log(data.stream.replace(/\n$/, ''));
        });
    });

    await waitForDockerStream(docker, buildStream);
    console.log(`${dockerFolder} image built`);

    // Run the container, using its default entrypoint
    const container = await docker.createContainer({
        Image: imageName,
        HostConfig: {
            AutoRemove: true,
            PortBindings: portBindings
        },
        Cmd: containerArguments,
        Tty: shouldAttach
    });

    let startupPromise: Promise<void>
    if (shouldAttach) {
        const stream = await container.attach({
            stream: true,
            stdout: true,
            stderr: true
        });

        stream.setEncoding('utf8');
        stream.pipe(process.stdout);

        // The promise that docker.run returns waits for the container to *finish*. To wait until
        // the container has started, we wait for the first stream output:
        startupPromise = new Promise((resolve) => stream.on('data', resolve));
    } else {
        // When we can't attach to wait for input (e.g. PHP Apache, where window events cause
        // problems) we just wait briefly instead:
        startupPromise = delay(500);
    }

    console.log('Container created');

    await container.start();
    await startupPromise;

    return container.id;
}

async function killAllContainers() {
    const containers = await docker.listContainers()
    await Promise.all(containers.map(c =>
        docker.getContainer(c.Id).stop({ t: 0 })
    ));
}

const interceptorSetup = setupInterceptor('docker-attach');

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
            const mainRule = await server.forGet('https://example.com').thenReply(404);

            const containerId = await buildAndRun(target.toLowerCase(), {
                arguments: ['https://example.com']
            });

            await delay(500);
            expect(
                _.map(((await interceptor.getMetadata!('summary')).targets), ({ id }: any) => id)
            ).to.include(containerId);

            await interceptor.activate(server.port, { containerId });
            console.log('Container intercepted');
            await new Promise((resolve) => server.on('response', resolve));

            const seenRequests = await mainRule.getSeenRequests();
            expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
        });
    });

    // PHP is a special case: we have to make a request to trigger it:
    it(`should intercept external PHP requests`, async function () {
        this.timeout(60000);
        const { interceptor, server } = await interceptorSetup;
        const mainRule = await server.forGet('https://example.com').thenReply(404);

        const containerId = await buildAndRun('php', {
            attach: false,
            portBindings: { '80/tcp': [{ HostPort: '48080' }] }
        });

        await delay(500);
        expect(
            _.map(((await interceptor.getMetadata!('summary')).targets), ({ id }: any) => id)
        ).to.include(containerId);

        await interceptor.activate(server.port, { containerId });
        console.log('Container intercepted');

        await delay(500);
        fetch('http://localhost:48080/?target=https://example.com')
            .catch(() => {});

        // Wait for the resulting request to example.com:
        await new Promise((resolve) => server.on('response', resolve));

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.map(r => r.url)).to.include('https://example.com/');
    });

});