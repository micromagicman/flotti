import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
    AdminSettings,
    AgentConfig,
    AgentSummary,
    FleetInfo,
    LocalAgentConfig,
    RemoteAgentConfig,
    SshAgentsResponse
} from './dashboard-protocol.js';
import { ConfigurationError } from './errors.js';
import {
    AGENT_ID,
    LOCAL_DIRECTORY,
    REMOTE_DIRECTORY,
    loadFleet,
    prepareAgent,
    prepareFleet,
    readAgent,
    resolveFleetLocation
} from './fleet.js';
import { MANIFEST_FILE, SYSTEM_PROMPT_FILE, readLocalManifest, readRemoteManifest } from './manifest.js';
import type { Environment, ManifestContext } from './manifest.js';
import { readSettings, settingsFile, writeSettings } from './settings.js';
import { SshError, discover, parseTarget } from './ssh.js';
import type { PublishedAgent, SshTarget } from './ssh.js';
import type { Supervisor } from './supervisor.js';
import type { Agent, Fleet, FleetLocation, RemoteAgent } from './types.js';
/** Manifest fields the settings page edits; any other field of the file is kept as it is. */
const LOCAL_FIELDS = [
    'name',
    'description',
    'adapter',
    'model',
    'command',
    'arguments',
    'ssh',
    'workdir',
    'env',
    'restart',
    'heartbeatTimeoutSec',
    'admin'
] as const;
const REMOTE_FIELDS = ['name', 'description', 'url', 'ssh', 'auth', 'admin'] as const;
/**
 * Where a removed agent goes, in the fleet directory. Removing an agent
 * would otherwise take its memory bank and skills with it; from here they can
 * be brought back by hand. The leading dot keeps it out of the fleet.
 */
