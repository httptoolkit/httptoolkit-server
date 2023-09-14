export type ErrorLike = Partial<Error> & {
    // Various properties we might want to look for on errors:
    code?: string;
    cmd?: string;
    signal?: string;
    status?: number;
    statusCode?: number;
};

// Useful to easily cast and then examine errors that are otherwise 'unknown':
export function isErrorLike(error: any): error is ErrorLike {
    return typeof error === 'object' && (
        error instanceof Error ||
        error.message ||
        error.code ||
        error.stack
    )
}

abstract class CustomErrorBase extends Error {
    constructor(message?: string) {
        super(message); // 'Error' breaks prototype chain here

        // This restores the details of the real error subclass:
        this.name = new.target.name;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export class StatusError extends CustomErrorBase {
    constructor(
        /**
         * Should be a valid HTTP status code
         */
        public readonly status: number,
        message: string
    ) {
        super(message);
    }
}