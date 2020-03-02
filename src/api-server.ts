import * as _ from 'lodash';
import * as os from 'os';
import * as events from 'events';
import corsGate = require('cors-gate');
import { GraphQLServer } from 'graphql-yoga';
import { GraphQLScalarType } from 'graphql';
import { generateSPKIFingerprint } from 'mockttp';
import { Request, Response } from 'express';

import { HtkConfig } from './config';
import { reportError, addBreadcrumb } from './error-tracking';
import { buildInterceptors, Interceptor } from './interceptors';
import { ALLOWED_ORIGINS } from './constants';
import { delay } from './util';

const packageJson = require('../package.json');

const typeDefs = `
    type Query {
        version: String!
        config: InterceptionConfig!
        interceptors: [Interceptor!]!
        networkInterfaces: Json
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
        metadata: Json

        isActivable: Boolean!
        isActive(proxyPort: Int!): Boolean!
    }

    scalar Json
    scalar Error
    scalar Void
`

const buildResolvers = (
    config: HtkConfig,
    interceptors: _.Dictionary<Interceptor>,
    eventEmitter: events.EventEmitter
) => {
    return {
        Query: {
            version: () => packageJson.version,
            interceptors: () => _.values(interceptors),
            config: () => ({
                certificatePath: config.https.certPath,
                certificateContent: config.https.certContent,
                // We could calculate this client side, but it normally requires node-forge or
                // some other heavyweight crypto lib, and we already have that here, so it's
                // convenient to do it up front.
                certificateFingerprint: generateSPKIFingerprint(config.https.certContent)
            }),
            networkInterfaces: () => os.networkInterfaces()
        },

        Mutation: {
            activateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;

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

                if (_.isError(result)) {
                    reportError(result);
                    return { success: false };
                } else {
                    addBreadcrumb(`Successfully activated ${id}`, { category: 'interceptor' });
                    return { success: true, metadata: result };
                }
            },
            deactivateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;

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
                return interceptor.isActivable().catch((e) => {
                    reportError(e);
                    return false;
                });
            },
            isActive: (interceptor: Interceptor, args: _.Dictionary<any>) => {
                try {
                    return interceptor.isActive(args.proxyPort);
                } catch (e) {
                    reportError(e);
                    return false;
                }
            },
            metadata: async (interceptor: Interceptor) => {
                try {
                    return interceptor.getMetadata
                        ? await interceptor.getMetadata()
                        : undefined;
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

    private graphql: GraphQLServer;

    constructor(config: HtkConfig) {
        super();

        let interceptors = buildInterceptors(config);

        this.graphql = new GraphQLServer({
            typeDefs,
            resolvers: buildResolvers(config, interceptors, this)
        });

        this.graphql.use(corsGate({
            strict: true, // MUST send an allowed origin
            allowSafe: false, // Even for HEAD/GET requests (should be none anyway)
            origin: '' // No origin - we accept *no* same-origin requests
        }));

        if (config.authToken) {
            // Optional auth token. This allows us to lock down UI/server communication further
            // when started together. The desktop generates a token every run and passes it to both.
            this.graphql.use((req: Request, res: Response, next: () => void) => {
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
    }

    async start() {
        await this.graphql.start(<any> {
            // Hacky solution that lets us limit the server to only localhost,
            // and override the port from 4000 to something less likely to conflict.
            port: { port: 45457, host: '127.0.0.1' },
            playground: false,
            cors: {
                origin: ALLOWED_ORIGINS,
                maxAge: 86400 // Cache this result for as long as possible
            }
        });
    }
};