const TRASH_DIRECTORY = '.trash';
type Fields = Record<string, unknown>;
/** What the config of every agent has, local or remote. */
type CommonConfig = { readonly id: string; readonly name?: string; readonly description?: string; readonly admin?: boolean };
type FleetSettingsOptions = {
    /** Environment for `~` and the settings file; `process.env` by default. */
    readonly env?: Environment;
    /** How the agents a host publishes are asked for; over the real `ssh` by default. */
    readonly discover?: (target: SshTarget) => Promise<PublishedAgent[]>;
    /**
     * Called before the fleet directory changes, with the new fleet; throws to
     * refuse the change — another flotti runs that fleet.
     */
    readonly onSwitch?: (fleet: Fleet) => void;
};
function isObject(value: unknown): value is Fields {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** What the page may leave out: an empty field, list or map — or `false` — is a field left out of the file. */
function isBlank(value: unknown): boolean {
    return value === undefined
        || value === null
        || value === false
        || (typeof value === 'string' && value.trim() === '')
        || (Array.isArray(value) && value.length === 0)
        || (isObject(value) && Object.keys(value).length === 0)
        || (isObject(value) && value['type'] === 'none');
}
function invalid(message: string): ConfigurationError {
    return new ConfigurationError('wrong-type', message);
}
/** The body of a request that describes an agent: its kind, its id, the fields. */
function agentBody(body: unknown): { kind: Agent['kind']; id: string; fields: Fields; systemPrompt?: string } {
    if (!isObject(body)) {
        throw invalid('The agent must be a JSON object.');
    }
    const { kind, id, systemPrompt } = body;
    if (kind !== 'local' && kind !== 'remote') {
        throw invalid('kind must be "local" or "remote".');
    }
    if (typeof id !== 'string' || id.trim() === '') {
        throw new ConfigurationError('missing-field', 'id is missing: every agent needs one, it names its directory.');
    }
    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
        throw invalid('systemPrompt must be text.');
    }
    return { kind, id: id.trim(), fields: body, ...(systemPrompt === undefined ? {} : { systemPrompt }) };
}
/** The manifest to write: what the file had, with every field the page edits set or left out. */
function manifestFrom(kind: Agent['kind'], fields: Fields, kept: Fields): Fields {
    const manifest: Fields = { ...kept };
    for (const field of kind === 'local' ? LOCAL_FIELDS : REMOTE_FIELDS) {
        const value = fields[field];
        if (isBlank(value)) {
            delete manifest[field];
        } else {
            manifest[field] = typeof value === 'string' ? value.trim() : value;
        }
    }
    return manifest;
}
function readJson(path: string): Fields {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new ConfigurationError('not-json', `${path} could not be read as JSON; fix or remove the file by hand`, {
            path,
            cause: error
        });
    }
    if (!isObject(value)) {
        throw new ConfigurationError('wrong-type', `${path}: the manifest must be a JSON object`, { path });
    }
    return value;
}
function readText(path: string): string | undefined {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return undefined;
    }
}
function exists(path: string): boolean {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}
/** Written to a temporary file first and renamed, so a crash never leaves half a manifest. */
function writeAtomically(path: string, contents: string): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
}
function pick<T>(fields: Fields, name: string, check: (value: unknown) => boolean): T | undefined {
    const value = fields[name];
    return check(value) ? value as T : undefined;
}
const isString = (value: unknown): boolean => typeof value === 'string';
/** Whether a manifest's `ssh.target` leads to the same user, host and port. */
function sameDestination(target: string, place: SshTarget): boolean {
    try {
        const other = parseTarget(target);
        return other.destination === place.destination && other.port === place.port;
    } catch {
        return false;
    }
}
/** The `user@host` of a request to add agents over SSH, trimmed. */
function sshTarget(body: unknown): string {
    const given = isObject(body) ? body['target'] : undefined;
    if (typeof given !== 'string' || given.trim() === '') {
        throw new ConfigurationError('missing-field', 'target is missing: write where the agent is, as user@host.');
    }
    return given.trim();
}
/** `user@host` taken apart; a malformed one is a configuration error. */
function sshPlace(target: string): SshTarget {
    try {
        return parseTarget(target);
    } catch (error) {
        throw new ConfigurationError('wrong-type', `${(error as Error).message}.`, { cause: error });
    }
}
/** The remote agent of the fleet that already reaches the published agent over SSH, if there is one. */
function alreadyInFleet(fleet: readonly Agent[], place: SshTarget, agent: PublishedAgent): Agent | undefined {
    return fleet.find((member) => member.kind === 'remote'
        && member.ssh !== undefined
        && sameDestination(member.ssh.target, place)
        && (member.ssh.agent ?? agent.id) === agent.id);
}
/** @throws ConfigurationError when every agent the host publishes was in the fleet already. */
function requireAdded(added: readonly AgentSummary[], present: readonly string[], place: SshTarget): void {
    if (added.length === 0) {
        throw new ConfigurationError(
            'duplicate-agent-id',
            `Every agent ${place.destination} publishes is in the fleet already: ${present.join(', ')}.`
        );
    }
}
/** The path of a request to switch the fleet directory: absolute, or starting with `~`, trimmed. */
function fleetPath(body: unknown): string {
    const { path } = (isObject(body) ? body : {}) as { path?: unknown };
    if (typeof path !== 'string' || path.trim() === '') {
        throw new ConfigurationError('missing-field', 'path is missing: name the fleet directory.');
    }
    const given = path.trim();
    if (!isAbsolute(given) && given !== '~' && !given.startsWith('~/') && !given.startsWith('~\\')) {
        throw new ConfigurationError(
            'invalid-argument',
            `"${given}" is a relative path; give an absolute one, or one starting with ~`
        );
    }
    return given;
}
/** @throws ConfigurationError when something that is not a directory is at the path. */
function requireFleetDirectory(target: string): void {
    if (exists(target) && !statSync(target).isDirectory()) {
        throw new ConfigurationError('not-a-directory', `${target}: the fleet directory must be a directory`, {
            path: target
        });
    }
}
/** Checks the manifest the way `flotti run` would. */
function checkManifest(kind: Agent['kind'], manifest: Fields, context: ManifestContext): void {
    if (kind === 'local') {
        readLocalManifest(manifest, context);
    } else {
        readRemoteManifest(manifest, context);
    }
}
/** Writes `system-prompt.md` of a local agent, or removes it when there is no prompt. */
function writeSystemPrompt(directory: string, prompt: string | undefined): void {
    const promptPath = join(directory, SYSTEM_PROMPT_FILE);
    if (prompt === undefined) {
        rmSync(promptPath, { force: true });
    } else {
        writeAtomically(promptPath, prompt.endsWith('\n') ? prompt : `${prompt}\n`);
    }
}
/** The manifest as the file says it, for the page to edit: defaults are not filled in. */
function readConfig(agent: Agent): AgentConfig {
    const fields = readJson(agent.manifestPath);
    const common = {
        id: agent.id,
        ...(pick<string>(fields, 'name', isString) === undefined ? {} : { name: fields['name'] as string }),
        ...(pick<string>(fields, 'description', isString) === undefined ? {} : { description: fields['description'] as string }),
        ...(agent.admin === true ? { admin: true } : {})
    };
    if (agent.kind === 'remote') {
        return remoteConfig(agent, fields, common);
    }
    return localConfig(agent, fields, common);
}
/** {@link readConfig} of a remote agent. */
function remoteConfig(agent: RemoteAgent, fields: Fields, common: CommonConfig): RemoteAgentConfig {
    const url = pick<string>(fields, 'url', isString);
    const config: RemoteAgentConfig = {
        kind: 'remote',
        ...common,
        ...(agent.ssh === undefined ? { url: url ?? '' } : { ssh: agent.ssh }),
        ...(isObject(fields['auth']) ? { auth: fields['auth'] as unknown as RemoteAgentConfig['auth'] } : {})
    };
    return config;
}
/** {@link readConfig} of a local agent. */
function localConfig(agent: Agent, fields: Fields, common: CommonConfig): LocalAgentConfig {
    const optional: Fields = {};
    for (const field of LOCAL_FIELDS) {
        if (field !== 'name' && field !== 'description' && field !== 'command' && field !== 'admin' && fields[field] !== undefined) {
            optional[field] = fields[field];
        }
    }
    const systemPrompt = readText(join(agent.directory, SYSTEM_PROMPT_FILE));
    return {
        kind: 'local',
        ...common,
        ...optional,
        command: pick<string>(fields, 'command', isString) ?? '',
        ...(systemPrompt === undefined ? {} : { systemPrompt })
    } as LocalAgentConfig;
}
/**
 * The settings page at work: agents added, changed and removed by writing
 * their directories — the fleet stays files a person can read and edit — and
 * the fleet directory itself changed and remembered in the settings.
 * Every change is checked the way `flotti run` checks the fleet before a
 * file is written, and then put to work in the running fleet at once.
 */
