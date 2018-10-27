import * as _ from 'lodash';
import { GraphQLServer } from 'graphql-yoga'
import { GraphQLScalarType } from 'graphql';

import { HtkConfig } from './config';
import { buildInterceptors, Interceptor } from './interceptors';

const typeDefs = `
    type Query {
        version: String!
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
    }

    type Interceptor {
        id: ID!
        version: String!

        isActivable: Boolean!
        isActive(proxyPort: Int!): Boolean!
    }

    scalar Json
    scalar Error
`

const buildResolvers = (interceptors: _.Dictionary<Interceptor>) => {
    return {
        Query: {
            version: async () => (await import('../package.json')).version,
            interceptors: () => _.values(interceptors),
        },

        Mutation: {
            activateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;
                await interceptors[id].activate(proxyPort, options);
                return interceptors[id].isActive(proxyPort);
            },
            deactivateInterceptor: async (__: void, args: _.Dictionary<any>) => {
                const { id, proxyPort, options } = args;
                await interceptors[id].deactivate(proxyPort, options);
                return !interceptors[id].isActive(proxyPort);
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

export class HttpToolkitServer {

    private graphql: GraphQLServer;

    constructor(config: HtkConfig) {
        let interceptors = buildInterceptors(config);

        this.graphql = new GraphQLServer({
            typeDefs,
            resolvers: buildResolvers(interceptors)
        });
    }

    async start() {
        await this.graphql.start({});
    }
};