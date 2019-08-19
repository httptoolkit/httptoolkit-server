import * as _ from 'lodash';
import * as os from 'os';
import * as events from 'events';
import { GraphQLServer } from 'graphql-yoga';
import * as Express from 'express';
import { GraphQLScalarType } from 'graphql';

import { HtkConfig } from './config';
import { reportError } from './error-tracking';
import { buildInterceptors, Interceptor } from './interceptors';
import { ALLOWED_ORIGINS } from './util';

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
        ): Boolean!
        deactivateInterceptor(
            id: ID!,
            proxyPort: Int!
        ): Boolean!
        triggerUpdate: Void
    }

    type InterceptionConfig {
        certificatePath: String!
    }

    type Interceptor {
        id: ID!
        version: String!

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
                certificatePath: config.https.certPath
            }),
            networkInterfaces: () => os.networkInterfaces()
        },

        Mutation: {
            activateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;

                const interceptor = interceptors[id];
                if (!interceptor) throw new Error(`Unknown interceptor ${id}`);

                await interceptor.activate(proxyPort, options);
                return interceptor.isActive(proxyPort);
            },
            deactivateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;

                const interceptor = interceptors[id];
                if (!interceptor) throw new Error(`Unknown interceptor ${id}`);

                await interceptor.deactivate(proxyPort, options);
                return !interceptor.isActive(proxyPort);
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
            }
        },

        Json: new GraphQLScalarType({
            name: 'Json',
            description: 'A JSON entity, serialized as a simple JSON string',
            serialize: (value: any) => JSON.stringify(value),
            parseValue: (input: string): any => JSON.parse(input),
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

export class HttpToolkitServer extends events.EventEmitter {

    private graphql: GraphQLServer;

    constructor(config: HtkConfig) {
        super();

        let interceptors = buildInterceptors(config);

        this.graphql = new GraphQLServer({
            typeDefs,
            resolvers: buildResolvers(config, interceptors, this)
        });

        // TODO: This logic also exists in Mockttp - probably good to commonize it somewhere.
        this.graphql.use((req: Express.Request, res: Express.Response, next: () => void) => {
            const origin = req.headers['origin'];
            // This will have been set (or intentionally not set), by the CORS middleware
            const allowedOrigin = res.getHeader('Access-Control-Allow-Origin');

            // If origin is set (null or an origin) but was not accepted by the CORS options
            // Note that if no options.cors is provided, allowedOrigin is always *.
            if (origin !== undefined && allowedOrigin !== '*' && allowedOrigin !== origin) {
                // Don't process the request: error out & skip the lot (to avoid CSRF)
                res.status(403).send('CORS request sent by unacceptable origin');
            } else {
                next();
            }
        });
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