import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigurationError } from './errors.js';
import {
    MANIFEST_FILE,
    SAMPLE_LOCAL_MANIFEST,
    SYSTEM_PROMPT_FILE,
    readLocalManifest,
    readRemoteManifest
} from './manifest.js';
import type { Environment, ManifestContext } from './manifest.js';
import { readSettings } from './settings.js';
import type { Agent, Fleet, FleetLocation, LocalAgent } from './types.js';
/** Command line argument that points flotti at a fleet directory. */
const FLEET_PATH_ARGUMENT = '--fleet';
/** Environment variable that points flotti at a fleet directory. */
const FLEET_PATH_VARIABLE = 'FLOTTI_FLEET';
/** Where flotti looks when neither the argument nor the variable is given. */
const DEFAULT_FLEET_PATH = '~/.flotti/agents';
/** Directory of the fleet with the agents flotti starts itself. */
const LOCAL_DIRECTORY = 'local';
/** Directory of the fleet with the agents that run elsewhere. */
const REMOTE_DIRECTORY = 'remote';
/** What an agent directory may be called: it is the agent id, and ids end up in addresses. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
type ResolveFleetOptions = {
    /** Command line arguments without the node binary and the script; defaults to the real ones. */
    readonly argv?: readonly string[];
    /** Environment to read the variable and the home directory from; defaults to `process.env`. */
    readonly env?: Environment;
    /** Directory a relative path is resolved against; defaults to `process.cwd()`. */
    readonly cwd?: string;
};
type LoadFleetOptions = ResolveFleetOptions & {
    /** How to read a manifest; defaults to reading it from disk as UTF-8. */
    readonly readFile?: (path: string) => string;
};
/**
 * Decides which fleet directory to read: the argument wins over the
 * environment variable, the variable over the directory the dashboard saved
 * in the settings, and that over the default path. `~` is
 * expanded here and not by the shell, because under `npx` there is no shell
 * to do it.
 */
function resolveFleetLocation(options: ResolveFleetOptions = {}): FleetLocation {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const fromArgument = fleetPathArgument(argv);
    if (fromArgument !== undefined) {
        return { path: absolutePath(fromArgument, env, cwd), source: 'argument' };
    }
    const fromEnvironment = env[FLEET_PATH_VARIABLE]?.trim();
    if (fromEnvironment !== undefined && fromEnvironment !== '') {
        return { path: absolutePath(fromEnvironment, env, cwd), source: 'environment' };
    }
    const saved = readSettings(env).fleet;
    if (saved !== undefined) {
        return { path: absolutePath(saved, env, cwd), source: 'settings' };
    }
    return { path: absolutePath(DEFAULT_FLEET_PATH, env, cwd), source: 'default' };
}
/**
 * Reads and checks every agent of the fleet. Starting agents, heartbeats and
 * restarts are somebody else's job: this only hands over checked values, and
 * writes nothing — {@link prepareFleet} creates what is missing.
 *
 * @throws ConfigurationError with a message a human can act on.
 */
function loadFleet(options: LoadFleetOptions = {}): Fleet {
    const location = resolveFleetLocation(options);
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? readFileFromDisk;
    const root = inspect(location.path);
    if (root === undefined) {
        return missingFleet(location);
    }
    requireDirectory(root, location.path, 'the fleet directory');
    const local = agentDirectories(join(location.path, LOCAL_DIRECTORY)).map((id: string) =>
        readLocalManifest(...manifest(location.path, LOCAL_DIRECTORY, id, env, readFile)));
    const remote = agentDirectories(join(location.path, REMOTE_DIRECTORY)).map((id: string) =>
        readRemoteManifest(...manifest(location.path, REMOTE_DIRECTORY, id, env, readFile)));
    requireUniqueIds(local, remote);
    return { location, exists: true, agents: [...local, ...remote] };
}
/**
 * The fleet whose directory is not there: an empty one at the default or saved
 * path, an error when the user named the path.
 *
 * @throws ConfigurationError when the argument or the variable named the missing directory.
 */
