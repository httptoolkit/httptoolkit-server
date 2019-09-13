declare module '@httptoolkit/osx-find-executable' {
    function findExecutable(bundleId: string, callback: (error: Error | null, executablePath?: string) => void): void;

    export = findExecutable;
}