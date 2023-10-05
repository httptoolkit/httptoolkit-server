import * as _ from 'lodash';
import type { Application as ExpressApp } from 'express';

import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLScalarType } from 'graphql';
import { createHandler as createGraphQLHandler } from 'graphql-http/lib/use/express';
import gql from 'graphql-tag';
import { ApiModel } from './api-model';

const typeDefs = gql`
    type Query {
        version: String!
        config: InterceptionConfig!
        interceptors: [Interceptor!]!
        interceptor(id: ID!): Interceptor!
        networkInterfaces: Json
        systemProxy: Proxy
        dnsServers(proxyPort: Int!): [String!]!
        ruleParameterKeys: [String!]!
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
        shutdown: Void
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

const buildResolvers = (apiModel: ApiModel) => {
    // To avoid duplicating getConfig calls (not free) we cache the first call
    // result in the context:
    const getConfig = async (context: any) => {
        return context.apiConfig ??= apiModel.getConfig();
    };

    return {
        Query: {
            version: () => apiModel.getVersion(),
            interceptors: () => apiModel.getInterceptors(),
            interceptor: (_: any, { id } : { id: string }) => apiModel.getInterceptor(id),
            config: async (__: unknown, ___: unknown, context: any) => _.pick(await getConfig(context), [
                'certificatePath',
                'certificateContent',
                'certificateFingerprint'
            ]),
            networkInterfaces: () => apiModel.getNetworkInterfaces(),
            systemProxy: async (__: unknown, ___: unknown, context: any) =>
                (await getConfig(context)).systemProxy,
            dnsServers: async (__: void, { proxyPort }: { proxyPort: number }): Promise<string[]> =>
                apiModel.getDnsServers(proxyPort),
            ruleParameterKeys: async (__: unknown, ___: unknown, context: any): Promise<String[]> =>
                (await getConfig(context)).ruleParameterKeys
        },

        Mutation: {
            activateInterceptor: async (__: void, { id, proxyPort, options }: {
                id: string,
                proxyPort: number,
                options: unknown
            }) => apiModel.activateInterceptor(id, proxyPort, options),
            deactivateInterceptor: async (__: void, { id, proxyPort, options }: {
                id: string,
                proxyPort: number,
                options: unknown
            }) => apiModel.deactivateInterceptor(id, proxyPort, options),
            triggerUpdate: () => apiModel.updateServer(),
            shutdown: () => apiModel.shutdownServer()
        },

        Interceptor: {
            isActive: async (interceptor: { id: string }, { proxyPort }: { proxyPort: number }) => {
                return apiModel.isInterceptorActive(interceptor.id, proxyPort);
            },
            metadata: async function (
                interceptor: { id: string, metadata: any },
                { type }: { type?: 'DETAILED' | 'SUMMARY' }
            ) {
                // Avoid re-building summary metadata (included by default). We do rebuild
                // for detailed metadata but it's not a big deal, and this just exists for
                // backward compat so a little delay isn't a problem anyway.
                if (type === 'SUMMARY' && interceptor.metadata) return interceptor.metadata;

                const metadataType = type
                    ? type.toLowerCase() as 'summary' | 'detailed'
                    : 'summary';
                return apiModel.getInterceptorMetadata(interceptor.id, metadataType);
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

export function exposeGraphQLAPI(
    server: ExpressApp,
    apiModel: ApiModel
) {
    const schema = makeExecutableSchema({
        typeDefs,
        resolvers: buildResolvers(apiModel)
    });

    server.post('/', createGraphQLHandler({
        schema,
        context: () => ({}) // Fresh empty context for every request
    }));
}