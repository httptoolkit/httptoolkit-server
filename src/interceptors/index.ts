import * as _ from 'lodash';

import { HtkConfig } from '../config';

import { FreshChrome } from './fresh-chrome';
import { FreshFirefox } from './fresh-firefox';
import { TerminalInterceptor } from './fresh-terminal';
import { addShutdownHandler } from '../shutdown';

export interface Interceptor {
    id: string;
    version: string;

    isActivable(): Promise<boolean>;
    isActive(proxyPort: number): boolean;

    activate(proxyPort: number, options?: any): Promise<void>;
    deactivate(proxyPort: number, options?: any): Promise<void>;
    deactivateAll(): Promise<void>;
}

export function buildInterceptors(config: HtkConfig): _.Dictionary<Interceptor> {
    const interceptors = [
        new FreshChrome(config),
        new FreshFirefox(config),
        new TerminalInterceptor(config)
    ];

    // When the server exits, try to shut down the interceptors too
    addShutdownHandler(() => shutdownInterceptors(interceptors));

    return _.keyBy(interceptors, (interceptor) => interceptor.id);
}

function shutdownInterceptors(interceptors: Interceptor[]) {
    return Promise.all(interceptors.map(i => i.deactivateAll()));
}