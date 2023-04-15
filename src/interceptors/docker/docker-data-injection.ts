import * as path from 'path';
import Docker from 'dockerode';
import * as TarStream from 'tar-stream';
import * as TarFs from 'tar-fs';

import { SERVER_VERSION } from "../../constants";
import { OVERRIDES_DIR } from '../terminal/terminal-env-overrides';
import { isDockerAvailable } from "./docker-interception-services";
import { waitForDockerStream } from './docker-utils';

const DOCKER_BLANK_IMAGE_NAME = 'httptoolkit/scratch';
const DOCKER_BLANK_LABEL = 'tech.httptoolkit.docker.scratch';
const DOCKER_VOLUME_LABEL = 'tech.httptoolkit.docker.data-volume';
const DOCKER_VOLUME_CERT_LABEL = 'tech.httptoolkit.docker.data-volume.cert-content';

const VOLUME_NAME_PREFIX = 'httptoolkit-injected-data-';
const DOCKER_DATA_VOLUME_NAME = `${VOLUME_NAME_PREFIX}${SERVER_VERSION}`;

/**
 * Get the volume name to use to mount our volume into containers to inject
 * the override data & CA certificate.
 *
 * This is async and checks the volume exists every time, because if you don't
 * and you reference the name when creating a container when the volume doesn't
 * exist then it'll a) create an empty useless volume that won't work and b)
 * create the volume with the correct name and attach it, so we can't remove &
 * replace it later to fix the issue, until the container exits. Very annoying.
 */
export const getDockerDataVolumeName = (certContent: string) =>
    ensureDockerInjectionVolumeExists(certContent)
    .then(() => DOCKER_DATA_VOLUME_NAME);

export function packOverrideFiles(packStream: TarStream.Pack, targetPath?: string) {
    return new Promise<TarStream.Pack>((resolve) => {
        TarFs.pack(OVERRIDES_DIR, {
            pack: packStream,
            map: (fileHeader) => {
                if (targetPath) {
                    fileHeader.name = path.posix.join(targetPath, fileHeader.name);
                }

                // Owned by root by default
                fileHeader.uid = 0;
                fileHeader.gid = 0;

                // But ensure everything is globally readable & runnable
                fileHeader.mode = parseInt('555', 8);

                return fileHeader;
            },
            finalize: false,
            finish: resolve
        });
    });
}

async function buildTarStream(files: Array<{
    path: string,
    contents: string | Buffer
}>) {
    const tarStream = TarStream.pack();
    files.forEach(({ path, contents }) => tarStream.entry({
        name: path
    }, contents));
    tarStream.finalize();
    return tarStream;
}

async function createBlankImage(docker: Docker) {
    // This is mad, but it totally works. We create a blank image from a no-op
    // Dockerfile, sending no context, so it's super fast.

    // Skip image creation if it already exists:
    const existingImage = await docker.getImage(DOCKER_BLANK_IMAGE_NAME).inspect()
        .then(() => true)
        .catch(() => false);
    if (existingImage) return DOCKER_BLANK_IMAGE_NAME;

    const blankImageContextStream = await buildTarStream([{
        path: 'Dockerfile',
        contents: 'FROM scratch\nENTRYPOINT ["FAIL"]\n'
    }]);
    const buildStream = await docker.buildImage(blankImageContextStream, {
        dockerfile: 'Dockerfile',
        t: DOCKER_BLANK_IMAGE_NAME,
        labels: { [DOCKER_BLANK_LABEL]: '' }
    });

    await waitForDockerStream(docker, buildStream);

    return DOCKER_BLANK_IMAGE_NAME;
}

// Parallel processing of a single Docker volume and the other assorted containers is asking for trouble,
// and inefficient, so we collapse parallel attempts into one:
let volumeSetupPromise: Promise<void> | undefined;

