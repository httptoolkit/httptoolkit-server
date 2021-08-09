import * as _ from 'lodash';
import * as os from 'os';
import * as events from 'events';
import * as express from 'express';
import * as cors from 'cors';
import corsGate = require('cors-gate');
import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLScalarType } from 'graphql';
import { graphqlHTTP } from 'express-graphql';

import { generateSPKIFingerprint } from 'mockttp';
import { getSystemProxy } from 'os-proxy-config';

import { HtkConfig } from './config';
import { reportError, addBreadcrumb } from './error-tracking';
import { buildInterceptors, Interceptor, ActivationError } from './interceptors';
import { ALLOWED_ORIGINS } from './constants';
import { delay } from './util/promise';

const ENABLE_PLAYGROUND = false;

const packageJson = require('../package.json');

/**
 * This file contains the core server API, used by the UI to query
 * machine state that isn't easily visible from the web (cert files,
 * network interfaces), and to launch intercepted applications
 * directly on this machine.
 *
 * This is a very powerful API! It's not far from remote code
 * execution. Because of that, access is tightly controlled:
 * - Only listens on 127.0.0.1
 * - All requests must include an acceptable Origin header, i.e.
 *   no browsers requests except from a strict whitelist of valid
 *   origins. In prod, that's just app.httptoolkit.tech.
 * - Optionally (always set in the HTK app) requires an auth
 *   token with every request, provided by $HTK_SERVER_TOKEN or
 *   --token at startup.
 */

const typeDefs = `
    type Query {
        version: String!
        config: InterceptionConfig!
        interceptors: [Interceptor!]!
        interceptor(id: ID!): Interceptor!
        networkInterfaces: Json
        systemProxy: Proxy
    }

    type Mutation {
        activateInterceptor(
            id: ID!,
            proxyPort: Int!,
            options: Json
        ): Json
        deactivateInterceptor(
            id: ID!,
            proxyPort: Int!
        ): Boolean!
        triggerUpdate: Void
    }

    type InterceptionConfig {
        certificatePath: String!
        certificateContent: String!
        certificateFingerprint: String!
    }

    type Interceptor {
        id: ID!
        version: String!
        metadata(type: MetadataType): Json

        isActivable: Boolean!
        isActive(proxyPort: Int!): Boolean!
    }

    type Proxy {
        proxyUrl: String!
        noProxy: [String!]
    }

    enum MetadataType {
        SUMMARY,
        DETAILED
    }

    scalar Json
    scalar Error
    scalar Void
`;

// Wait for a promise, falling back to defaultValue on error or timeout
const withFallback = <R>(p: Promise<R>, timeoutMs: number, defaultValue: R) =>
    Promise.race([
        p.catch((error) => {
            reportError(error);
            return defaultValue;
        }),
        delay(timeoutMs).then(() => defaultValue)
    ]);

const isActivationError = (value: any): value is ActivationError => _.isError(value);

const INTERCEPTOR_TIMEOUT = 1000;

