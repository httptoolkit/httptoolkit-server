declare module "@cypress/get-windows-proxy" {
    function getWindowsProxy(): {
        httpProxy: string | undefined;
        noProxy: string | undefined;
    } | undefined;

    export = getWindowsProxy;
}