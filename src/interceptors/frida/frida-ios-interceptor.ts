import _ from 'lodash';
import { UsbmuxClient } from 'usbmux-client';

import { Interceptor } from "..";
import { HtkConfig } from '../../config';

import { FridaHost, FridaTarget } from './frida-integration';
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

    private _fridaTargetsPromise: Promise<Array<FridaHost>> | undefined;
    async getFridaHosts(): Promise<Array<FridaHost>> {
        if (!this._fridaTargetsPromise) {
            // We cache the targets lookup whilst it's active, so that concurrent calls
            // all just run one lookup and return the same result.
            this._fridaTargetsPromise = getIosFridaHosts(this.usbmuxClient)
                .finally(() => { this._fridaTargetsPromise = undefined; });
        }
        return await this._fridaTargetsPromise;
    }

    async isActivable(): Promise<boolean> {
        return (await this.getFridaHosts()).length > 0;
    }

    activableTimeout = 3000; // Increase timeout for device detection slightly

    isActive(): boolean {
        return false;
    }

    async getMetadata() {
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

    async activate(
        proxyPort: number,
        options:
            | { action: 'intercept', hostId: string, targetId: string }
    ): Promise<void> {
        if (options.action === 'intercept') {
            await interceptIosFridaTarget(
                this.usbmuxClient,
                options.hostId,
                options.targetId,
                this.config.https.certContent,
                proxyPort
            );
        } else {
            throw new Error(`Unknown Frida interception command: ${(options as any).action ?? '(none)'}`)
        }
    }

    async deactivate(proxyPort: number): Promise<void | {}> {
    }

    async deactivateAll(): Promise<void | {}> {
    }

}