function missingFleet(location: FleetLocation): Fleet {
    if (location.source === 'argument' || location.source === 'environment') {
        throw new ConfigurationError('missing-fleet', `Fleet directory not found: ${location.path}`, {
            path: location.path,
            hint: `It was named by ${location.source === 'argument' ? FLEET_PATH_ARGUMENT : FLEET_PATH_VARIABLE}; `
                + 'check the path, or create the directory.'
        });
    }
    return { location, exists: false, agents: [] };
}
/**
 * Creates the directories a local agent owns but flotti never reads —
 * `skills/` and `memory/` — where they are missing.
 *
 * @returns Paths it created.
 * @throws ConfigurationError when one of them is taken by something that is not a directory.
 */
function prepareFleet(fleet: Fleet): string[] {
    return fleet.agents.flatMap((agent: Agent) => prepareAgent(agent));
}
/** {@link prepareFleet} for one agent; nothing to do for a remote one. */
function prepareAgent(agent: Agent): string[] {
    if (agent.kind !== 'local') {
        return [];
    }
    const created: string[] = [];
    for (const directory of [agent.skillsDirectory, agent.memoryDirectory]) {
        const found = inspect(directory);
        if (found === undefined) {
            mkdirSync(directory, { recursive: true });
            created.push(directory);
        } else {
            requireDirectory(found, directory, `a directory of agent "${agent.id}"`);
        }
    }
    return created;
}
/**
 * Reads one agent of the fleet from its directory, the way {@link loadFleet}
 * reads each of them.
 *
 * @throws ConfigurationError with a message a human can act on.
 */
