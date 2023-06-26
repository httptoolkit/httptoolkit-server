declare module 'cors-gate' {
    import * as express from 'express';

    interface Options {
        origin: string;
        strict?: boolean;
        allowSafe?: boolean;
        failure: (req: express.Request, res: express.Response, next: express.NextFunction) => void;
    }

    function corsGate(options: Options): express.RequestHandler;

    export = corsGate;
}