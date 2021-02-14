import * as _ from 'lodash';

import { HtkConfig } from '../config';
import { addShutdownHandler } from '../shutdown';

import { FreshFirefox } from './fresh-firefox';
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
import { DockerAllInterceptor, DockerContainerInterceptor } from './docker/docker-interceptor';
import { ElectronInterceptor } from './electron';
import { JvmInterceptor } from './jvm';

export interface Interceptor {
    id: string;
    version: string;

    getMetadata?(type: 'summary' | 'detailed'): Promise<any>;

    isActivable(): Promise<boolean>;
    activableTimeout?: number;

    isActive(proxyPort: number): boolean;

    activate(proxyPort: number, options?: any): Promise<void | {}>;

    deactivate(proxyPort: number, options?: any): Promise<void | {}>;
    deactivateAll(): Promise<void | {}>;
}

export interface ActivationError extends Error {
    metadata?: any; // Any extra metadata with the failure, e.g. if it could be retried
    reportable?: boolean; // Set to false to disable reporting this error, it's normal
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

        new FreshTerminalInterceptor(config),
        new ExistingTerminalInterceptor(config),

        new ElectronInterceptor(config),

        new AndroidAdbInterceptor(config),

        new JvmInterceptor(config),

        new DockerAllInterceptor(config),
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