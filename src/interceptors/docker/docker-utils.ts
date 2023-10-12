import Docker from 'dockerode';

export const waitForDockerStream = (
    docker: Docker,
    stream: NodeJS.ReadableStream
) => new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (
        err: Error | null,
        stream: Array<{ error?: string }>
    ) => {
        if (err) reject(err);

        const firstError = stream.find((msg) => !!msg.error);
        if (firstError) reject(new Error(firstError.error));

        resolve();
    });
});

export const getDockerAddress = async (docker: Docker): Promise<
    | { socketPath: string }
    | { host: string, port: number }
> => {
    // Hacky logic to reuse docker-modem's internal env + OS parsing logic to
    // work out where the local Docker host is:
    const modem = docker.modem as any as ({
        getSocketPath(): undefined | Promise<string>;
        host: string;
        port: number;
    });

    const modemSocketPath = await modem.getSocketPath();
    return modemSocketPath
        ? { socketPath: modemSocketPath }
        : { host: modem.host, port: modem.port };
}