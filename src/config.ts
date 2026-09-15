import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {ConfigurationError} from './errors.js';
import type {ConfigurationErrorKind} from './errors.js';
import type {
    Agent,
    Configuration,
    ConfigurationLocation,
    LoadedConfiguration,
    RestartPolicy
} from './types.js';

/** Command line argument that points supavisor at a configuration file. */
const CONFIGURATION_PATH_ARGUMENT = '--config';

/** Environment variable that points supavisor at a configuration file. */
const CONFIGURATION_PATH_VARIABLE = 'SUPAVISOR_CONFIG';

/** Where supavisor looks when neither the argument nor the variable is given. */
const DEFAULT_CONFIGURATION_PATH = '~/.config/supavisor/configuration.json';

/** Restart policy of an agent that does not name one. */
const DEFAULT_RESTART_POLICY: RestartPolicy = 'on-failure';

/** Heartbeat timeout of an agent that does not name one, in seconds. */
const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 60;

const RESTART_POLICIES: readonly RestartPolicy[] = ['always', 'on-failure', 'never'];

/** Configuration offered to someone who has none yet. */
const SAMPLE_CONFIGURATION = `{
    "agents": [
        {
            "name": "claude",
            "command": "claude",
            "arguments": ["-p", "Hello, claude!"]
        }
    ]
}`;

type Environment = Readonly<Record<string, string | undefined>>;

type ResolveConfigurationOptions = {
    /** Command line arguments without the node binary and the script; defaults to the real ones. */
    readonly argv?: readonly string[];
    /** Environment to read the variable and the home directory from; defaults to `process.env`. */
    readonly env?: Environment;
    /** Directory a relative path is resolved against; defaults to `process.cwd()`. */
    readonly cwd?: string;
};

type LoadConfigurationOptions = ResolveConfigurationOptions & {
    /** How to read the file; defaults to reading it from disk as UTF-8. */
    readonly readFile?: (path: string) => string;
};

/**
 * Decides which configuration file to read: the argument wins over the
 * environment variable, the variable wins over the default path. `~` is
 * expanded here and not by the shell, because under `npx` there is no shell
 * to do it.
 */
function resolveConfigurationLocation(options: ResolveConfigurationOptions = {}): ConfigurationLocation {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();

    const fromArgument = configurationPathArgument(argv);
    if (fromArgument !== undefined) {
        return {path: absolutePath(fromArgument, env, cwd), source: 'argument'};
    }

    const fromEnvironment = env[CONFIGURATION_PATH_VARIABLE]?.trim();
    if (fromEnvironment !== undefined && fromEnvironment !== '') {
        return {path: absolutePath(fromEnvironment, env, cwd), source: 'environment'};
    }

    return {path: absolutePath(DEFAULT_CONFIGURATION_PATH, env, cwd), source: 'default'};
}

/**
 * Reads, parses and checks the configuration file. Starting agents, heartbeats
 * and restarts are somebody else's job: this only hands over a checked value.
 *
 * @throws ConfigurationError with a message a human can act on.
 */
function loadConfiguration(options: LoadConfigurationOptions = {}): LoadedConfiguration {
    const location = resolveConfigurationLocation(options);
    const contents = readConfigurationFile(location.path, options.readFile ?? readFileFromDisk);
    const parsed = parseConfiguration(contents, location.path);

    return {location, configuration: validateConfiguration(parsed, location.path)};
}

function readFileFromDisk(path: string): string {
    return readFileSync(path, 'utf8');
}

function configurationPathArgument(argv: readonly string[]): string | undefined {
    let path: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';

        if (argument.startsWith(`${CONFIGURATION_PATH_ARGUMENT}=`)) {
            path = argument.slice(CONFIGURATION_PATH_ARGUMENT.length + 1);
        } else if (argument === CONFIGURATION_PATH_ARGUMENT) {
            path = argv[index + 1];
            index += 1;
        } else {
            continue;
        }

        if (path === undefined || path.trim() === '') {
            throw new ConfigurationError(
                'invalid-argument',
                `${CONFIGURATION_PATH_ARGUMENT} requires a path, for example ${CONFIGURATION_PATH_ARGUMENT} ${DEFAULT_CONFIGURATION_PATH}`
            );
        }

        path = path.trim();
    }

    return path;
}

