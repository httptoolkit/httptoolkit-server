import * as _ from 'lodash';
import * as path from 'path';
import * as stream from 'stream';
import * as getRawBody from 'raw-body';
import maybeGunzip = require('gunzip-maybe');
import * as tarStream from 'tar-stream';
import * as tarFs from 'tar-fs';
import { parse as parseDockerfile, CommandEntry } from 'docker-file-parser';

import {
    getTerminalEnvVars,
    OVERRIDES_DIR
} from '../terminal/terminal-env-overrides';

const HTTP_TOOLKIT_INJECTED_PATH = '/http-toolkit-injections';
const HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'overrides');
const HTTP_TOOLKIT_INJECTED_CA_PATH = path.posix.join(HTTP_TOOLKIT_INJECTED_PATH, 'ca.pem');

const HTTP_TOOLKIT_CONTEXT_PATH = '/.http-toolkit-injections';
const HTTP_TOOLKIT_CONTEXT_OVERRIDES_PATH = path.posix.join(HTTP_TOOLKIT_CONTEXT_PATH, 'overrides');
const HTTP_TOOLKIT_CONTEXT_CA_PATH = path.posix.join(HTTP_TOOLKIT_CONTEXT_PATH, 'ca.pem');

/**
 * Take a build context stream, and transform it to inject into the build itself via
 * the Dockerfile. Supports gzipped & raw tarballs.
 */
export async function injectIntoBuildStream(
    dockerfileName: string,
    buildStream: stream.Readable,
    config: { proxyPort: number, certContent: string }
) {
    const extractionStream = tarStream.extract();
    const repackStream = tarStream.pack();

    extractionStream.on('entry', async (headers, entryStream, next) => {
        if (headers.name === dockerfileName) {
            const originalDockerfile = (await getRawBody(entryStream)).toString('utf-8');
            const transformedDockerfile = injectIntoDockerfile(originalDockerfile, config);

            repackStream.entry(_.omit(headers, 'size'), transformedDockerfile, next);
        } else {
            // Copy the file into the repacked tarball untouched:
            entryStream.pipe(repackStream.entry(headers, next));
        }
    });
    extractionStream.on('finish', async () => {
        repackStream.entry({ name: HTTP_TOOLKIT_CONTEXT_CA_PATH }, config.certContent);
        await packOverrideFiles(repackStream);
        repackStream.finalize();
    });

    buildStream.pipe(maybeGunzip()).pipe(extractionStream);
    return repackStream;
}

function packOverrideFiles(existingPackStream: tarStream.Pack) {
    return new Promise<tarStream.Pack>((resolve) => {
        tarFs.pack(OVERRIDES_DIR, {
            pack: existingPackStream,
            map: (fileHeader) => {
                fileHeader.name = path.posix.join(HTTP_TOOLKIT_CONTEXT_OVERRIDES_PATH, fileHeader.name);

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

// Simplify to just the params we care about
type DockerCommand = Pick<CommandEntry, 'name' | 'args'>;

function injectIntoDockerfile(dockerfileContents: string, config: { proxyPort: number }) {
    const dockerCommands: DockerCommand[] = parseDockerfile(dockerfileContents, {
        includeComments: true
    });

    // After every FROM (start of each build stage) we inject ARG & COPY to reconfigure the stage:
    const fromCommandIndexes = dockerCommands
        .map((command, index) =>
            command.name === 'FROM'
                ? index
                : -1
        )
        .filter((index) => index !== -1);

    const envVars = getTerminalEnvVars(
        config.proxyPort,
        { certPath: HTTP_TOOLKIT_INJECTED_CA_PATH },
        'runtime-inherit', // ARG can reference ENV vars directly
        {
            httpToolkitIp: '172.17.0.1',
            overridePath: HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH,
            targetPlatform: 'linux'
        }
    );

    fromCommandIndexes.reverse().forEach((fromIndex) => {
        dockerCommands.splice(fromIndex + 1, 0, ...[
            {
                name: 'COPY',
                args: [HTTP_TOOLKIT_CONTEXT_OVERRIDES_PATH, HTTP_TOOLKIT_INJECTED_OVERRIDES_PATH]
            },
            {
                name: 'COPY',
                args: [HTTP_TOOLKIT_CONTEXT_CA_PATH, HTTP_TOOLKIT_INJECTED_CA_PATH]
            },
            {
                name: 'ENV',
                args: envVars
            }
            // COPY must not be the last command, or (in subsequent multi-stage builds) we will hit
            // this Docker bug: https://github.com/moby/moby/issues/37965
        ]);
    });

    return generateDockerfileFromCommands(dockerCommands);
}

// Commands -> Dockerfile logic based on Balena's equivalent (Apache-2 licensed) code here:
// https://github.com/balena-io-modules/docker-qemu-transpose/blob/734d8397dfe33ae3af85cdd4fb27c64a6ca77a25/src/index.ts#L107-L144
function generateDockerfileFromCommands(commands: DockerCommand[]): string {
	return commands.map(command =>
        command.name === 'COMMENT'
            ? (command.args as string)
            :`${command.name} ${argsToString(
                command.args,
                command.name,
            )}`
    ).join('\n');
}

const SPACE_SEPARATED_ARRAY_COMMANDS = ['ARG', 'EXPOSE'];

function argsToString(
	args: string | { [key: string]: string } | string[],
	commandName: string,
): string {
	if (_.isArray(args)) {
		let ret = '';
		// Handle command meta-arguments (like --from=stage)
		if (args[0] != null && args[0].startsWith('--')) {
			ret += args[0] + ' ';
			args = args.slice(1);
		}
		if (SPACE_SEPARATED_ARRAY_COMMANDS.includes(commandName)) {
			return ret + args.join(' ');
		}
		return ret + '["' + (args as string[]).join('","') + '"]';
	} else if (_.isObject(args)) {
		return _.map(args, (value: string, key: string) => {
			const escapedValue = JSON.stringify(value);
			return `${key}=${escapedValue}`;
		}).join(' ');
	} else {
		return args as string;
	}
};