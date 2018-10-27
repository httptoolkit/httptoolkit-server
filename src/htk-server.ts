import * as net from 'net';
import { GraphQLServer } from 'graphql-yoga'
import { GraphQLScalarType } from 'graphql';

const typeDefs = `
    type Query {
        version: String!
        supportedInterceptors: [Interceptor!]!
    }

    type Mutation {
        enableInterceptor(
            id: ID!,
            options: Json
        ): Boolean!
    }

    type Interceptor {
        id: ID!
    }

    scalar Json
    scalar Error
`

const resolvers = {
  Query: {
    version: async () => (await import('../package.json')).version,
    supportedInterceptors: async () => [],
  },

  Mutation: {
      enableInterceptor: (_: void, options: unknown) => {
          throw new Error("Can't enable interceptors yet");
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

export class HttpToolkitServer {

    private graphql: GraphQLServer;
    private server: net.Server | undefined;

    constructor() {
        this.graphql = new GraphQLServer({ typeDefs, resolvers });
    }

    async start() {
        // TODO: Disable playgound?
        // TODO: Listen to localhost only
        this.server = await this.graphql.start({});
    }
};