class FleetSettings {
    private location: FleetLocation;
    private readonly pinnedBy: FleetInfo['pinnedBy'];
    private readonly env: Environment;
    constructor(fleet: Fleet, private readonly supervisor: Supervisor, private readonly options: FleetSettingsOptions = {}) {
        this.location = fleet.location;
        this.env = options.env ?? process.env;
        const source = fleet.location.source;
        this.pinnedBy = source === 'argument' || source === 'environment' ? source : undefined;
    }
    /** The fleet directory this run works with, and where it came from. */
    info(): FleetInfo {
        const file = settingsFile(this.env);
        return {
            path: this.location.path,
            source: this.location.source,
            ...(this.pinnedBy === undefined ? {} : { pinnedBy: this.pinnedBy }),
            ...(file === undefined ? {} : { settingsFile: file })
        };
    }
    /** The manifest of the agent as its file says it. */
    config(agentId: string): AgentConfig {
        return readConfig(this.supervisor.agent(agentId));
    }
    /**
     * Writes the directory of a new agent and starts it.
     *
     * @throws ConfigurationError when the agent is not one `flotti run` would take.
     */
    create(body: unknown): AgentSummary {
        const { kind, id, fields, systemPrompt } = agentBody(body);
        if (!AGENT_ID.test(id)) {
            throw new ConfigurationError(
                'invalid-agent-id',
                `"${id}" cannot be an agent id — use letters, digits, ".", "_" and "-", starting with a letter or a digit`
            );
        }
        const taken = this.supervisor.agents().some((agent) => agent.id === id)
            || [LOCAL_DIRECTORY, REMOTE_DIRECTORY].some((group) => exists(join(this.location.path, group, id)));
        if (taken) {
            throw new ConfigurationError(
                'duplicate-agent-id',
                `The id "${id}" is already taken in this fleet; ids are shared by local and remote agents`
            );
        }
        const agent = this.write(kind, id, manifestFrom(kind, fields, {}), systemPrompt);
        this.supervisor.add(agent);
        return this.summary(id);
    }
    /**
     * Adds a remote agent in one step, from nothing but `user@host`: asks the
     * host over SSH which agents it publishes, writes a remote agent reached
     * through a tunnel for each one the fleet does not have yet, and starts it.
     *
     * @throws ConfigurationError saying why: the address, SSH itself, or what the host publishes.
     */
    async addOverSsh(body: unknown): Promise<SshAgentsResponse> {
        const target = sshTarget(body);
        const { place, published } = await this.published(target);
        const fleet = this.supervisor.agents().map((summary) => this.supervisor.agent(summary.id));
        const present: string[] = [];
        const added: AgentSummary[] = [];
        for (const agent of published) {
            const already = alreadyInFleet(fleet, place, agent);
            if (already !== undefined) {
                present.push(already.id);
                continue;
            }
            added.push(this.addPublished(target, place, agent));
        }
        requireAdded(added, present, place);
        return { added, ...(present.length === 0 ? {} : { present }) };
    }
    /** Writes a remote agent reached through a tunnel to one the host publishes, and starts it. */
    private addPublished(target: string, place: SshTarget, agent: PublishedAgent): AgentSummary {
        const id = this.freeId(agent.id, place.host);
        const manifest: Fields = {
            name: agent.name ?? agent.id,
            ...(agent.description === undefined ? {} : { description: agent.description }),
            ssh: { target, agent: agent.id }
        };
        this.supervisor.add(this.write('remote', id, manifest, undefined));
        return this.summary(id);
    }
    /** What the host publishes; at least one agent, or a reason why not. */
    private async published(target: string): Promise<{ place: SshTarget; published: PublishedAgent[] }> {
        const place = sshPlace(target);
        const published = await this.discoverOn(place);
        if (published.length === 0) {
            throw new ConfigurationError(
                'ssh-failed',
                `${place.destination} publishes no agent: ~/.flotti/a2a/ on it has no .json file. The A2A adapter `
                + 'of the agent writes one there when it starts; see docs/a2a-ssh.md.'
            );
        }
        return { place, published };
    }
    /** Asks the host which agents it publishes; an SSH failure is a configuration error. */
    private async discoverOn(place: SshTarget): Promise<PublishedAgent[]> {
        try {
            return await (this.options.discover ?? ((at: SshTarget) => discover(at)))(place);
        } catch (error) {
            if (error instanceof SshError) {
                throw new ConfigurationError('ssh-failed', `${error.message}.`, { cause: error });
            }
            throw error;
        }
    }
    /** The id itself when it is free, else the id with the host, else with a number. */
    private freeId(id: string, host: string): string {
        const taken = (candidate: string) => this.supervisor.agents().some((agent) => agent.id === candidate)
            || [LOCAL_DIRECTORY, REMOTE_DIRECTORY].some((group) => exists(join(this.location.path, group, candidate)));
        const withHost = `${id}-${host.replace(/[^A-Za-z0-9._-]/g, '-')}`;
        for (const candidate of [id, withHost]) {
            if (AGENT_ID.test(candidate) && !taken(candidate)) {
                return candidate;
            }
        }
        for (let number = 2; ; number++) {
            if (!taken(`${withHost}-${number}`)) {
                return `${withHost}-${number}`;
            }
        }
    }
    /**
     * Writes the changed manifest and puts it to work: the agent is restarted
     * with it, unless it was stopped.
     */
    async update(agentId: string, body: unknown): Promise<AgentSummary> {
        const current = this.supervisor.agent(agentId);
        const { kind, fields, systemPrompt } = agentBody({ ...(isObject(body) ? body : {}), id: agentId });
        if (kind !== current.kind) {
            throw invalid(`"${agentId}" is a ${current.kind} agent; a ${kind} one is a new agent with an id of its own.`);
        }
        let kept: Fields = {};
        try {
            kept = readJson(current.manifestPath);
        } catch {
            // A manifest broken by hand is replaced by what the page sends.
        }
        const agent = this.write(kind, agentId, manifestFrom(kind, fields, kept), systemPrompt);
        await this.supervisor.replace(agent);
        return this.summary(agentId);
    }
    /**
     * Stops the agent, takes it out of the fleet and moves its directory to
     * `.trash` in the fleet directory — with its memory bank and skills.
     *
     * @returns Where the directory went; `undefined` when it was gone already.
     */
    async remove(agentId: string): Promise<string | undefined> {
        const agent = this.supervisor.agent(agentId);
        await this.supervisor.remove(agentId);
        if (!exists(agent.directory)) {
            return undefined;
        }
        const trash = join(this.location.path, TRASH_DIRECTORY);
        mkdirSync(trash, { recursive: true });
        const target = join(trash, `${agent.kind}-${agent.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(agent.directory, target);
        return target;
    }
    /**
     * Works with another fleet directory from now on and saves it in the
     * settings, so the next `flotti run` opens it too. The agents of the old
     * fleet are stopped, those of the new one started. A directory that is not
     * there yet is created: that is how a new fleet begins.
     *
     * @throws ConfigurationError when the directory holds a fleet `flotti run` would refuse.
     */
    async switchTo(body: unknown): Promise<FleetInfo> {
        const given = fleetPath(body);
        const target = resolveFleetLocation({ argv: ['--fleet', given], env: this.env }).path;
        requireFleetDirectory(target);
        mkdirSync(target, { recursive: true });
        const fleet = loadFleet({ argv: ['--fleet', target], env: this.env });
        if (target !== this.location.path) {
            this.options.onSwitch?.(fleet);
        }
        writeSettings(this.env, { fleet: target });
        prepareFleet(fleet);
        const moved = target !== this.location.path;
        this.location = { path: target, source: 'settings' };
        if (moved) {
            await this.supervisor.load(fleet);
        }
        return this.info();
    }
    /** Whether actions of administrators wait for a person, as the settings file says. */
    adminSettings(): AdminSettings {
        return { confirmActions: readSettings(this.env).confirmAdminActions === true };
    }
    /**
     * Turns the confirmation of administrator actions on or off, in the
     * settings file: it holds for the next action, and for the next runs.
     */
    setAdminSettings(body: unknown): AdminSettings {
        const { confirmActions } = (isObject(body) ? body : {}) as Partial<AdminSettings>;
        if (typeof confirmActions !== 'boolean') {
            throw invalid('confirmActions must be true or false.');
        }
        writeSettings(this.env, { confirmAdminActions: confirmActions });
        return this.adminSettings();
    }
    /**
     * Checks the manifest the way `flotti run` would, and only then writes the
     * agent directory.
     */
    private write(kind: Agent['kind'], id: string, manifest: Fields, systemPrompt: string | undefined): Agent {
        const directory = join(this.location.path, kind === 'local' ? LOCAL_DIRECTORY : REMOTE_DIRECTORY, id);
        const prompt = kind === 'local' && systemPrompt !== undefined && systemPrompt.trim() !== '' ? systemPrompt : undefined;
        const context: ManifestContext = {
            id,
            directory,
            manifestPath: join(directory, MANIFEST_FILE),
            env: this.env,
            hasSystemPrompt: prompt !== undefined
        };
        checkManifest(kind, manifest, context);
        mkdirSync(directory, { recursive: true });
        writeAtomically(context.manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
        if (kind === 'local') {
            writeSystemPrompt(directory, prompt);
        }
        const agent = readAgent(this.location.path, kind, id, this.env);
        prepareAgent(agent);
        return agent;
    }
    private summary(agentId: string): AgentSummary {
        const found = this.supervisor.agents().find((agent) => agent.id === agentId);
        if (found === undefined) {
            throw new Error(`The agent "${agentId}" is not in the fleet.`);
        }
        return found;
    }
}
export { FleetSettings, TRASH_DIRECTORY };
export type { FleetSettingsOptions };
