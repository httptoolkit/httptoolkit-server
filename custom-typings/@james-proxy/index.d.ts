declare module '@james-proxy/james-browser-launcher' {
    import { ChildProcess } from 'child_process';
    import * as stream from "stream";

    namespace Launcher {
        export function detect(callback: (browsers: Browser[]) => void): void;

        interface LaunchOptions {
            browser: string;

            version?: string;
            proxy?: string;
            options?: string[];
            skipDefaults?: boolean;
            detached?: boolean;
            noProxy?: string | string[];
            headless?: boolean;
            prefs?: { [key: string]: any };
        }

        function Launch(
            uri: string,
            options: string | LaunchOptions,
            callback: (error: Error | null, instance: Launcher.BrowserInstance
        ) => void): void;

        export type Launch = typeof Launch;

        namespace Launch {
            export const browsers: Launcher.Browser[];
        }

        export interface Browser {
            name: string;
            version: string;
            type: string;
            command: string;
        }

        export interface BrowserInstance {
            command: string;
            args: string[];
            image: string;
            processName: string;
            pid: number;

            process: ChildProcess;
            stderr: stream.Readable;
            stdout: stream.Readable;
        }
    }

    function Launcher(configPath: string, callback: (error: Error | null, launch: typeof Launcher.Launch) => void): void;

    export = Launcher;
}