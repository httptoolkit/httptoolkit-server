import _ from 'lodash';
import { UsbmuxClient } from 'usbmux-client';
import * as FridaJs from 'frida-js';
import { combineParallelCalls } from '@httptoolkit/util';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { FridaHost, FridaTarget, killProcess } from './frida-integration';
import {
    getIosFridaHosts,
    getIosFridaTargets,
    interceptIosFridaTarget
} from './frida-ios-integration';

export class FridaIosInterceptor implements Interceptor {

    id: string = "ios-frida";
    version: string = "1.0.0";

    private usbmuxClient = new UsbmuxClient();

    constructor(
        private config: HtkConfig
    ) {}

    getFridaHosts = combineParallelCalls(() => getIosFridaHosts(this.usbmuxClient));

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
            targets: await getIosFridaTargets(this.usbmuxClient, hostId)
        }
    }

    private interceptedApps: { [proxyPort: number]: Array<FridaJs.FridaAgentSession> } = {};

    async activate(
        proxyPort: number,
        options:
            | { action: 'intercept', hostId: string, targetId: string }
    ): Promise<void> {
        if (options.action === 'intercept') {
            const fridaSession = await interceptIosFridaTarget(
                this.usbmuxClient,
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
        await Promise.all(this.interceptedApps[proxyPort]?.map(async fridaSession => {
            await killProcess(fridaSession).catch(() => {});
        }));
    }

    async deactivateAll(): Promise<void | {}> {
        await Promise.all(
            Object.keys(this.interceptedApps)
            .map(port => this.deactivate(Number(port)))
        );
    }

}