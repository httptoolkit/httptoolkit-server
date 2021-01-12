declare module 'chrome-remote-interface' {
    function CDP(options: {
        port?: number
    }): Promise<CDP.CdpClient>;

    namespace CDP {
        interface Stack {
            callFrames: Array<CallFrame>;
        }

        interface CallFrame {
            callFrameId: string;
        }

        export interface CdpClient {
            Runtime: {
                runIfWaitingForDebugger(): Promise<void>;
                enable(): Promise<void>;
                evaluate(options: { expression: string }): Promise<{
                    result?: unknown,
                    exceptionDetails?: unknown
                }>
            };

            Debugger: {
                enable(): Promise<void>;
                paused(callback: (stack: Stack) => void): void;
                resume(): Promise<void>;
                evaluateOnCallFrame(options: {
                    callFrameId: string,
                    expression: string
                }): Promise<{
                    result?: unknown,
                    exceptionDetails?: unknown
                }>
            };

            on(event: 'disconnect', callback: () => void): void;
            once(event: 'disconnect', callback: () => void): void;

            close(): Promise<void>;
        }
    }

    export = CDP;
}