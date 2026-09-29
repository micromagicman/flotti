import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { ConfigurationErrorKind } from './errors.js';
import { GROUPS_DIRECTORY, GROUP_FILE, SAMPLE_GROUP, parseGroup } from './groups.js';
import {
    MANIFEST_FILE,
    SAMPLE_LOCAL_MANIFEST,
    SYSTEM_PROMPT_FILE,
    readLocalManifest,
    readRemoteManifest
} from './manifest.js';
import type { Environment, ManifestContext } from './manifest.js';
import { readSettings } from './settings.js';
import type { Agent, Fleet, FleetLocation, FleetSource, Group, LocalAgent } from './types.js';
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
/** Error codes that mean nothing is at the path. */
const MISSING_CODES: ReadonlySet<string | undefined> = new Set([ 'ENOENT', 'ENOTDIR' ]);
/** What the entries of a directory of the fleet are — agents, or groups — for the complaints about them. */
type Entries = {
    /** The file every entry must hold. */
    readonly file: string;
    /** What an entry is, in a sentence. */
    readonly noun: 'agent' | 'group';
    /** What the file is, in a sentence. */
    readonly what: 'manifest' | 'group file';
    /** What the file is, at the start of a sentence. */
    readonly label: 'Agent manifest' | 'Group file';
    readonly idName: 'an agent id' | 'a group id';
    /** What the directory of the entries is. */
    readonly place: string;
    readonly invalidId: ConfigurationErrorKind;
    readonly missing: ConfigurationErrorKind;
    /** A file to start from, offered when one is missing. */
    readonly sample: string;
};
const AGENT_ENTRIES: Entries = {
    file: MANIFEST_FILE,
    noun: 'agent',
    what: 'manifest',
    label: 'Agent manifest',
    idName: 'an agent id',
    place: 'a fleet group',
    invalidId: 'invalid-agent-id',
    missing: 'missing-manifest',
    sample: SAMPLE_LOCAL_MANIFEST
};
const GROUP_ENTRIES: Entries = {
    file: GROUP_FILE,
    noun: 'group',
    what: 'group file',
    label: 'Group file',
    idName: 'a group id',
    place: 'the groups directory',
    invalidId: 'invalid-group-id',
    missing: 'missing-group-file',
    sample: SAMPLE_GROUP
};
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
    const { env, cwd } = placeOptions(options);
    const found = fleetPath(argv, env);
    return { path: absolutePath(found.path, env, cwd), source: found.source };
}
/** Where the fleet path was looked up, in the order of precedence; each place is read only when the ones before it gave nothing. */
const FLEET_PATH_PLACES: readonly (readonly [FleetSource, (argv: readonly string[], env: Environment) => string | undefined])[] = [
    [ 'argument', (argv: readonly string[]) => fleetPathArgument(argv) ],
    [ 'environment', (_argv: readonly string[], env: Environment) => nonEmpty(env[FLEET_PATH_VARIABLE]) ],
    [ 'settings', (_argv: readonly string[], env: Environment) => readSettings(env).fleet ]
];
/** The fleet path as given, not yet expanded, and the place it came from. */
function fleetPath(argv: readonly string[], env: Environment): { path: string; source: FleetSource } {
    for (const [ source, read ] of FLEET_PATH_PLACES) {
        const path = read(argv, env);
        if (path !== undefined) {
            return { path, source };
        }
    }
    return { path: DEFAULT_FLEET_PATH, source: 'default' };
}
/** The environment and the working directory of the options, with their defaults. */
function placeOptions(options: ResolveFleetOptions): { env: Environment; cwd: string } {
    return { env: options.env ?? process.env, cwd: options.cwd ?? process.cwd() };
}
/** The value trimmed; `undefined` when it is missing or blank. */
function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
}
/**
 * Reads and checks every agent and every group of the fleet. Starting agents,
 * heartbeats and restarts are somebody else's job: this only hands over
 * checked values, and writes nothing — {@link prepareFleet} creates what is
 * missing. A fleet without `groups/` has no groups: none is made for it.
 *
 * @throws ConfigurationError with a message a human can act on.
 */
function loadFleet(options: LoadFleetOptions = {}): Fleet {
    const location = resolveFleetLocation(options);
    const { env } = placeOptions(options);
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
    const groups = entryDirectories(join(location.path, GROUPS_DIRECTORY), GROUP_ENTRIES)
        .map((id: string) => readGroup(location.path, id, readFile));
    return { location, exists: true, agents: [...local, ...remote], groups };
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
    return { location, exists: false, agents: [], groups: [] };
}
/**
 * Creates the directories a local agent owns and flotti never writes to —
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
/**
 * Reads one group of the fleet from its directory, the way {@link loadFleet}
 * reads each of them.
 *
 * @throws ConfigurationError with a message a human can act on.
 */