export function ensureDockerInjectionVolumeExists(certContent: string) {
    if (volumeSetupPromise) return volumeSetupPromise;
    return volumeSetupPromise = (async () => { // Run as an async IIFE
        if (!await isDockerAvailable()) return;
        const docker = new Docker();

        const existingVolume = await docker.getVolume(DOCKER_DATA_VOLUME_NAME).inspect()
            .catch<false>(() => false);
        const isCertOutdated = existingVolume &&
            existingVolume.Labels?.[DOCKER_VOLUME_CERT_LABEL] !== certContent;

        if (existingVolume && !isCertOutdated) return; // We're all good!

        try {
            const startTime = Date.now();

            // Clean up any leftover setup components that are hanging around (since they might
            // conflict with these next steps):
            await cleanupDataInjectionTools(docker);

            // If cert is outdated, we just recreate the volume from scratch - cleaner to reset
            // then try and update, and it only takes a couple of seconds anyway:
            if (isCertOutdated) await docker.getVolume(DOCKER_DATA_VOLUME_NAME).remove({ force: true });

            // No volume. We need to create a Docker volume that contains our override files,
            // and the CA certificate, which can be mounted into containers for interception.
            // We can't directly write to volumes, so we work around this by mounting a new volume
            // inside a stopped empty container, and writing to the container.

            // First, we need an empty volume, and build blank image for our container:
            await Promise.all([
                docker.createVolume({
                    Name: DOCKER_DATA_VOLUME_NAME,
                    Labels: {
                        [DOCKER_VOLUME_LABEL]: SERVER_VERSION,
                        [DOCKER_VOLUME_CERT_LABEL]: certContent // Used to detect when we need to recreate
                    }
                }),
                createBlankImage(docker)
            ]);

            // Then we create a blank container from the blank image with the volume mounted:
            const blankContainer = await docker.createContainer({
                Image: DOCKER_BLANK_IMAGE_NAME,
                Labels: { [DOCKER_BLANK_LABEL]: '' },
                HostConfig: {
                    Binds: [`${DOCKER_DATA_VOLUME_NAME}:/data-volume`]
                }
            });

            const blankContainerSetupTime = Date.now() - startTime;
            let overrideStreamTime: number | undefined;

            // Then we use the container to write to the volume, without ever starting it:
            const volumeStream = TarStream.pack();
            // We write the CA cert, read-only:
            volumeStream.entry({ name: 'ca.pem', mode: parseInt('444', 8) }, certContent);
            // And all the override filesL
            const packOverridesPromise = packOverrideFiles(volumeStream, '/overrides')
                .then(() => {
                    volumeStream.finalize();
                    overrideStreamTime = Date.now() - startTime;
                });

            const writeVolumePromise = blankContainer.putArchive(
                volumeStream,
                { path: '/data-volume/' }
            );

            await Promise.all([packOverridesPromise, writeVolumePromise]);
            const volumeCompleteTime = Date.now() - startTime;
            console.log(`Created Docker injection volume (took ${
                volumeCompleteTime
            }ms: ${blankContainerSetupTime}ms for setup & ${overrideStreamTime!}ms to pack)`);

            // After success, we cleanup the tools (blank image & containers etc) and all old HTTP
            // Toolkit volumes, i.e. all matching volumes _except_ the current one.
            await cleanupDataInjectionTools(docker);
            await cleanupDataInjectionVolumes(docker, { keepCurrent: true }).catch(console.log);
        } catch (e) {
            console.warn('Docker injection volume setup error, cleaning up...');

            // In a failure case, we delete the setup components and the volume too, so that at
            // least we have a clean slate next time:
            await cleanupDataInjectionTools(docker).catch(console.log);
            await cleanupDataInjectionVolumes(docker, { keepCurrent: false }).catch(console.log);

            throw e;
        }
    })().then(() => {
        // Reset the promise, so we can try again
        volumeSetupPromise = undefined;
    });
}

async function cleanupDataInjectionVolumes(docker: Docker, options: { keepCurrent: boolean }) {
    const volumes = await docker.listVolumes({
        filters: JSON.stringify({ label: [DOCKER_VOLUME_LABEL] })
    });

    const dataVolumes = volumes.Volumes.filter(v =>
        // Make sure we _definitely_ don't delete other volumes:
        v.Name.startsWith(VOLUME_NAME_PREFIX) && (
            // Only wipe the active volume too if 'keepCurrent' is false
            !options.keepCurrent ||
            v.Name !== DOCKER_DATA_VOLUME_NAME
        )
    );

    return Promise.all(dataVolumes.map(v =>
        docker.getVolume(v.Name).remove({ force: true })
    ));
}

async function cleanupDataInjectionTools(docker: Docker) {
    const blankContainers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [DOCKER_BLANK_LABEL] })
    });
    await Promise.all(
        blankContainers
        .filter(c => c.Labels?.[DOCKER_BLANK_LABEL] !== undefined) // Be extra careful
        .map(c => docker.getContainer(c.Id).remove({ force: true }))
    );

    const blankImages = await docker.listImages({
        filters: JSON.stringify({ label: [DOCKER_BLANK_LABEL] })
    });

    await Promise.all(
        blankImages
        .filter(i => i.Labels?.[DOCKER_BLANK_LABEL] !== undefined) // Be extra careful
        .map(i => docker.getImage(i.Id).remove({ force: true }))
    );
}