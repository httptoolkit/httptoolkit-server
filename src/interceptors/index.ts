import * as _ from 'lodash';

import { HtkConfig } from '../config';

import { FreshChrome } from './fresh-chrome';
import { FreshFirefox } from './fresh-firefox';

export interface Interceptor {
    id: string;
    version: string;

    isActivable(): Promise<boolean>;
    isActive(proxyPort: number): boolean;

    activate(proxyPort: number, options?: any): Promise<void>;
    deactivate(proxyPort: number, options?: any): Promise<void>;
}

export function buildInterceptors(config: HtkConfig): _.Dictionary<Interceptor> {
    return _.keyBy([
        new FreshChrome(config),
        new FreshFirefox(config)
    ], (interceptor) => interceptor.id);
}