const buildResolvers = (
    config: HtkConfig,
    interceptors: _.Dictionary<Interceptor>,
    eventEmitter: events.EventEmitter
) => {
    return {
        Query: {
            version: () => packageJson.version,
            interceptors: () => _.values(interceptors),
            interceptor: (_: any, { id } : { id: string }) => interceptors[id],
            config: () => ({
                certificatePath: config.https.certPath,
                certificateContent: config.https.certContent,
                // We could calculate this client side, but it normally requires node-forge or
                // some other heavyweight crypto lib, and we already have that here, so it's
                // convenient to do it up front.
                certificateFingerprint: generateSPKIFingerprint(config.https.certContent)
            }),
            networkInterfaces: () => os.networkInterfaces(),
            systemProxy: () => getSystemProxy().catch((e) => {
                reportError(e);
                return undefined;
            })
        },

        Mutation: {
            activateInterceptor: async (__: void, { id, proxyPort, options }: {
                id: string,
                proxyPort: number,
                options: unknown
            }) => {
                addBreadcrumb(`Activating ${id}`, { category: 'interceptor', data: { id, options } });

                const interceptor = interceptors[id];
                if (!interceptor) throw new Error(`Unknown interceptor ${id}`);

                // After 30s, don't stop activating, but report an error if we're not done yet
                let activationDone = false;
                delay(30000).then(() => {
                    if (!activationDone) reportError(`Timeout activating ${id}`)
                });

                const result = await interceptor.activate(proxyPort, options).catch((e) => e);
                activationDone = true;

                if (isActivationError(result)) {
                    if (result.reportable !== false) reportError(result);
                    return { success: false, metadata: result.metadata };
                } else {
                    addBreadcrumb(`Successfully activated ${id}`, { category: 'interceptor' });
                    return { success: true, metadata: result };
                }
            },
            deactivateInterceptor: async (__: void, { id, proxyPort, options }: {
                id: string,
                proxyPort: number,
                options: unknown
            }) => {
                const interceptor = interceptors[id];
                if (!interceptor) throw new Error(`Unknown interceptor ${id}`);

                await interceptor.deactivate(proxyPort, options).catch(reportError);
                return { success: !interceptor.isActive(proxyPort) };
            },
            triggerUpdate: () => {
                eventEmitter.emit('update-requested');
            }
        },

        Interceptor: {
            isActivable: (interceptor: Interceptor) => {
                return withFallback(
                    interceptor.isActivable(),
                    interceptor.activableTimeout || INTERCEPTOR_TIMEOUT,
                    false
                );
            },
            isActive: (interceptor: Interceptor, { proxyPort }: { proxyPort: number }) => {
                try {
                    return interceptor.isActive(proxyPort);
                } catch (e) {
                    reportError(e);
                    return false;
                }
            },
            metadata: async function (interceptor: Interceptor, { type }: { type?: 'DETAILED' | 'SUMMARY' }) {
                if (!interceptor.getMetadata) return undefined;

                const metadataType = type
                    ? type.toLowerCase() as 'summary' | 'detailed'
                    : 'summary';

                const timeout = metadataType === 'summary'
                    ? INTERCEPTOR_TIMEOUT
                    : INTERCEPTOR_TIMEOUT * 10; // Longer timeout for detailed metadata

                try {
                    return await withFallback(
                        interceptor.getMetadata(metadataType),
                        timeout,
                        undefined
                    );
                } catch (e) {
                    reportError(e);
                    return undefined;
                }
            }
        },

        Json: new GraphQLScalarType({
            name: 'Json',
            description: 'A JSON entity, serialized as a raw object',
            serialize: (value: any) => value,
            parseValue: (input: string): any => input,
            parseLiteral: (): any => { throw new Error('JSON literals are not supported') }
        }),

        Void: new GraphQLScalarType({
            name: 'Void',
            description: 'Nothing at all',
            serialize: (value: any) => null,
            parseValue: (input: string): any => null,
            parseLiteral: (): any => { throw new Error('Void literals are not supported') }
        }),

        Error: new GraphQLScalarType({
            name: 'Error',
            description: 'An error',
            serialize: (value: Error) => JSON.stringify({
                name: value.name,
                message: value.message,
                stack: value.stack
            }),
            parseValue: (input: string): any => {
                let data = JSON.parse(input);
                let error = new Error();
                error.name = data.name;
                error.message = data.message;
                error.stack = data.stack;
                throw error;
            },
            parseLiteral: (): any => { throw new Error('Error literals are not supported') }
        }),
    }
};

export class HttpToolkitServerApi extends events.EventEmitter {

    private server: express.Application;

    constructor(config: HtkConfig) {
        super();

        let interceptors = buildInterceptors(config);

        const schema = makeExecutableSchema({
            typeDefs,
            resolvers: buildResolvers(config, interceptors, this)
        });

        this.server = express();
        this.server.disable('x-powered-by');

        this.server.use(cors({
            origin: ALLOWED_ORIGINS,
            maxAge: 86400 // Cache this result for as long as possible
        }));

        this.server.use(corsGate(
            ENABLE_PLAYGROUND
            // When the debugging playground is enabled, we're slightly more lax
            ? {
                strict: true,
                allowSafe: true,
                origin: 'http://localhost:45457'
            }
            : {
                strict: true, // MUST send an allowed origin
                allowSafe: false, // Even for HEAD/GET requests (should be none anyway)
                origin: '' // No origin - we accept *no* same-origin requests
            }
        ));

        this.server.use((req, res, next) => {
            if (req.method !== 'POST' && !ENABLE_PLAYGROUND) {
                // We allow only POST, because that's all we expect for GraphQL queries,
                // and this helps derisk some (admittedly unlikely) XSRF possibilities.
                res.status(405).send('Only POST requests are supported');
            } else {
                next();
            }
        });

        if (config.authToken) {
            // Optional auth token. This allows us to lock down UI/server communication further
            // when started together. The desktop generates a token every run and passes it to both.
            this.server.use((req: express.Request, res: express.Response, next: () => void) => {
                const authHeader = req.headers['authorization'] || '';

                const tokenMatch = authHeader.match(/Bearer (\S+)/) || [];
                const token = tokenMatch[1];

                if (token !== config.authToken) {
                    res.status(403).send('Valid token required');
                } else {
                    next();
                }
            });
        }

        this.server.use(graphqlHTTP({
            schema,
            graphiql: ENABLE_PLAYGROUND
        }));
    }

    start() {
        return new Promise<void>((resolve, reject) => {
            this.server.listen(45457, '127.0.0.1', resolve); // Localhost only
            this.server.once('error', reject);
        });
    }
};