function readGroup(root: string, id: string, readFile: (path: string) => string = readFileFromDisk): Group {
    const directory = join(root, GROUPS_DIRECTORY, id);
    const filePath = join(directory, GROUP_FILE);
    const contents = readEntryFile(filePath, readFile, GROUP_ENTRIES);
    return parseGroup(parseJson(contents, filePath, GROUP_ENTRIES), { id, directory, filePath });
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
    const contents = readEntryFile(manifestPath, readFile, AGENT_ENTRIES);
    const prompt = systemPrompt(directory, group);
    return [
        parseJson(contents, manifestPath, AGENT_ENTRIES),
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
    return entryDirectories(path, AGENT_ENTRIES);
}
/** Names of the entry directories — agents, or groups — in the directory, ordered; none when it is absent. */
function entryDirectories(path: string, entries: Entries): string[] {
    const found = inspect(path);
    if (found === undefined) {
        return [];
    }
    requireDirectory(found, path, entries.place);
    const names = listDirectory(path).filter((name: string) => !name.startsWith('.')).sort();
    for (const name of names) {
        requireEntryDirectory(path, name, entries);
    }
    return names;
}
/** Checks that an entry of the directory is a directory named like an id. */
function requireEntryDirectory(path: string, name: string, entries: Entries): void {
    const entry = join(path, name);
    const stats = inspect(entry);
    if (stats === undefined || !stats.isDirectory()) {
        throw new ConfigurationError(
            'not-a-directory',
            `${entry}: every ${entries.noun} is a directory with ${entries.file} in it, and this is not a directory`,
            { path: entry }
        );
    }
    if (!AGENT_ID.test(name)) {
        throw new ConfigurationError(
            entries.invalidId,
            `${entry}: "${name}" cannot be ${entries.idName} — use letters, digits, ".", "_" and "-", `
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
        const found = fleetPathAt(argv, index);
        if (found !== undefined) {
            path = fleetPathValue(found.value);
            index += found.skip;
        }
    }
    return path;
}
/** The `--fleet` value at the argument, and how many following arguments it took; `undefined` for other arguments. */
function fleetPathAt(argv: readonly string[], index: number): { value: string | undefined; skip: number } | undefined {
    const argument = argv[index] ?? '';
    if (argument.startsWith(`${FLEET_PATH_ARGUMENT}=`)) {
        return { value: argument.slice(FLEET_PATH_ARGUMENT.length + 1), skip: 0 };
    }
    return argument === FLEET_PATH_ARGUMENT ? { value: argv[index + 1], skip: 1 } : undefined;
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
    if (!startsAtHome(path)) {
        return path;
    }
    const home = homeDirectory(path, env);
    return path === '~' ? home : join(home, path.slice(2));
}
function startsAtHome(path: string): boolean {
    return path === '~' || path.startsWith('~/') || path.startsWith('~\\');
}
function homeDirectory(path: string, env: Environment): string {
    const home = nonEmpty(env['HOME']) ?? nonEmpty(env['USERPROFILE']);
    if (home === undefined) {
        throw new ConfigurationError(
            'unresolved-home',
            `Cannot expand "~" in ${path}: neither HOME nor USERPROFILE is set in the environment`,
            { hint: `Pass an absolute path with ${FLEET_PATH_ARGUMENT} <path> or ${FLEET_PATH_VARIABLE}=<path>.` }
        );
    }
    return home;
}
/** What is at the path, following links; `undefined` when nothing is. */
function inspect(path: string): Stats | undefined {
    try {
        return statSync(path);
    } catch (error) {
        if (MISSING_CODES.has(errorCode(error))) {
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
/** The file of an entry — a manifest, or a group file — as text. */
function readEntryFile(path: string, readFile: (path: string) => string, entries: Entries): string {
    try {
        return readFile(path);
    } catch (error) {
        throw entryReadFailure(error, path, entries);
    }
}
function entryReadFailure(error: unknown, path: string, entries: Entries): ConfigurationError {
    const code = errorCode(error);
    if (MISSING_CODES.has(code)) {
        return new ConfigurationError(entries.missing, `${entries.label} not found: ${path}`, {
            path,
            cause: error,
            hint: `Every ${entries.noun} directory needs ${entries.file}. One to start from:\n${entries.sample}`
        });
    }
    if (code === 'EISDIR') {
        return new ConfigurationError('not-a-directory', `${path}: the ${entries.what} must be a file`, { path });
    }
    return readFailure(error, path, entries.label);
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
    const code = hasCode(error) ? error.code : undefined;
    return typeof code === 'string' ? code : undefined;
}
function hasCode(error: unknown): error is { code: unknown } {
    return typeof error === 'object' && error !== null && 'code' in error;
}
function parseJson(contents: string, path: string, entries: Entries): unknown {
    try {
        return JSON.parse(contents);
    } catch (error) {
        // The parser already says where it stopped — by position and line, or by
        // quoting the place. Its trailing "is not valid JSON" only repeats ours.
        const reason = (error instanceof Error ? error.message : String(error))
            .replace(/\s*is not valid JSON$/, '');
        throw new ConfigurationError('not-json', `${path}: the ${entries.what} is not valid JSON (${reason})`, {
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
    readGroup,
    resolveFleetLocation
};
export type { LoadFleetOptions, ResolveFleetOptions };
