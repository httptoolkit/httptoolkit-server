import _ from 'lodash';
import { ErrorLike } from '@httptoolkit/util';

import { HtkConfig } from '../config';
import { addShutdownHandler } from '../shutdown';

import { FreshFirefox, FreshFirefoxDeveloper, FreshFirefoxNightly } from './fresh-firefox';
import {
    FreshChrome,
    ExistingChrome,
    FreshChromeBeta,
    FreshChromeCanary,
    FreshChromeDev,
    FreshChromium,
    FreshChromiumDev,
    FreshEdge,
    FreshEdgeBeta,
    FreshEdgeDev,
    FreshEdgeCanary,
    FreshBrave,
    FreshOpera
} from './chromium-based-interceptors';
import { FreshTerminalInterceptor } from './terminal/fresh-terminal-interceptor';
import { ExistingTerminalInterceptor } from './terminal/existing-terminal-interceptor';
import { AndroidAdbInterceptor } from './android/android-adb-interceptor';
import { DockerContainerInterceptor } from './docker/docker-interceptor';
import { ElectronInterceptor } from './electron';
import { JvmInterceptor } from './jvm';
import { FridaAndroidInterceptor } from './frida/frida-android-interceptor';
import { FridaIosInterceptor } from './frida/frida-ios-interceptor';

export interface Interceptor {
    id: string;
    version: string;

    getMetadata?(type: 'summary' | 'detailed'): Promise<any>;
    getSubMetadata?(subId: string): Promise<any>;

    isActivable(): Promise<boolean>;
    activableTimeout?: number;

    isActive(proxyPort: number): Promise<boolean> | boolean;

    activate(proxyPort: number, options?: any): Promise<void | {}>;

    deactivate(proxyPort: number, options?: any): Promise<void | {}>;
    deactivateAll(): Promise<void | {}>;
}

export interface ActivationError extends ErrorLike {
    /**
     * Activation errors can have an extra `metadata` field, to share data with the
     * client which attempted the activation, e.g. whether it can be retried.
     */
    metadata?: any;

    /**
     * Errors should be thrown with reportable set to `false` if they're a 'normal'
     * event that shouldn't be logged or exposed to the user. For example, if it's a
     * temporary failure that will lead to a confirmation flow or similar.
     *
     * This disables error logging and reporting of failure details from the API
     * (it assumes that the metadata will expose any info required, since this is a
     * recognized failure case).
     */
    reportable?: boolean;
}

export function buildInterceptors(config: HtkConfig): _.Dictionary<Interceptor> {
    const interceptors = [
        new FreshChrome(config),
        new ExistingChrome(config),
        new FreshChromeBeta(config),
        new FreshChromeDev(config),
        new FreshChromeCanary(config),

        new FreshChromium(config),
        new FreshChromiumDev(config),

        new FreshEdge(config),
        new FreshEdgeBeta(config),
        new FreshEdgeDev(config),
        new FreshEdgeCanary(config),

        new FreshOpera(config),
        new FreshBrave(config),
        new FreshFirefox(config),
        new FreshFirefoxDeveloper(config),
        new FreshFirefoxNightly(config),

        new FreshTerminalInterceptor(config),
        new ExistingTerminalInterceptor(config),

        new ElectronInterceptor(config),

        new AndroidAdbInterceptor(config),
        new FridaAndroidInterceptor(config),
        new FridaIosInterceptor(config),

        new JvmInterceptor(config),
        new DockerContainerInterceptor(config)
    ];

    // When the server exits, try to shut down the interceptors too
    addShutdownHandler(() => shutdownInterceptors(interceptors));

    const interceptorIndex = _.keyBy(interceptors, (interceptor) => interceptor.id);

    if (Object.keys(interceptorIndex).length !== interceptors.length) {
        throw new Error('Duplicate interceptor id');
    }

    return interceptorIndex;
}

function shutdownInterceptors(interceptors: Interceptor[]) {
    return Promise.all(interceptors.map(i => i.deactivateAll()));
}