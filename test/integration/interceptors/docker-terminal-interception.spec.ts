import _ from 'lodash';
import * as path from 'path';
import * as childProc from 'child_process';
import Docker from 'dockerode';
import { ProxySettingCallback } from 'mockttp';

import { expect } from 'chai';
import { delay } from '@httptoolkit/util';

import { setupTest } from './interceptor-test-utils';
import { FIXTURES_DIR } from '../../test-util';
import { spawnToResult } from '../../../src/util/process-management';

import { getTerminalEnvVars } from '../../../src/interceptors/terminal/terminal-env-overrides';

import {
    startDockerInterceptionServices,
    stopDockerInterceptionServices
} from '../../../src/interceptors/docker/docker-interception-services';

const testSetup = setupTest();

describe('Docker CLI interception', function () {
    this.timeout(20000);

    // We simulate standalone rule param config, by just writing & reading from this mutable object:
    const ruleParams: {
        [key: `docker-tunnel-proxy-${number}`]: ProxySettingCallback
    } = {};

    beforeEach(async () => {
        const { server, httpsConfig } = await testSetup;
        await server.start();
        await startDockerInterceptionServices(server.port, httpsConfig, ruleParams);
    });

    afterEach(async () => {
        const { server } = await testSetup;
        await stopDockerInterceptionServices(server.port, ruleParams);
        await server.stop();
    });

    [
        'JS',
        'Java',
        'Python',
        'Ruby',
        'Go'
    ].forEach((target) => {
        it(`should intercept 'docker run' of local ${target} containers`, async function () {
            this.timeout(60000);

            // Build the target image (may already have been built by the attachment tests)
            const { exitCode: buildExitCode, stdout: buildStdout } = await spawnToResult(
                'docker', ['build', '.', '-q'],
                { cwd: path.join(FIXTURES_DIR, 'docker', target.toLowerCase()) },
                true
            );

            expect(buildExitCode).to.equal(0);
            const imageId = buildStdout.trim();

            // Run the resulting container via the intercepting Docker proxy:
            const { server, httpsConfig} = await testSetup;
            const mainRule = await server.forGet('https://example.test').thenReply(200);

            const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

            childProc.spawn(
                'docker', ['run', '--rm', imageId, 'https://example.test'],
                {
                    env: { ...process.env, ...terminalEnvOverrides },
                    stdio: 'inherit'
                }
            );

            await new Promise((resolve) => server.on('response', resolve));

            const seenRequests = await mainRule.getSeenRequests();
            expect(seenRequests.map(r => r.url)).to.include('https://example.test/');

            // Clean up the container (which will otherwise run forever):
            const docker = new Docker();
            const containers = await docker.listContainers({
                filters: JSON.stringify({ ancestor: [imageId] })
            });
            await Promise.all(
                containers.map((container) => docker.getContainer(container.Id).kill())
            );
        });
    });

    it("should intercept 'docker run' launching a remote image", async () => {
        const { server, httpsConfig } = await testSetup;

        const mainRule = await server.forGet("https://example.test").thenReply(200);

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const { exitCode, stdout, stderr } = await spawnToResult(
            'docker', ['run', '--rm', 'node:14', '-e', `require("https").get("https://example.test")`],
            { env: { ...process.env, ...terminalEnvOverrides } },
            true
        );

        expect(exitCode).to.equal(0);
        expect(stdout).to.equal('');
        expect(stderr).to.equal('');

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.length).to.equal(1);
        expect(seenRequests[0].url).to.equal("https://example.test/");
    });

    it("should intercept 'docker build'", async function () {
        this.timeout(30000);

        const { server, httpsConfig } = await testSetup;

        const mainRule = await server.forAnyRequest().thenReply(200, "Mock response\n");

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const { exitCode, stdout, stderr } = await spawnToResult('docker', ['build', '.'], {
            env: { ...process.env, ...terminalEnvOverrides },
            cwd: path.join(FIXTURES_DIR, 'docker', 'requests-in-build')
        }, true);

        expect(exitCode).to.equal(0);

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.length).to.equal(3);
        expect(seenRequests.map(r => r.url)).to.deep.equal([
            "https://base-request.test/",
            "https://base2-request.test/",
            "https://final-stage-request.test/"
        ]);

        expect(
            stdout.replace(
                // Replace hashes with <hash> in every place docker might use them:
                /(?<=(--->|---> Running in|Removing intermediate container|Successfully built) )[a-z0-9]{12}/g,
                '<hash>'
            )
        ).to.equal(
`Sending build context to Docker daemon  3.072kB\r\r
Step 1/8 : FROM node:14 as base-image
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 2/8 : RUN curl -s https://base-request.test
 ---> Running in <hash>
Mock response
Removing intermediate container <hash>
 ---> <hash>
Step 3/8 : FROM node:14 as base-image-2
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 4/8 : COPY . .
 ---> <hash>
Step 5/8 : RUN curl -s https://base2-request.test
 ---> Running in <hash>
Mock response
Removing intermediate container <hash>
 ---> <hash>
Step 6/8 : FROM base-image
 ---> <hash>
 *** Enabling HTTP Toolkit interception ***
 ---> <hash>
Step 7/8 : COPY --from=base-image-2 make-request.js .
 ---> <hash>
Step 8/8 : RUN node ./make-request.js https://final-stage-request.test
 ---> Running in <hash>
Making request to https://final-stage-request.test
Got 200 response
Removing intermediate container <hash>
 ---> <hash>
Successfully built <hash>
`
        );
        expect(stderr).to.equal('');
    });

    it("should support proxying 'docker exec'", async function () {
        const { server, httpsConfig } = await testSetup;

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        // Launch a background Node.js container that stays running for 10 seconds
        const runResult = await spawnToResult(
            'docker', ['run', '-d', '--rm', 'node:14', '-e', 'setTimeout(() => {}, 10000000)'],
            {
                env: { ...process.env, ...terminalEnvOverrides }
            }
        );

        expect(runResult.exitCode).to.equal(0);
        const containerId = runResult.stdout.trim();

        const execResult = await spawnToResult(
            'docker', ['exec', containerId, 'node', '-e', 'console.log("exec" + "-test-" + "output")'],
            {
                env: { ...process.env, ...terminalEnvOverrides },
            }
        );

        expect(execResult.exitCode).to.equal(0);
        expect(execResult.stderr).to.equal('');
        expect(execResult.stdout).to.include('exec-test-output'); // Executed command is run & output returned
    });

    it("should intercept 'docker-compose up'", async function () {
        this.timeout(30000);

        const { server, httpsConfig, getPassThroughOptions } = await testSetup;
        const externalRule = await server.forAnyRequest()
            .forHost("example.test")
            .thenReply(200, "Mock response");
        const internalRule = await server
            .forUnmatchedRequest()
            .thenPassThrough({
                proxyConfig: ruleParams[`docker-tunnel-proxy-${server.port}`],
                ...(await getPassThroughOptions())
            });

        // Create non-intercepted docker-compose containers, like normal use:
        const composeRoot = path.join(FIXTURES_DIR, 'docker', 'compose');
        await spawnToResult(
            'docker-compose', ['create', '--force-recreate', '--build'],
            { cwd: composeRoot },
            true
        );

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        // "DC Up" the same project, but in an intercepted env. Should ignore the existing containers,
        // create new intercepted containers, and then up those as normal.
        const { exitCode, stdout } = await spawnToResult(
            'docker-compose', ['up'],
            {
                env: { ...process.env, ...terminalEnvOverrides },
                cwd: composeRoot
            },
            true
        );

        expect(exitCode).to.equal(0);
        expect(stdout).to.include("All requests ok");

        const seenExternalRequests = await externalRule.getSeenRequests();
        expect(seenExternalRequests.length).to.be.gte(2);

        const seenInternalRequests = await internalRule.getSeenRequests();
        const seenInternalUrls = seenInternalRequests.map(r => r.url);
        expect(seenInternalUrls).to.include("http://service-a:9876/");
        expect(seenInternalUrls).to.include("http://service-b:9876/");
        expect(seenInternalUrls).to.include("http://localhost:9876/");
        expect(seenInternalUrls).to.include("http://127.0.0.1:9876/");
    });

    it.skip("should intercept all network modes", async function () {
        this.timeout(30000);

        const { server, httpsConfig, getPassThroughOptions } = await testSetup;
        await server.forAnyRequest()
            .forHost("example.test")
            .thenReply(200, "Mock response");
        await server
            .forUnmatchedRequest()
            .thenPassThrough({
                proxyConfig: ruleParams[`docker-tunnel-proxy-${server.port}`],
                ...(await getPassThroughOptions())
            });

        // Create non-intercepted docker-compose containers, like normal use:
        const composeRoot = path.join(FIXTURES_DIR, 'docker', 'compose');
        await spawnToResult(
            'docker-compose', ['-f', 'docker-compose.networks.yml', 'create', '--force-recreate', '--build'],
            { cwd: composeRoot },
            true
        );

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        // "DC Up" the same project, but in an intercepted env. Should ignore the existing containers,
        // create new intercepted containers, and then up those as normal.
        const { exitCode, stdout } = await spawnToResult(
            'docker-compose', ['-f', 'docker-compose.networks.yml', 'up'],
            {
                env: { ...process.env, ...terminalEnvOverrides },
                cwd: composeRoot
            },
            true
        );

        expect(exitCode).to.equal(0);

        const dcOutput = stdout
            .replace(/\u001b\[\d+m/g, '') // Strip terminal colour commands
            .replace(/\s+\|/g, ' |'); // Strip container name variable whitespace

        [
            `host_1`,
            `default-service-a_1`,
            `default-linked-service-b_1`,
            `extra-host-service_1`,
            `multi-network-a_1`,
            `multi-network-b_1`
        ].forEach((container) => {
            expect(dcOutput).to.include(`${container} | All requests ok`);
        });
        expect(dcOutput).to.include(`none_1 | Skipping`);
    });

    it("should clean up containers after shutdown", async () => {
        const { server, httpsConfig } = await testSetup;

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const uninterceptedResult = await spawnToResult('docker', ['create', 'node:14']);

        expect(uninterceptedResult.exitCode).to.equal(0);
        expect(uninterceptedResult.stderr).to.equal('');
        const uninterceptedContainerId = uninterceptedResult.stdout.trim();

        const interceptedResult = await spawnToResult(
            'docker', ['create', 'node:14'],
            { env: { ...process.env, ...terminalEnvOverrides } },
            true
        );

        expect(interceptedResult.exitCode).to.equal(0);
        expect(interceptedResult.stderr).to.equal('');

        const interceptedContainerId = interceptedResult.stdout.trim();

        const docker = new Docker();
        const interceptedContainer = await docker.getContainer(interceptedContainerId).inspect();
        expect(interceptedContainer.Config.Image).to.equal('node:14');

        const uninterceptedContainer = await docker.getContainer(uninterceptedContainerId).inspect();
        expect(uninterceptedContainer.Config.Image).to.equal('node:14');

        await stopDockerInterceptionServices(server.port, ruleParams);

        // Intercepted container is removed:
        const inspectResultAfterShutdown: unknown = await docker.getContainer(interceptedContainerId).inspect().catch(e => e);
        expect(inspectResultAfterShutdown).to.be.instanceOf(Error)
        expect((inspectResultAfterShutdown as Error).message).to.include("no such container");

        // Unintercepted container is not touched:
        const uninterceptedContainerAfterShutdown = await docker.getContainer(uninterceptedContainerId).inspect();
        expect(uninterceptedContainerAfterShutdown.Config.Image).to.equal('node:14');
    });

    it("should start & clean up tunnel automatically", async () => {
        const { server, httpsConfig } = await testSetup;
        const docker = new Docker();

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        // Tunnel doesn't start preemptively:
        await delay(500);
        let tunnel = await docker.getContainer(`httptoolkit-docker-tunnel-${server.port}`).inspect().catch(e => e);
        expect(tunnel).to.be.instanceOf(Error)
        expect((tunnel as Error).message).to.include("no such container");

        // Then launch an intercepted container:
        const interceptedResult = await spawnToResult(
            'docker', ['create', 'node:14'],
            { env: { ...process.env, ...terminalEnvOverrides } },
            true
        );

        expect(interceptedResult.exitCode).to.equal(0);
        expect(interceptedResult.stderr).to.equal('');

        await delay(100); // There can be a brief delay in CI in starting the tunnel itself

        // Tunnel is now running:
        tunnel = await docker.getContainer(`httptoolkit-docker-tunnel-${server.port}`).inspect();
        expect(tunnel.Config.Image.split(':')[0]).to.equal('httptoolkit/docker-socks-tunnel');

        // Then shut everything down:
        await stopDockerInterceptionServices(server.port, ruleParams);

        // Tunnel is automatically removed:
        tunnel = await docker.getContainer(`httptoolkit-docker-tunnel-${server.port}`).inspect().catch(e => e);
        expect(tunnel).to.be.instanceOf(Error)
        expect((tunnel as Error).message).to.include("no such container");
    });

});
