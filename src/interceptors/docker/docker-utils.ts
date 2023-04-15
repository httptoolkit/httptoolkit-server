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