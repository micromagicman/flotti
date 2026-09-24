import { isAbsolute, join, resolve } from 'node:path';
import { ConfigurationError } from './errors.js';
import type { ConfigurationErrorKind } from './errors.js';
import type {
    AgentBase,
    LocalAgent,
    LocalAgentAdapter,
    RemoteAgent,
    RemoteAuth,
    RemoteProtocol,
    RemoteSsh,
    RestartPolicy
} from './types.js';
import { parseTarget } from './ssh.js';
/** File in every agent directory that describes the agent. */
const MANIFEST_FILE = 'agent.json';
/** Optional file in a local agent directory with the agent's system prompt. */
const SYSTEM_PROMPT_FILE = 'system-prompt.md';
/** Directory in a local agent directory with the agent's own skills. */
const SKILLS_DIRECTORY = 'skills';
/** Directory in a local agent directory with the agent's memory bank. */
const MEMORY_DIRECTORY = 'memory';
/** Restart policy of an agent that does not name one. */
const DEFAULT_RESTART_POLICY: RestartPolicy = 'on-failure';
/** Heartbeat timeout of an agent that does not name one, in seconds. */
const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 60;
const RESTART_POLICIES: readonly RestartPolicy[] = ['always', 'on-failure', 'never'];
const ADAPTERS: readonly LocalAgentAdapter[] = ['claude-code', 'codex'];
const PROTOCOLS: readonly RemoteProtocol[] = ['a2a'];
const AUTH_TYPES: readonly RemoteAuth['type'][] = ['none', 'bearer', 'api-key'];
/** Names of environment variables: what a shell can export. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Ids of the agents a host publishes over SSH. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Names of HTTP headers: an RFC 9110 token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
type Environment = Readonly<Record<string, string | undefined>>;
type Fields = Record<string, unknown>;
/** Where a manifest lives, and what it needs besides its own contents. */
type ManifestContext = {
    /** Directory name of the agent. */
    readonly id: string;
    readonly directory: string;
    readonly manifestPath: string;
    /** For `~` in `workdir`. */
    readonly env: Environment;
    /** Whether `system-prompt.md` is there. */
    readonly hasSystemPrompt: boolean;
};
/** Local agent manifest a new user can start from. */
const SAMPLE_LOCAL_MANIFEST = `{
    "name": "Claude",
    "adapter": "claude-code",
    "command": "npx",
    "arguments": ["-y", "@agentclientprotocol/claude-agent-acp@0.81.1"]
}`;
/**
 * Checks the manifest of a local agent and fills in the documented defaults.
 *
 * @throws ConfigurationError naming the manifest and the field.
 */
function readLocalManifest(value: unknown, context: ManifestContext): LocalAgent {
    const fields = manifestObject(value, context);
    const at = (field: string) => ({ field, path: context.manifestPath });
    const adapter = optionalChoice(fields['adapter'], ADAPTERS, at('adapter'));
    const model = optionalString(fields['model'], at('model'));
    const workdir = optionalString(fields['workdir'], at('workdir'));
    const ssh = optionalHost(fields['ssh'], at('ssh'));
    return {
        ...agentBase(fields, context),
        kind: 'local',
        ...(adapter === undefined ? {} : { adapter }),
        ...(model === undefined ? {} : { model }),
        command: requiredString(fields['command'], at('command')),
        arguments: optionalStringArray(fields['arguments'], at('arguments')),
        ...(ssh === undefined ? {} : { ssh }),
        workdir: localWorkdir(workdir, ssh, context),
        ...localRuntime(fields, context)
    };
}
/** Working directory of a local agent: on the SSH host as written, here resolved against the agent directory. */
function localWorkdir(workdir: string | undefined, ssh: string | undefined, context: ManifestContext): string {
    return ssh !== undefined
        ? workdir?.trim() ?? '~'
        : workdir === undefined ? context.directory : workingDirectory(workdir, context);
}
/** Environment, restart and heartbeat of a local agent, and the files of its directory. */
function localRuntime(fields: Fields, context: ManifestContext) {
    const at = (field: string) => ({ field, path: context.manifestPath });
    return {
        env: optionalEnvironment(fields['env'], at('env')),
        restart: optionalChoice(fields['restart'], RESTART_POLICIES, at('restart')) ?? DEFAULT_RESTART_POLICY,
        heartbeatTimeoutSec: optionalPositiveNumber(fields['heartbeatTimeoutSec'], at('heartbeatTimeoutSec'))
            ?? DEFAULT_HEARTBEAT_TIMEOUT_SEC,
        ...(context.hasSystemPrompt ? { systemPromptFile: join(context.directory, SYSTEM_PROMPT_FILE) } : {}),
        skillsDirectory: join(context.directory, SKILLS_DIRECTORY),
        memoryDirectory: join(context.directory, MEMORY_DIRECTORY)
    };
}
/**
 * Checks the manifest of a remote agent and fills in the documented defaults.
 *
 * @throws ConfigurationError naming the manifest and the field.
 */
