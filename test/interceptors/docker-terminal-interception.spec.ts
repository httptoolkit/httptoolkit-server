import * as _ from 'lodash';
import * as path from 'path';

import { expect } from 'chai';

import { setupTest } from './interceptor-test-utils';
import { spawnToResult } from '../../src/process-management';
import { createDockerProxy } from '../../src/interceptors/docker/docker-proxy';
import { DestroyableServer } from '../../src/destroyable-server';

import { getTerminalEnvVars } from '../../src/interceptors/terminal/terminal-env-overrides';

const testSetup = setupTest();

describe('Docker CLI interception', function () {
    this.timeout(20000);

    let dockerProxy: DestroyableServer;

    beforeEach(async () => {
        const { server, httpsConfig } = await testSetup;
        await server.start();

        dockerProxy = await createDockerProxy(server.port, httpsConfig);
    });

    afterEach(async () => {
        const { server } = await testSetup;
        await server.stop();
        await dockerProxy.destroy();
    });

    it("should intercept 'docker run'", async () => {
        const { server, httpsConfig } = await testSetup;

        const mainRule = await server.get("https://example.test").thenReply(200);

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

        const mainRule = await server.anyRequest().thenReply(200);

        const terminalEnvOverrides = getTerminalEnvVars(server.port, httpsConfig, process.env);

        const { exitCode, stdout, stderr } = await spawnToResult('docker', ['build', '.'], {
            env: { ...process.env, ...terminalEnvOverrides },
            cwd: path.join(__dirname, '..', 'fixtures', 'docker', 'requests-in-build')
        }, true);

        expect(exitCode).to.equal(0);

        const seenRequests = await mainRule.getSeenRequests();
        expect(seenRequests.length).to.equal(3);
        expect(seenRequests.map(r => r.url)).to.deep.equal([
            "https://base-request.test/",
            "https://base2-request.test/",
            "https://final-stage-request.test/"
        ]);
    });

});