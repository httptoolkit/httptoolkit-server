import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { getRemote } from 'mockttp';
import * as request from 'request-promise-native';

import { delay } from '../src/util';
import { expect } from 'chai';

describe('Integration test', function () {
    this.timeout(10000);

    let serverProcess: ChildProcess;
    let stdout = '';
    let stderr = '';

    beforeEach(async () => {
        serverProcess = spawn(path.join(__dirname, '..', 'bin', 'run'), ['start'], {
            stdio: 'pipe'
        });
        stdout = "";
        stderr = "";

        serverProcess.stdout.on('data', (d) => stdout = stdout + d.toString());
        serverProcess.stderr.on('data', (d) => stderr = stderr + d.toString());

        await delay(5000);
    });

    afterEach(() => {
        if (!serverProcess.killed) serverProcess.kill();
        expect(stderr).to.equal('');
    });

    it('starts and stops successfully', async () => {
        serverProcess.kill();

        expect(stderr).to.equal('');
        expect(stdout).to.equal('Server started\n');
    });

    it('starts a Mockttp server', async () => {
        const mockttp = getRemote();
        await mockttp.start();
        await mockttp.get('https://google.com').thenReply(200, 'Mock response');

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const response = await request.get('https://google.com', { proxy: mockttp.url });
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        expect(response).to.equal('Mock response');
    });
});