function absolutePath(path: string, env: Environment, cwd: string): string {
    return resolve(cwd, expandHome(path, env));
}

function expandHome(path: string, env: Environment): string {
    if (path !== '~' && !path.startsWith('~/') && !path.startsWith('~\\')) {
        return path;
    }

    const home = env['HOME']?.trim() || env['USERPROFILE']?.trim();
    if (home === undefined || home === '') {
        throw new ConfigurationError(
            'unresolved-home',
            `Cannot expand "~" in ${path}: neither HOME nor USERPROFILE is set in the environment`,
            {hint: `Pass an absolute path with ${CONFIGURATION_PATH_ARGUMENT} <path> or ${CONFIGURATION_PATH_VARIABLE}=<path>.`}
        );
    }

    return path === '~' ? home : join(home, path.slice(2));
}

function readConfigurationFile(path: string, readFile: (path: string) => string): string {
    try {
        return readFile(path);
    } catch (error) {
        const code = errorCode(error);

        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new ConfigurationError('missing-file', `Configuration file not found: ${path}`, {
                path,
                cause: error,
                hint: `This is what the first run looks like. Create the file, or point supavisor at another one with `
                    + `${CONFIGURATION_PATH_ARGUMENT} <path> or ${CONFIGURATION_PATH_VARIABLE}=<path>.\n`
                    + `A configuration to start from:\n${SAMPLE_CONFIGURATION}`
            });
        }

        if (code === 'EACCES' || code === 'EPERM') {
            throw new ConfigurationError(
                'not-readable',
                `Configuration file is not readable (permission denied): ${path}`,
                {path, cause: error}
            );
        }

        throw new ConfigurationError(
            'unreadable-file',
            `Configuration file could not be read (${code ?? 'unknown error'}): ${path}`,
            {path, cause: error}
        );
    }
}

function errorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as {code: unknown}).code;
        if (typeof code === 'string') {
            return code;
        }
    }

    return undefined;
}

function parseConfiguration(contents: string, path: string): unknown {
    try {
        return JSON.parse(contents);
    } catch (error) {
        // The parser already says where it stopped — by position and line, or by
        // quoting the place. Its trailing "is not valid JSON" only repeats ours.
        const reason = (error instanceof Error ? error.message : String(error))
            .replace(/\s*is not valid JSON$/, '');
        throw new ConfigurationError('not-json', `${path}: the file is not valid JSON (${reason})`, {
            path,
            cause: error
        });
    }
}

function validateConfiguration(value: unknown, path: string): Configuration {
    if (!isObject(value)) {
        reject('wrong-type', path, `configuration must be a JSON object, got ${typeName(value)}`);
    }

    const agents = value['agents'];
    if (agents === undefined) {
        reject('missing-field', path, 'agents is missing (expected an array of agents)');
    }
    if (!Array.isArray(agents)) {
        reject('wrong-type', path, `agents must be an array, got ${typeName(agents)}`);
    }
    if (agents.length === 0) {
        reject('empty-agent-list', path, 'agents must list at least one agent');
    }

    const checked: Agent[] = [];
    const places = new Map<string, number>();

    agents.forEach((entry: unknown, index: number) => {
        const agent = readAgent(entry, index, path);
        const seen = places.get(agent.name);

        if (seen !== undefined) {
            reject(
                'duplicate-agent-name',
                path,
                `agents[${index}].name repeats the name "${agent.name}" of agents[${seen}]`
            );
        }

        places.set(agent.name, index);
        checked.push(agent);
    });

    return {agents: checked};
}

