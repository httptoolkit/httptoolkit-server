import * as _ from 'lodash';

import { FreshChrome } from './fresh-chrome';

export interface Interceptor {
    id: string;
    version: string;
    isActive: boolean;

    checkIfAvailable(): Promise<boolean>;
    activate(options?: any): Promise<void>;
    deactivate(): Promise<void>;
}

export function buildInterceptors(configPath: string): _.Dictionary<Interceptor> {
    return _.keyBy([
        new FreshChrome(configPath)
    ], (interceptor) => interceptor.id);
}