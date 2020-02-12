import * as _ from 'lodash';

import { HtkConfig } from '../config';

import { FreshChrome } from './fresh-chrome';
import { FreshFirefox } from './fresh-firefox';
import { FreshEdge } from './fresh-edge';
import { FreshTerminalInterceptor } from './terminal/fresh-terminal-interceptor';
import { ExistingTerminalInterceptor } from './terminal/existing-terminal-interceptor';
import { AndroidAdbInterceptor } from './android/android-adb-interceptor';
import { addShutdownHandler } from '../shutdown';
import { ElectronInterceptor } from './electron';

export interface Interceptor {
    id: string;
    version: string;

    getMetadata?(): any;

    isActivable(): Promise<boolean>;
    isActive(proxyPort: number): boolean;

    activate(proxyPort: number, options?: any): Promise<void | {}>;
    deactivate(proxyPort: number, options?: any): Promise<void | {}>;
    deactivateAll(): Promise<void | {}>;
}

export function buildInterceptors(config: HtkConfig): _.Dictionary<Interceptor> {
    const interceptors = [
        new FreshChrome(config),
        new FreshFirefox(config),
        new FreshEdge(config),
        new FreshTerminalInterceptor(config),
        new ExistingTerminalInterceptor(config),
        new ElectronInterceptor(config),
        new AndroidAdbInterceptor(config)
    ];

    // When the server exits, try to shut down the interceptors too
    addShutdownHandler(() => shutdownInterceptors(interceptors));

    return _.keyBy(interceptors, (interceptor) => interceptor.id);
}

function shutdownInterceptors(interceptors: Interceptor[]) {
    return Promise.all(interceptors.map(i => i.deactivateAll()));
}