function readAgent(entry: unknown, index: number, path: string): Agent {
    const place = `agents[${index}]`;

    if (!isObject(entry)) {
        reject('wrong-type', path, `${place} must be a JSON object, got ${typeName(entry)}`);
    }

    const workdir = optionalString(entry['workdir'], `${place}.workdir`, path);

    return {
        name: requiredString(entry['name'], `${place}.name`, path),
        command: requiredString(entry['command'], `${place}.command`, path),
        arguments: requiredStringArray(entry['arguments'], `${place}.arguments`, path),
        env: optionalEnvironment(entry['env'], `${place}.env`, path),
        restart: optionalRestartPolicy(entry['restart'], `${place}.restart`, path),
        heartbeatTimeoutSec: optionalPositiveNumber(
            entry['heartbeatTimeoutSec'],
            `${place}.heartbeatTimeoutSec`,
            path
        ),
        ...(workdir === undefined ? {} : {workdir})
    };
}

function requiredString(value: unknown, place: string, path: string): string {
    if (value === undefined) {
        reject('missing-field', path, `${place} is missing (expected a non-empty string)`);
    }

    return nonEmptyString(value, place, path);
}

function optionalString(value: unknown, place: string, path: string): string | undefined {
    return value === undefined ? undefined : nonEmptyString(value, place, path);
}

function nonEmptyString(value: unknown, place: string, path: string): string {
    if (typeof value !== 'string') {
        reject('wrong-type', path, `${place} must be a non-empty string, got ${typeName(value)}`);
    }
    if (value.trim() === '') {
        reject('wrong-type', path, `${place} must be a non-empty string, got an empty one`);
    }

    return value;
}

function requiredStringArray(value: unknown, place: string, path: string): string[] {
    if (value === undefined) {
        reject('missing-field', path, `${place} is missing (expected an array of strings)`);
    }
    if (!Array.isArray(value)) {
        reject('wrong-type', path, `${place} must be an array of strings, got ${typeName(value)}`);
    }

    return value.map((item: unknown, index: number) => {
        if (typeof item !== 'string') {
            reject('wrong-type', path, `${place}[${index}] must be a string, got ${typeName(item)}`);
        }

        return item;
    });
}

function optionalEnvironment(value: unknown, place: string, path: string): Record<string, string> {
    if (value === undefined) {
        return {};
    }
    if (!isObject(value)) {
        reject('wrong-type', path, `${place} must be a JSON object, got ${typeName(value)}`);
    }

    const variables: Record<string, string> = {};

    for (const [name, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            reject('wrong-type', path, `${place}.${name} must be a string, got ${typeName(item)}`);
        }

        variables[name] = item;
    }

    return variables;
}

function optionalRestartPolicy(value: unknown, place: string, path: string): RestartPolicy {
    if (value === undefined) {
        return DEFAULT_RESTART_POLICY;
    }

    const policy = RESTART_POLICIES.find((known: RestartPolicy) => known === value);
    if (policy === undefined) {
        const allowed = RESTART_POLICIES.map((known: RestartPolicy) => `"${known}"`).join(', ');
        reject('wrong-type', path, `${place} must be one of ${allowed}, got ${JSON.stringify(value) ?? typeName(value)}`);
    }

    return policy;
}

function optionalPositiveNumber(value: unknown, place: string, path: string): number {
    if (value === undefined) {
        return DEFAULT_HEARTBEAT_TIMEOUT_SEC;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        reject('wrong-type', path, `${place} must be a positive number, got ${JSON.stringify(value) ?? typeName(value)}`);
    }

    return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }

    return typeof value;
}

function reject(kind: ConfigurationErrorKind, path: string, detail: string): never {
    throw new ConfigurationError(kind, `${path}: ${detail}`, {path});
}

export {
    CONFIGURATION_PATH_ARGUMENT,
    CONFIGURATION_PATH_VARIABLE,
    DEFAULT_CONFIGURATION_PATH,
    DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    DEFAULT_RESTART_POLICY,
    SAMPLE_CONFIGURATION,
    loadConfiguration,
    resolveConfigurationLocation
};
export type {Environment, LoadConfigurationOptions, ResolveConfigurationOptions};
