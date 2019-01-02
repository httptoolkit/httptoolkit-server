import * as _ from 'lodash';
import * as events from 'events';
import { GraphQLServer } from 'graphql-yoga'
import { GraphQLScalarType } from 'graphql';

import { HtkConfig } from './config';
import { buildInterceptors, Interceptor } from './interceptors';

const packageJson = require('../package.json');

const typeDefs = `
    type Query {
        version: String!
        config: InterceptionConfig!
        interceptors: [Interceptor!]!
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
            })
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
                return interceptor.isActivable();
            },
            isActive: (interceptor: Interceptor, args: _.Dictionary<any>) => {
                return interceptor.isActive(args.proxyPort);
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
    }

    async start() {
        await this.graphql.start(<any> {
            // Hacky solution that lets us limit the server to only localhost,
            // and override the port from 4000 to something less likely to conflict.
            port: { port: 45457, host: 'localhost' },
            playground: false,
            cors: {
                origin: [/https?:\/\/localhost(:\d+)?$/, /\.httptoolkit\.tech$/]
            }
        });
    }
};