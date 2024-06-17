import * as _ from 'lodash';
import type {
    Application as ExpressApp,
    NextFunction
} from 'express';
import type {
    Request,
    Response,
    RequestHandler,
    RouteParameters
} from 'express-serve-static-core';
import type { ParsedQs } from 'qs';
import { ErrorLike, StatusError } from '@httptoolkit/util';

import { logError } from '../error-tracking';
import { ApiModel } from './api-model';
import * as Client from '../client/client-types';

/**
 * This file exposes the API model via a REST-ish classic HTTP API.
 * All endpoints take & receive JSON only. Status codes are used
 * directly to indicate any errors, with any details returned
 * as JSON in an `error` field.
 */

export function exposeRestAPI(
    server: ExpressApp,
    apiModel: ApiModel
) {
    server.get('/version', handleErrors((_req, res) => {
        res.send({ version: apiModel.getVersion() });
    }));

    server.post('/update', handleErrors((_req, res) => {
        apiModel.updateServer();
        res.send({ success: true });
    }));

    server.post('/shutdown', handleErrors((_req, res) => {
        apiModel.shutdownServer();
        res.send({ success: true });
    }));

    server.get('/config', handleErrors(async (req, res) => {
        const proxyPort = getProxyPort(req.query.proxyPort);
        res.send({ config: await apiModel.getConfig(proxyPort) });
    }));

    server.get('/config/network-interfaces', handleErrors((_req, res) => {
        res.send({ networkInterfaces: apiModel.getNetworkInterfaces() });
    }));

    // Get top-line data on the current interceptor state
    server.get('/interceptors', handleErrors(async (req, res) => {
        const proxyPort = getProxyPort(req.query.proxyPort);
        res.send({ interceptors: await apiModel.getInterceptors(proxyPort) });
    }));

    // Get the complete details of a specific interceptor state, i.e. full metadata.
    // This may return more detailed info that the 'metadata' field on getInterceptors
    server.get('/interceptors/:id/metadata', handleErrors(async (req, res) => {
        const interceptorId = req.params.id;

        res.send({
            interceptorMetadata: await apiModel.getInterceptorMetadata(interceptorId, 'detailed')
        });
    }));

    // Get the complete details of a sub-part of interceptor state, i.e. even more detailed
    // metadata about one target of many options available.
    server.get('/interceptors/:id/metadata/:subId', handleErrors(async (req, res) => {
        const interceptorId = req.params.id;
        const subId = req.params.subId;

        res.send({
            interceptorMetadata: await apiModel.getInterceptorMetadata(
                interceptorId,
                'detailed',
                subId
            )
        });
    }));

    server.post('/interceptors/:id/activate/:proxyPort', handleErrors(async (req, res) => {
        const interceptorId = req.params.id;
        const proxyPort = parseInt(req.params.proxyPort, 10);
        if (isNaN(proxyPort)) throw new StatusError(400, `Could not parse required proxy port: ${req.params.proxyPort}`);

        const interceptorOptions = req.body;
        const result = await apiModel.activateInterceptor(interceptorId, proxyPort, interceptorOptions);

        // No thrown error here doesn't mean success: we have non-reportable failures for cases like
        // Global Chrome "prompt to confirm quit" errors. We return those as 200 { success: false, metadata: ... }

        res.json({ result });
    }));

    server.post('/client/send', handleErrors(async (req, res) => {
        const bodyData = req.body;
        if (!bodyData) throw new StatusError(400, "No request definition or options provided");

        const {
            request,
            options
        } = bodyData;

        if (!request) throw new StatusError(400, "No request definition provided");
        if (!options) throw new StatusError(400, "No request options provided");

        // Various buffers are serialized as base64 (for both requests & responses)
        request.rawBody = Buffer.from(request.rawBody ?? '', 'base64');
        if (options.clientCertificate) {
            options.clientCertificate.pfx = Buffer.from(options.clientCertificate.pfx, 'base64');
        }

        // Start actually sending the request:
        const abortController = new AbortController();
        const resultStream = await apiModel.sendRequest(request, {
            ...options,
            abortSignal: abortController.signal
        });

        // If the client closes the connection, abort the outgoing request:
        res.on('close', () => abortController.abort());

        res.writeHead(200, {
            'content-type': 'application/x-ndjson'
        });

        // Write all upstream events as JSON data to the client here:
        resultStream.on('data', (evt: Client.ResponseStreamEvents) => {
            if (evt.type === 'response-body-part') {
                res.write(JSON.stringify({
                    ...evt,
                    rawBody: evt.rawBody.toString('base64')
                }));
            } else {
                res.write(JSON.stringify(evt));
            }
            res.write('\n');
        });

        resultStream.on('end', () => res.end());

        resultStream.on('error', (error: ErrorLike) => {
            res.write(JSON.stringify({
                type: 'error',
                timestamp: performance.now(),
                error: {
                    code: error.code,
                    message: error.message,
                    stack: error.stack
                }
            }) + '\n');
            res.end();
        });
    }));
}

function getProxyPort(stringishInput: any) {
    // Proxy port is optional everywhere, to make it possible to query data
    // in parallel (without waiting for Mockttp) for potentially faster setup.

    if (!stringishInput) return undefined;

    const proxyPort = parseInt(stringishInput as string, 10);
    if (isNaN(proxyPort)) return undefined;

    return proxyPort;
}

// A wrapper to automatically apply async error handling & responses to an Express handler. Fairly simple logic,
// very awkward (but not actually very interesting) types.
function handleErrors<
    Route extends string,
    P = RouteParameters<Route>,
    ResBody = any,
    ReqBody = any,
    ReqQuery = ParsedQs,
    Locals extends Record<string, any> = Record<string, any>,
>(
    handler: RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals>
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
    return (async (req: Request<P, ResBody, ReqBody, ReqQuery, Locals>, res: Response<any, Locals>, next: NextFunction) => {
        try {
            return await handler(req, res, next);
        } catch (e) {
            const error = e as ErrorLike;

            console.log(`Error handling request to ${req.path}: ${error.message ?? error}`);
            logError(error);

            // Use default error handler if response started (kills the connection)
            if (res.headersSent) return next(error)
            else {
                const status = (error.statusCode && error.statusCode >= 400 && error.statusCode < 600)
                    ? error.statusCode
                    : 500;

                res.status(status).send({
                    error: {
                        code: error.code,
                        message: error.message,
                        stack: error.stack
                    }
                })
            }
        }
    }) as any;
}