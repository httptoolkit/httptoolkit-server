import * as net from 'net';
import { expect } from 'chai';
import adb from '@devicefarmer/adbkit';
import { delay } from '@httptoolkit/util';

import {
    isDevicePortOpen,
    isProbablyRooted,
    run
} from '../../src/interceptors/android/adb-commands';

type ServiceHandler = (service: string, socket: net.Socket) => void;

// A fake ADB server, which accepts transport requests for any device, and then
// passes each device service request to the current test's handler.
async function startFakeAdbServer(
    handler: ServiceHandler,
    options: { answerTransport: () => boolean }
) {
    const openSockets = new Set<net.Socket>();

    const server = net.createServer((socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
        socket.on('error', () => {});

        let buffer = Buffer.alloc(0);
        socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            while (buffer.length >= 4) {
                const length = parseInt(buffer.subarray(0, 4).toString('ascii'), 16);
                if (buffer.length < 4 + length) break;
                const request = buffer.subarray(4, 4 + length).toString('utf8');
                buffer = buffer.subarray(4 + length);

                if (request.startsWith('host:transport:')) {
                    if (options.answerTransport()) socket.write('OKAY');
                } else {
                    handler(request, socket);
                }
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        client: adb.createClient({ port: (server.address() as net.AddressInfo).port }),
        openSockets,
        stop: async () => {
            openSockets.forEach((socket) => socket.destroy());
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

async function expectAllClosed(openSockets: Set<net.Socket>) {
    for (let i = 0; i < 20 && openSockets.size > 0; i++) await delay(10);
    expect(openSockets.size).to.equal(0);
}

describe("ADB connection management", function () {
    this.timeout(5000);

    let fakeAdb: Awaited<ReturnType<typeof startFakeAdbServer>> | undefined;
    let handler: ServiceHandler;
    let answerTransport: boolean;

    beforeEach(async () => {
        handler = () => {};
        answerTransport = true;
        fakeAdb = await startFakeAdbServer(
            (service, socket) => handler(service, socket),
            { answerTransport: () => answerTransport }
        );
    });

    afterEach(async () => {
        await fakeAdb?.stop();
        fakeAdb = undefined;
    });

    it("detects an open device port, and closes the connection", async () => {
        handler = (_service, socket) => socket.write('OKAY');
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isDevicePortOpen(device, 1234)).to.equal(true);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("detects a closed device port, and closes the connection", async () => {
        handler = (_service, socket) => socket.write('FAIL0006closed');
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isDevicePortOpen(device, 1234)).to.equal(false);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("closes port checks that never respond", async () => {
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isDevicePortOpen(device, 1234)).to.equal(false);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("closes port checks that respond after timing out", async () => {
        const services: string[] = [];
        handler = (service, socket) => {
            services.push(service);
            setTimeout(() => socket.write('OKAY'), 1200);
        };
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isDevicePortOpen(device, 1234)).to.equal(false);
        expect(services).to.deep.equal(['tcp:1234']);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("reads shell command results, and closes the connection", async () => {
        handler = (_service, socket) => socket.end('OKAYuid=0(root) gid=0(root)\n');
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isProbablyRooted(device)).to.equal(true);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("closes shell commands that time out", async () => {
        const services: string[] = [];
        handler = (service, socket) => {
            services.push(service);
            socket.write('OKAY'); // Started, but never completes
        };
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isProbablyRooted(device)).to.equal(false);
        expect(services).to.deep.equal([
            "shell:'command' '-v' 'su'",
            "shell:'id'"
        ]);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("closes probes whose device transport is never connected", async () => {
        answerTransport = false;
        const device = fakeAdb!.client.getDevice('test-device');

        expect(await isDevicePortOpen(device, 1234)).to.equal(false);
        await expectAllClosed(fakeAdb!.openSockets);
    });

    it("lets other timed-out commands run to completion", async () => {
        let completeCommand: (() => void) | undefined;
        handler = (_service, socket) => {
            socket.write('OKAY');
            completeCommand = () => socket.end('done\n');
        };
        const device = fakeAdb!.client.getDevice('test-device');

        const result = await run(device, ['some-command'], { timeout: 100, skipLogging: true })
            .catch((e) => e);
        expect(result).to.be.instanceOf(Error);

        await delay(200);
        expect(fakeAdb!.openSockets.size).to.equal(1);

        completeCommand!();
        await expectAllClosed(fakeAdb!.openSockets);
    });
});
