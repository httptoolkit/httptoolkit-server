import _ from 'lodash';
import * as events from 'events';
import express from 'express';
import cors from 'cors';
import corsGate from 'cors-gate';

import { HtkConfig } from '../config';
import { buildInterceptors } from '../interceptors';
import { ALLOWED_ORIGINS } from '../constants';
import { shutdown } from '../shutdown';

import { ApiModel } from './api-model';
import { exposeGraphQLAPI } from './graphql-api';
import { exposeRestAPI } from './rest-api';
import { HttpClient } from '../client/http-client';

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
 *
 * The API is available in two formats: a simple REST-ish API,
 * and a GraphQL that exists for backward compatibility. All
 * future development will happen on the REST API, and the
 * GraphQL API will eventually be removed.
 */

export class HttpToolkitServerApi extends events.EventEmitter {

    private server: express.Application;

    constructor(
        config: HtkConfig,
        httpClient: HttpClient,
        getRuleParamKeys: () => string[]
    ) {
        super();

        const interceptors = buildInterceptors(config);

        this.server = express();
        this.server.disable('x-powered-by');

        // Allow web pages on non-local URLs (app.httptoolkit.tech, not localhost) to
        // send requests to this admin server too. Without this, those requests will
        // fail after rejected preflights in recent Chrome (from ~v102, ish? Unclear).
        this.server.use((req, res, next) => {
            if (req.headers["access-control-request-private-network"]) {
                res.setHeader("access-control-allow-private-network", "true");
            }
            next(null);
        });

        this.server.use(cors({
            origin: ALLOWED_ORIGINS,
            maxAge: 86400 // Cache this result for as long as possible
        }));

        this.server.use(corsGate({
            strict: true, // MUST send an allowed origin
            allowSafe: false, // Even for HEAD/GET requests
            origin: '', // No origin - we accept *no* same-origin requests

            // Extend default failure response to add a helpful error body.
            failure: (_req, res, _next) => {
                res.statusCode = 403;
                res.send({ error: { message: 'Invalid CORS headers' }});
            }
        }));

        this.server.use((req, res, next) => {
            if (req.path === '/' && req.method !== 'POST') {
                // We allow only POST to GQL, because that's all we expect for GraphQL queries,
                // and this helps derisk some (admittedly unlikely) XSRF possibilities.

                res.status(405).send({
                    error: { message: 'Only POST requests are supported' }
                });

                // XSRF is less of a risk elsewhere, as REST GET endpoints don't do dangerous
                // things. Also we're enforcing Origin headers everywhere so it should be
                // impossible regardless, but better safe than sorry!
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
                    res.status(403).send({
                        error: { message: 'Valid token required' }
                    });
                } else {
                    next();
                }
            });
        }

        const apiModel = new ApiModel(
            config,
            interceptors,
            getRuleParamKeys,
            httpClient,
            {
                onTriggerUpdate: () => this.emit('update-requested'),
                onTriggerShutdown: () => shutdown(0, 'API call')
            }
        )

        this.server.use(express.json());

        exposeRestAPI(this.server, apiModel);
        exposeGraphQLAPI(this.server, apiModel);
    }

    start() {
        return new Promise<void>((resolve, reject) => {
            this.server.listen(45457, '127.0.0.1', resolve); // Localhost only
            this.server.once('error', reject);
        });
    }
};