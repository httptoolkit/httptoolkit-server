import * as _ from 'lodash';
import { GraphQLServer } from 'graphql-yoga'
import { GraphQLScalarType } from 'graphql';

import { buildInterceptors } from './interceptors';

const typeDefs = `
    type Query {
        version: String!
        interceptors: [Interceptor!]!
    }

    type Mutation {
        activateInterceptor(
            id: ID!,
            options: Json
        ): Boolean!
    }

    type Interceptor {
        id: ID!
        isActive: Boolean!
        version: String!
    }

    scalar Json
    scalar Error
`

const buildResolvers = (configPath: string) => {
    let interceptors = buildInterceptors(configPath);

    return {
        Query: {
            version: async () => (await import('../package.json')).version,
            interceptors: () => _.values(interceptors),
        },

        Mutation: {
            activateInterceptor: (__: void, args: _.Dictionary<any>) => {

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

    constructor(options: { configPath: string }) {
        this.graphql = new GraphQLServer({
            typeDefs,
            resolvers: buildResolvers(options.configPath)
        });
    }

    async start() {
        await this.graphql.start({});
    }
};