import _ from 'lodash';
import * as stream from 'stream';
import * as FridaJs from 'frida-js';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { createAdbClient } from '../android/adb-commands';
import { FridaHost, FridaTarget, killProcess } from './frida-integration';
import {
    getAndroidFridaHosts,
    getAndroidFridaTargets,
    interceptAndroidFridaTarget,
    launchAndroidHost,
    setupAndroidHost
} from './frida-android-integration';
import { combineParallelCalls } from '@httptoolkit/util';

export class FridaAndroidInterceptor implements Interceptor {

    id: string = "android-frida";
    version: string = "1.0.0";

    private adbClient = createAdbClient();

    constructor(
        private config: HtkConfig
    ) {}

    getFridaHosts = combineParallelCalls(() => getAndroidFridaHosts(this.adbClient));

    async isActivable(): Promise<boolean> {
        return Object.keys(await this.getFridaHosts()).length > 0;
    }

    isActive(): boolean {
        return false;
    }

    async getMetadata(): Promise<{ hosts: Record<string, FridaHost> }> {
        const fridaHosts = await this.getFridaHosts();
        return {
            hosts: fridaHosts
        };
    }

    async getSubMetadata(hostId: string): Promise<{ targets: Array<FridaTarget> }> {
        return {
            targets: await getAndroidFridaTargets(this.adbClient, hostId)
        }
    }

    private fridaServers: { [proxyPort: number]: Array<stream.Readable> } = {};
    private interceptedApps: { [proxyPort: number]: Array<FridaJs.FridaAgentSession> } = {};

    async activate(
        proxyPort: number,
        options:
            | { action: 'setup', hostId: string }
            | { action: 'launch', hostId: string }
            | { action: 'intercept', hostId: string, targetId: string }
    ): Promise<void> {
        if (options.action === 'setup') {
            await setupAndroidHost(this.config, this.adbClient, options.hostId);
        } else if (options.action === 'launch') {
            const fridaServer = await launchAndroidHost(this.adbClient, options.hostId);

            // Track this server stream, so we can close it to stop the server later
            this.fridaServers[proxyPort] = this.fridaServers[proxyPort] ?? [];
            this.fridaServers[proxyPort].push(fridaServer);
            fridaServer.on('close', () => {
                _.remove(this.fridaServers[proxyPort], fridaServer);
            });
        } else if (options.action === 'intercept') {
            const fridaSession = await interceptAndroidFridaTarget(
                this.adbClient,
                options.hostId,
                options.targetId,
                this.config.https.certContent,
                proxyPort
            );

            // Track this session, so we can close it to stop the interception later
            this.interceptedApps[proxyPort] = this.interceptedApps[proxyPort] ?? [];
            this.interceptedApps[proxyPort].push(fridaSession);
        } else {
            throw new Error(`Unknown Frida interception command: ${(options as any).action ?? '(none)'}`)
        }
    }

    async deactivate(proxyPort: number): Promise<void | {}> {
        this.fridaServers[proxyPort]?.forEach(serverStream => {
            serverStream.destroy();
        });

        const fridaSessions = this.interceptedApps[proxyPort] ?? [];

        await Promise.all(fridaSessions.map((session) =>
            killProcess(session).catch(() => {})
        ));
    }

    async deactivateAll(): Promise<void | {}> {
        const allPorts = new Set([
            ...Object.keys(this.fridaServers),
            ...Object.keys(this.interceptedApps)
        ]);

        await Promise.all(
            [...allPorts]
            .map(port => this.deactivate(Number(port)))
        );
    }

}