function readRemoteManifest(value: unknown, context: ManifestContext): RemoteAgent {
    const fields = manifestObject(value, context);
    const at = (field: string) => ({ field, path: context.manifestPath });
    const common = {
        ...agentBase(fields, context),
        kind: 'remote' as const,
        protocol: optionalChoice(fields['protocol'], PROTOCOLS, at('protocol')) ?? 'a2a',
        auth: optionalAuth(fields['auth'], at('auth'))
    };
    return { ...common, ...remoteAddress(fields, context) };
}
/** `url` of a remote agent reached directly, or `ssh` of one reached through a tunnel. */
function remoteAddress(fields: Fields, context: ManifestContext): { url: string } | { ssh: RemoteSsh } {
    const at = (field: string) => ({ field, path: context.manifestPath });
    if (fields['ssh'] === undefined) {
        return { url: directUrl(fields, context) };
    }
    if (fields['url'] !== undefined) {
        reject(
            'wrong-type',
            context.manifestPath,
            'url and ssh cannot both be given: over ssh, the host tells flotti where the agent is — drop url'
        );
    }
    return { ssh: sshAccess(fields['ssh'], at('ssh')) };
}
/** `url` of a remote agent reached without SSH; it must be there. */
function directUrl(fields: Fields, context: ManifestContext): string {
    if (fields['url'] === undefined) {
        reject(
            'missing-field',
            context.manifestPath,
            'url is missing: give the address of the agent, or "ssh": "user@host" to reach it through an SSH tunnel'
        );
    }
    return requiredUrl(fields['url'], { field: 'url', path: context.manifestPath });
}
/** `"ssh": "user@host"`, or `"ssh": {"target": "user@host", "agent": "<id>"}`. */
function sshAccess(value: unknown, place: Place): RemoteSsh {
    const fields: Fields = typeof value === 'string' ? { target: value } : isObject(value) ? value : {};
    if (typeof value !== 'string' && !isObject(value)) {
        reject('wrong-type', place.path, `${place.field} must be "user@host" or a JSON object, got ${typeName(value)}`);
    }
    const inside = (field: string): Place => ({ field: `${place.field}.${field}`, path: place.path });
    const target = requiredString(fields['target'], inside('target')).trim();
    try {
        parseTarget(target);
    } catch (error) {
        reject('wrong-type', place.path, `${inside('target').field}: ${(error as Error).message}`);
    }
    const agent = optionalString(fields['agent'], inside('agent'));
    if (agent !== undefined && !AGENT_ID_PATTERN.test(agent)) {
        reject('wrong-type', place.path, `${inside('agent').field} must be the id of a published agent, got ${shown(agent)}`);
    }
    return { target, ...(agent === undefined ? {} : { agent }) };
}
/** `"ssh": "user@host"` of a local agent: the host flotti starts it on. */
function optionalHost(value: unknown, place: Place): string | undefined {
    const target = optionalString(value, place)?.trim();
    if (target !== undefined) {
        try {
            parseTarget(target);
        } catch (error) {
            reject('wrong-type', place.path, `${place.field}: ${(error as Error).message}`);
        }
    }
    return target;
}
function manifestObject(value: unknown, context: ManifestContext): Fields {
    if (!isObject(value)) {
        reject('wrong-type', context.manifestPath, `the manifest must be a JSON object, got ${typeName(value)}`);
    }
    return value;
}
function agentBase(fields: Fields, context: ManifestContext): AgentBase {
    const at = (field: string) => ({ field, path: context.manifestPath });
    requireSameId(optionalString(fields['id'], at('id')), context);
    const description = optionalString(fields['description'], at('description'));
    const admin = optionalBoolean(fields['admin'], at('admin'));
    return {
        id: context.id,
        name: optionalString(fields['name'], at('name')) ?? context.id,
        ...(description === undefined ? {} : { description }),
        ...(admin === true ? { admin } : {}),
        directory: context.directory,
        manifestPath: context.manifestPath
    };
}
/** An `id` in the manifest must be the name of the directory: the directory is what counts. */
function requireSameId(id: string | undefined, context: ManifestContext): void {
    if (id !== undefined && id !== context.id) {
        reject(
            'id-mismatch',
            context.manifestPath,
            `id is "${id}", but the agent directory is "${context.id}"; the directory name is the id — `
            + 'rename the directory or drop the field'
        );
    }
}
function workingDirectory(workdir: string, context: ManifestContext): string {
    if (workdir === '~' || workdir.startsWith('~/') || workdir.startsWith('~\\')) {
        const home = context.env['HOME']?.trim() || context.env['USERPROFILE']?.trim();
        if (home === undefined || home === '') {
            reject(
                'unresolved-home',
                context.manifestPath,
                `workdir "${workdir}" starts with "~", but neither HOME nor USERPROFILE is set in the environment`
            );
        }
        return workdir === '~' ? home : join(home, workdir.slice(2));
    }
    return isAbsolute(workdir) ? workdir : resolve(context.directory, workdir);
}
/** A field of a manifest: its name and the file it is in. */
type Place = { readonly field: string; readonly path: string };
function requiredString(value: unknown, place: Place): string {
    if (value === undefined) {
        reject('missing-field', place.path, `${place.field} is missing (expected a non-empty string)`);
    }
    return nonEmptyString(value, place);
}
function optionalString(value: unknown, place: Place): string | undefined {
    return value === undefined ? undefined : nonEmptyString(value, place);
}
function nonEmptyString(value: unknown, place: Place): string {
    if (typeof value !== 'string') {
        reject('wrong-type', place.path, `${place.field} must be a non-empty string, got ${typeName(value)}`);
    }
    if (value.trim() === '') {
        reject('wrong-type', place.path, `${place.field} must be a non-empty string, got an empty one`);
    }
    return value;
}
function optionalBoolean(value: unknown, place: Place): boolean | undefined {
    if (value !== undefined && typeof value !== 'boolean') {
        reject('wrong-type', place.path, `${place.field} must be true or false, got ${shown(value)}`);
    }
    return value;
}
function optionalStringArray(value: unknown, place: Place): string[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        reject('wrong-type', place.path, `${place.field} must be an array of strings, got ${typeName(value)}`);
    }
    return value.map((item: unknown, index: number) => {
        if (typeof item !== 'string') {
            reject('wrong-type', place.path, `${place.field}[${index}] must be a string, got ${typeName(item)}`);
        }
        return item;
    });
}
function optionalEnvironment(value: unknown, place: Place): Record<string, string> {
    if (value === undefined) {
        return {};
    }
    if (!isObject(value)) {
        reject('wrong-type', place.path, `${place.field} must be a JSON object, got ${typeName(value)}`);
    }
    const variables: Record<string, string> = {};
    for (const [name, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            reject('wrong-type', place.path, `${place.field}.${name} must be a string, got ${typeName(item)}`);
        }
        variables[name] = item;
    }
    return variables;
}
function optionalChoice<T extends string>(value: unknown, choices: readonly T[], place: Place): T | undefined {
    if (value === undefined) {
        return undefined;
    }
    const choice = choices.find((known: T) => known === value);
    if (choice === undefined) {
        const allowed = choices.map((known: T) => `"${known}"`).join(', ');
        reject('wrong-type', place.path, `${place.field} must be one of ${allowed}, got ${shown(value)}`);
    }
    return choice;
}
function optionalPositiveNumber(value: unknown, place: Place): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        reject('wrong-type', place.path, `${place.field} must be a positive number, got ${shown(value)}`);
    }
    return value;
}
function requiredUrl(value: unknown, place: Place): string {
    const text = requiredString(value, place);
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        reject('wrong-type', place.path, `${place.field} must be an http: or https: address, got ${shown(text)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        reject('wrong-type', place.path, `${place.field} must be an http: or https: address, got ${shown(text)}`);
    }
    return text;
}
function optionalAuth(value: unknown, place: Place): RemoteAuth {
    if (value === undefined) {
        return { type: 'none' };
    }
    if (!isObject(value)) {
        reject('wrong-type', place.path, `${place.field} must be a JSON object, got ${typeName(value)}`);
    }
    const inside = (field: string): Place => ({ field: `${place.field}.${field}`, path: place.path });
    if (value['type'] === undefined) {
        reject('missing-field', place.path, `${place.field}.type is missing (expected "none", "bearer" or "api-key")`);
    }
    const type = optionalChoice(value['type'], AUTH_TYPES, inside('type'));
    return authOfType(type, value, inside);
}
/** The fields a chosen type of auth needs. */
function authOfType(type: RemoteAuth['type'] | undefined, value: Fields, inside: (field: string) => Place): RemoteAuth {
    if (type === 'bearer') {
        return { type, tokenEnv: variableName(value['tokenEnv'], inside('tokenEnv')) };
    }
    if (type === 'api-key') {
        return {
            type,
            header: headerName(value['header'], inside('header')),
            valueEnv: variableName(value['valueEnv'], inside('valueEnv'))
        };
    }
    return { type: 'none' };
}
function variableName(value: unknown, place: Place): string {
    const name = requiredString(value, place);
    if (!VARIABLE_NAME.test(name)) {
        reject(
            'wrong-type',
            place.path,
            `${place.field} must name an environment variable (letters, digits and "_"), got ${shown(name)}; `
            + 'the secret itself stays out of the manifest'
        );
    }
    return name;
}
function headerName(value: unknown, place: Place): string {
    const name = requiredString(value, place);
    if (!HEADER_NAME.test(name)) {
        reject('wrong-type', place.path, `${place.field} must be an HTTP header name, got ${shown(name)}`);
    }
    return name;
}
function isObject(value: unknown): value is Fields {
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
function shown(value: unknown): string {
    return JSON.stringify(value) ?? typeName(value);
}
function reject(kind: ConfigurationErrorKind, path: string, detail: string): never {
    throw new ConfigurationError(kind, `${path}: ${detail}`, { path });
}
export {
    DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    DEFAULT_RESTART_POLICY,
    MANIFEST_FILE,
    MEMORY_DIRECTORY,
    SAMPLE_LOCAL_MANIFEST,
    SKILLS_DIRECTORY,
    SYSTEM_PROMPT_FILE,
    readLocalManifest,
    readRemoteManifest
};
export type { Environment, ManifestContext };