function readAgent(root: string, kind: Agent['kind'], id: string, env: Environment = process.env): Agent {
    const group = kind === 'local' ? LOCAL_DIRECTORY : REMOTE_DIRECTORY;
    const found = manifest(root, group, id, env, readFileFromDisk);
    return kind === 'local' ? readLocalManifest(...found) : readRemoteManifest(...found);
}
function manifest(
    root: string,
    group: string,
    id: string,
    env: Environment,
    readFile: (path: string) => string
): [unknown, ManifestContext] {
    const directory = join(root, group, id);
    const manifestPath = join(directory, MANIFEST_FILE);
    const contents = readManifest(manifestPath, readFile);
    const prompt = systemPrompt(directory, group);
    return [
        parseManifest(contents, manifestPath),
        { id, directory, manifestPath, env, hasSystemPrompt: prompt !== undefined }
    ];
}
/** What is at `system-prompt.md` of a local agent; `undefined` when it is absent or the agent is remote. */
function systemPrompt(directory: string, group: string): Stats | undefined {
    const prompt = group === LOCAL_DIRECTORY ? inspect(join(directory, SYSTEM_PROMPT_FILE)) : undefined;
    if (prompt !== undefined && !prompt.isFile()) {
        throw new ConfigurationError(
            'wrong-type',
            `${join(directory, SYSTEM_PROMPT_FILE)}: the system prompt must be a file`,
            { path: join(directory, SYSTEM_PROMPT_FILE) }
        );
    }
    return prompt;
}
/** Names of the agent directories in `local/` or `remote/`, ordered; none when the directory is absent. */
function agentDirectories(path: string): string[] {
    const found = inspect(path);
    if (found === undefined) {
        return [];
    }
    requireDirectory(found, path, 'a fleet group');
    const names = listDirectory(path).filter((name: string) => !name.startsWith('.')).sort();
    for (const name of names) {
        requireAgentDirectory(path, name);
    }
    return names;
}
/** Checks that an entry of a fleet group is a directory named like an agent id. */
function requireAgentDirectory(path: string, name: string): void {
    const entry = join(path, name);
    const stats = inspect(entry);
    if (stats === undefined || !stats.isDirectory()) {
        throw new ConfigurationError(
            'not-a-directory',
            `${entry}: every agent is a directory with ${MANIFEST_FILE} in it, and this is not a directory`,
            { path: entry }
        );
    }
    if (!AGENT_ID.test(name)) {
        throw new ConfigurationError(
            'invalid-agent-id',
            `${entry}: "${name}" cannot be an agent id — use letters, digits, ".", "_" and "-", `
            + 'starting with a letter or a digit',
            { path: entry }
        );
    }
}
function requireUniqueIds(local: readonly LocalAgent[], remote: readonly Agent[]): void {
    const localIds = new Map(local.map((agent: LocalAgent) => [agent.id, agent.directory]));
    for (const agent of remote) {
        const twin = localIds.get(agent.id);
        if (twin !== undefined) {
            throw new ConfigurationError(
                'duplicate-agent-id',
                `${agent.directory}: the id "${agent.id}" is already taken by the local agent ${twin}; `
                + 'ids are shared by local and remote agents',
                { path: agent.directory }
            );
        }
    }
}
function fleetPathArgument(argv: readonly string[]): string | undefined {
    let path: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument.startsWith(`${FLEET_PATH_ARGUMENT}=`)) {
            path = argument.slice(FLEET_PATH_ARGUMENT.length + 1);
        } else if (argument === FLEET_PATH_ARGUMENT) {
            path = argv[index + 1];
            index += 1;
        } else {
            continue;
        }
        path = fleetPathValue(path);
    }
    return path;
}
/** The path given to `--fleet`, trimmed. */
function fleetPathValue(path: string | undefined): string {
    if (path === undefined || path.trim() === '') {
        throw new ConfigurationError(
            'invalid-argument',
            `${FLEET_PATH_ARGUMENT} requires a path, for example ${FLEET_PATH_ARGUMENT} ${DEFAULT_FLEET_PATH}`
        );
    }
    return path.trim();
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
            { hint: `Pass an absolute path with ${FLEET_PATH_ARGUMENT} <path> or ${FLEET_PATH_VARIABLE}=<path>.` }
        );
    }
    return path === '~' ? home : join(home, path.slice(2));
}
/** What is at the path, following links; `undefined` when nothing is. */
function inspect(path: string): Stats | undefined {
    try {
        return statSync(path);
    } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return undefined;
        }
        throw readFailure(error, path, 'Path');
    }
}
function requireDirectory(stats: Stats, path: string, what: string): void {
    if (!stats.isDirectory()) {
        throw new ConfigurationError('not-a-directory', `${path}: ${what} must be a directory`, { path });
    }
}
function listDirectory(path: string): string[] {
    try {
        return readdirSync(path);
    } catch (error) {
        throw readFailure(error, path, 'Directory');
    }
}
function readFileFromDisk(path: string): string {
    return readFileSync(path, 'utf8');
}
function readManifest(path: string, readFile: (path: string) => string): string {
    try {
        return readFile(path);
    } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw new ConfigurationError('missing-manifest', `Agent manifest not found: ${path}`, {
                path,
                cause: error,
                hint: `Every agent directory needs ${MANIFEST_FILE}. One to start from:\n${SAMPLE_LOCAL_MANIFEST}`
            });
        }
        if (code === 'EISDIR') {
            throw new ConfigurationError('not-a-directory', `${path}: the manifest must be a file`, { path });
        }
        throw readFailure(error, path, 'Agent manifest');
    }
}
function readFailure(error: unknown, path: string, what: string): ConfigurationError {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
        return new ConfigurationError('not-readable', `${what} is not readable (permission denied): ${path}`, {
            path,
            cause: error
        });
    }
    return new ConfigurationError(
        'unreadable-file',
        `${what} could not be read (${code ?? 'unknown error'}): ${path}`,
        { path, cause: error }
    );
}
function errorCode(error: unknown): string | undefined {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code: unknown }).code;
        if (typeof code === 'string') {
            return code;
        }
    }
    return undefined;
}
function parseManifest(contents: string, path: string): unknown {
    try {
        return JSON.parse(contents);
    } catch (error) {
        // The parser already says where it stopped — by position and line, or by
        // quoting the place. Its trailing "is not valid JSON" only repeats ours.
        const reason = (error instanceof Error ? error.message : String(error))
            .replace(/\s*is not valid JSON$/, '');
        throw new ConfigurationError('not-json', `${path}: the manifest is not valid JSON (${reason})`, {
            path,
            cause: error
        });
    }
}
export {
    AGENT_ID,
    DEFAULT_FLEET_PATH,
    FLEET_PATH_ARGUMENT,
    FLEET_PATH_VARIABLE,
    LOCAL_DIRECTORY,
    REMOTE_DIRECTORY,
    loadFleet,
    prepareAgent,
    prepareFleet,
    readAgent,
    resolveFleetLocation
};
export type { LoadFleetOptions, ResolveFleetOptions };
