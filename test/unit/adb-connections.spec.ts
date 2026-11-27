import * as net from 'net';
import { expect } from 'chai';
import adb from '@devicefarmer/adbkit';
import { delay } from '@httptoolkit/util';

import {
    grantPermissions,
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

    describe("permission grants", () => {
        const PERMISSIONS = ['android.permission.A', 'android.permission.B'];
        let services: string[];
        let replies: { [command: string]: string | undefined };

        beforeEach(() => {
            services = [];
            replies = {};
            handler = (service, socket) => {
                services.push(service);
                const reply = Object.entries(replies).find(([command]) => service.includes(command))?.[1];
                if (reply === undefined) socket.end('OKAY');
                else if (reply !== 'HANG') socket.end('OKAY' + reply);
                else socket.write('OKAY');
            };
        });

        it("grants permissions", async () => {
            const device = fakeAdb!.client.getDevice('test-device');

            const result = await grantPermissions(device, 'test.app', PERMISSIONS);

            expect(result).to.deep.equal({ granted: PERMISSIONS, failed: [] });
            expect(services.sort()).to.deep.equal([
                "shell:'pm' 'grant' 'test.app' 'android.permission.A'",
                "shell:'pm' 'grant' 'test.app' 'android.permission.B'"
            ]);
            await expectAllClosed(fakeAdb!.openSockets);
        });

        it("reports permissions that can't be granted, without failing the others", async () => {
            replies = {
                'android.permission.A': "\nException occurred while executing 'grant':\n" +
                    "java.lang.IllegalArgumentException: Unknown permission android.permission.A\n" +
                    "\tat com.android.server.SomeClass.method(SomeClass.java:1)\n"
            };
            const device = fakeAdb!.client.getDevice('test-device');

            const result = await grantPermissions(device, 'test.app', PERMISSIONS);

            expect(result).to.deep.equal({
                granted: ['android.permission.B'],
                failed: ['android.permission.A']
            });
        });

        it("reports policy-blocked grants as failures", async () => {
            replies = {
                'grant': 'Security exception: Cannot grant policy fixed permission\n'
            };
            const device = fakeAdb!.client.getDevice('test-device');

            const result = await grantPermissions(device, 'test.app', PERMISSIONS);

            expect(result).to.deep.equal({ granted: [], failed: PERMISSIONS });
        });

        it("gives up on devices that never respond, and closes the connections", async function () {
            this.timeout(10000);
            replies = { 'grant': 'HANG' };
            const device = fakeAdb!.client.getDevice('test-device');

            const result = await grantPermissions(device, 'test.app', PERMISSIONS);

            expect(result).to.deep.equal({ granted: [], failed: PERMISSIONS });
            await expectAllClosed(fakeAdb!.openSockets);
        });

        it("reports failures if the connection drops", async () => {
            handler = (service, socket) => {
                services.push(service);
                socket.destroy();
            };
            const device = fakeAdb!.client.getDevice('test-device');

            const result = await grantPermissions(device, 'test.app', PERMISSIONS);

            expect(result).to.deep.equal({ granted: [], failed: PERMISSIONS });
            await expectAllClosed(fakeAdb!.openSockets);
        });
    });
});
