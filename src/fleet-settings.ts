import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
    AdminSettings,
    AgentConfig,
    AgentSummary,
    FleetInfo,
    GroupConfig,
    GroupSummary,
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
    readGroup,
    resolveFleetLocation
} from './fleet.js';
import { GROUPS_DIRECTORY, GROUP_FILE, parseGroup } from './groups.js';
import { MANIFEST_FILE, SYSTEM_PROMPT_FILE, readLocalManifest, readRemoteManifest } from './manifest.js';
import type { Environment, ManifestContext } from './manifest.js';
import { readSettings, settingsFile, writeSettings } from './settings.js';
import { SshError, discover, parseTarget } from './ssh.js';
import type { PublishedAgent, SshTarget } from './ssh.js';
import type { Supervisor } from './supervisor.js';
import type { Agent, Fleet, FleetLocation, Group, RemoteAgent } from './types.js';
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
/** Group fields the settings page edits besides `members`; any other field of the file is kept as it is. */
const GROUP_FIELDS = ['name', 'topic'] as const;
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
/** Each a kind of value the page may leave out. */
const BLANK_TESTS: ReadonlyArray<(value: unknown) => boolean> = [
    (value) => value === undefined || value === null || value === false,
    (value) => typeof value === 'string' && value.trim() === '',
    (value) => Array.isArray(value) && value.length === 0,
    (value) => isObject(value) && (Object.keys(value).length === 0 || value['type'] === 'none')
];
/** What the page may leave out: an empty field, list or map — or `false` — is a field left out of the file. */
function isBlank(value: unknown): boolean {
    return BLANK_TESTS.some((test) => test(value));
}
function invalid(message: string): ConfigurationError {
    return new ConfigurationError('wrong-type', message);
}
/** The body of a request that describes an agent: its kind, its id, the fields. */
function agentBody(body: unknown): { kind: Agent['kind']; id: string; fields: Fields; systemPrompt?: string } {
    if (!isObject(body)) {
        throw invalid('The agent must be a JSON object.');
    }
    const kind = agentKind(body['kind']);
    const id = agentId(body['id']);
    const systemPrompt = optionalPrompt(body['systemPrompt']);
    return { kind, id, fields: body, ...(systemPrompt === undefined ? {} : { systemPrompt }) };
}
function agentKind(kind: unknown): Agent['kind'] {
    if (kind !== 'local' && kind !== 'remote') {
        throw invalid('kind must be "local" or "remote".');
    }
    return kind;
}
/** The id of an agent, trimmed; it must be there. */
function agentId(id: unknown): string {
    if (typeof id !== 'string' || id.trim() === '') {
        throw new ConfigurationError('missing-field', 'id is missing: every agent needs one, it names its directory.');
    }
    return id.trim();
}
/** The body of a request that describes a group: its id and the fields. */
function groupBody(body: unknown): { id: string; fields: Fields } {
    if (!isObject(body)) {
        throw invalid('The group must be a JSON object.');
    }
    const id = body['id'];
    if (typeof id !== 'string' || id.trim() === '') {
        throw new ConfigurationError('missing-field', 'id is missing: every group needs one, it names its directory.');
    }
    return { id: id.trim(), fields: body };
}
/** The group file to write: what the file had, with the name and the topic set or left out, and the members as sent. */
function groupFileFrom(fields: Fields, kept: Fields): Fields {
    const file: Fields = { ...kept };
    for (const field of GROUP_FIELDS) {
        setField(file, field, fields[field]);
    }
    file['members'] = membersFrom(fields['members']);
    return file;
}
/** The members as sent, trimmed; none when left out. What is not a list of ids is left for the check to refuse. */
function membersFrom(members: unknown): unknown {
    if (members === undefined) {
        return [];
    }
    return Array.isArray(members) ? members.map((member: unknown) => (typeof member === 'string' ? member.trim() : member)) : members;
}
/** The group file without the agent: the members it lists, less this one. */
function withoutMember(kept: Fields, agentId: string): Fields {
    const members = kept['members'];
    return { ...kept, members: Array.isArray(members) ? members.filter((member: unknown) => member !== agentId) : members };
}
/** The group file as flotti loaded it, for when the file cannot be read any more. */
function groupFileOf(group: Group): Fields {
    return { ...(group.name === group.id ? {} : { name: group.name }), ...(group.topic === undefined ? {} : { topic: group.topic }), members: group.members };
}
function optionalPrompt(systemPrompt: unknown): string | undefined {
    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
        throw invalid('systemPrompt must be text.');
    }
    return systemPrompt;
}
/** The manifest fields the page edits, by the kind of agent. */
const FIELDS_OF: Readonly<Record<Agent['kind'], readonly string[]>> = { local: LOCAL_FIELDS, remote: REMOTE_FIELDS };
/** The directory of the fleet the agents of a kind live in. */
const DIRECTORY_OF: Readonly<Record<Agent['kind'], string>> = { local: LOCAL_DIRECTORY, remote: REMOTE_DIRECTORY };
/** The manifest to write: what the file had, with every field the page edits set or left out. */
function manifestFrom(kind: Agent['kind'], fields: Fields, kept: Fields): Fields {
    const manifest: Fields = { ...kept };
    for (const field of FIELDS_OF[kind]) {
        setField(manifest, field, fields[field]);
    }
    return manifest;
}
/** Sets a field of the manifest, trimmed, or leaves it out when it is blank. */
function setField(manifest: Fields, field: string, value: unknown): void {
    if (isBlank(value)) {
        delete manifest[field];
    } else {
        manifest[field] = typeof value === 'string' ? value.trim() : value;
    }
}
function readJson(path: string, what = 'manifest'): Fields {
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
        throw new ConfigurationError('wrong-type', `${path}: the ${what} must be a JSON object`, { path });
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
    return fleet.find((member) => member.kind === 'remote' && reachesOverSsh(member, place, agent));
}
/** Whether the remote agent is the published agent, reached over SSH at the same place. */
function reachesOverSsh(member: RemoteAgent, place: SshTarget, agent: PublishedAgent): boolean {
    return member.ssh !== undefined
        && sameDestination(member.ssh.target, place)
        && (member.ssh.agent ?? agent.id) === agent.id;
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
    const given = requiredPath(body);
    if (!isAbsolute(given) && !startsAtHome(given)) {
        throw new ConfigurationError(
            'invalid-argument',
            `"${given}" is a relative path; give an absolute one, or one starting with ~`
        );
    }
    return given;
}
/** The `path` of the request, trimmed; it must be there. */
function requiredPath(body: unknown): string {
    const path = isObject(body) ? body['path'] : undefined;
    if (typeof path !== 'string' || path.trim() === '') {
        throw new ConfigurationError('missing-field', 'path is missing: name the fleet directory.');
    }
    return path.trim();
}
function startsAtHome(path: string): boolean {
    return path === '~' || path.startsWith('~/') || path.startsWith('~\\');
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
/** The group file as it says it, for the page to edit: the name is not filled in. */
function readGroupConfig(group: Group): GroupConfig {
    const fields = readJson(group.filePath, 'group');
    return {
        id: group.id,
        ...textField(fields, 'name'),
        ...textField(fields, 'topic'),
        members: pick<string[]>(fields, 'members', Array.isArray) ?? []
    };
}
/** The manifest as the file says it, for the page to edit: defaults are not filled in. */
function readConfig(agent: Agent): AgentConfig {
    const fields = readJson(agent.manifestPath);
    const common = commonConfig(agent, fields);
    return agent.kind === 'remote' ? remoteConfig(agent, fields, common) : localConfig(agent, fields, common);
}
/** What the config of the agent has whatever its kind. */
function commonConfig(agent: Agent, fields: Fields): CommonConfig {
    return {
        id: agent.id,
        ...textField(fields, 'name'),
        ...textField(fields, 'description'),
        ...(agent.admin === true ? { admin: true } : {})
    };
}
/** `{ [name]: text }` when the field is text; nothing otherwise. */
function textField<K extends string>(fields: Fields, name: K): { [P in K]?: string } {
    const value = pick<string>(fields, name, isString);
    return value === undefined ? {} : ({ [name]: value } as { [P in K]?: string });
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
    const optional = optionalFields(fields);
    const systemPrompt = readText(join(agent.directory, SYSTEM_PROMPT_FILE));
    return {
        kind: 'local',
        ...common,
        ...optional,
        command: pick<string>(fields, 'command', isString) ?? '',
        ...(systemPrompt === undefined ? {} : { systemPrompt })
    } as LocalAgentConfig;
}
/** Fields of a local agent the config has under names of its own. */
const OWN_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'command', 'admin']);
/** The fields of a local manifest the config carries as they are. */
function optionalFields(fields: Fields): Fields {
    const optional: Fields = {};
    for (const field of LOCAL_FIELDS) {
        if (!OWN_FIELDS.has(field) && fields[field] !== undefined) {
            optional[field] = fields[field];
        }
    }
    return optional;
}
/** What pins the fleet directory for this run: the command line or the environment, or nothing. */
function pinnedByOf(source: FleetLocation['source']): FleetInfo['pinnedBy'] {
    return source === 'argument' || source === 'environment' ? source : undefined;
}
/** A prompt worth a file: one with more than spaces in it. */
function promptOf(systemPrompt: string | undefined): string | undefined {
    return systemPrompt !== undefined && systemPrompt.trim() !== '' ? systemPrompt : undefined;
}
/** The base with the first number from 2 up that makes a name not yet taken. */
function firstFree(base: string, taken: (candidate: string) => boolean): string {
    let number = 2;
    while (taken(`${base}-${number}`)) {
        number++;
    }
    return `${base}-${number}`;
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
        this.pinnedBy = pinnedByOf(fleet.location.source);
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
        const taken = (candidate: string): boolean => this.isTaken(candidate);
        const withHost = `${id}-${host.replace(/[^A-Za-z0-9._-]/g, '-')}`;
        return [id, withHost].find((candidate) => AGENT_ID.test(candidate) && !taken(candidate)) ?? firstFree(withHost, taken);
    }
    /** Whether an agent of the fleet or a directory in it has this id already. */
    private isTaken(candidate: string): boolean {
        return this.supervisor.agents().some((agent) => agent.id === candidate)
            || [LOCAL_DIRECTORY, REMOTE_DIRECTORY].some((group) => exists(join(this.location.path, group, candidate)));
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
        const target = this.trash(agent.directory, `${agent.kind}-${agent.id}`);
        this.leaveGroups(agentId);
        return target;
    }
    /**
     * Moves the directory to `.trash` in the fleet directory, under the name
     * and the time.
     *
     * @returns Where the directory went; `undefined` when it was gone already.
     */
    private trash(directory: string, name: string): string | undefined {
        if (!exists(directory)) {
            return undefined;
        }
        const trash = join(this.location.path, TRASH_DIRECTORY);
        mkdirSync(trash, { recursive: true });
        const target = join(trash, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(directory, target);
        return target;
    }
    /** Takes the agent out of every group it is in: the files are rewritten, the running fleet learns it. */
    private leaveGroups(agentId: string): void {
        for (const summary of this.supervisor.groups()) {
            if (summary.members.includes(agentId)) {
                const group = this.supervisor.group(summary.id);
                this.supervisor.replaceGroup(this.writeGroup(group.id, withoutMember(this.keptGroup(group), agentId)));
            }
        }
    }
    /** The group file as it is; as flotti loaded it, when it was broken by hand since — the page sends its fields anew. */
    private keptGroup(group: Group): Fields {
        try {
            return readJson(group.filePath, 'group');
        } catch {
            return groupFileOf(group);
        }
    }
    /** The groups of the fleet, by id. */
    groups(): GroupSummary[] {
        return this.supervisor.groups();
    }
    /** The group file as it says it. */
    groupConfig(groupId: string): GroupConfig {
        return readGroupConfig(this.supervisor.group(groupId));
    }
    /**
     * Writes the directory of a new group; the agents in it see one another
     * from now on.
     *
     * @throws ConfigurationError when the group is not one `flotti run` would take.
     */
    createGroup(body: unknown): GroupSummary {
        const { id, fields } = groupBody(body);
        if (!AGENT_ID.test(id)) {
            throw new ConfigurationError(
                'invalid-group-id',
                `"${id}" cannot be a group id — use letters, digits, ".", "_" and "-", starting with a letter or a digit`
            );
        }
        if (this.isGroupTaken(id)) {
            throw new ConfigurationError('duplicate-group-id', `The id "${id}" is already taken by a group of this fleet`);
        }
        this.supervisor.addGroup(this.writeGroup(id, groupFileFrom(fields, {})));
        return this.groupSummary(id);
    }
    /** Whether a group of the fleet or a directory in `groups/` has this id already. */
    private isGroupTaken(id: string): boolean {
        return this.supervisor.groups().some((group) => group.id === id) || exists(join(this.location.path, GROUPS_DIRECTORY, id));
    }
    /** Writes the changed group file and puts it to work: the members see one another as it says. */
    updateGroup(groupId: string, body: unknown): GroupSummary {
        const current = this.supervisor.group(groupId);
        const { fields } = groupBody({ ...(isObject(body) ? body : {}), id: groupId });
        this.supervisor.replaceGroup(this.writeGroup(groupId, groupFileFrom(fields, this.keptGroup(current))));
        return this.groupSummary(groupId);
    }
    /**
     * Takes the group out of the fleet and moves its directory to `.trash` in
     * the fleet directory, as an agent's goes.
     *
     * @returns Where the directory went; `undefined` when it was gone already.
     */
    removeGroup(groupId: string): string | undefined {
        const group = this.supervisor.group(groupId);
        this.supervisor.removeGroup(groupId);
        return this.trash(group.directory, `group-${group.id}`);
    }
    /** Checks the group file the way `flotti run` would, and only then writes the group directory. */
    private writeGroup(id: string, file: Fields): Group {
        const directory = join(this.location.path, GROUPS_DIRECTORY, id);
        const filePath = join(directory, GROUP_FILE);
        parseGroup(file, { id, directory, filePath });
        mkdirSync(directory, { recursive: true });
        writeAtomically(filePath, `${JSON.stringify(file, null, 4)}\n`);
        return readGroup(this.location.path, id);
    }
    private groupSummary(groupId: string): GroupSummary {
        const found = this.supervisor.groups().find((group) => group.id === groupId);
        if (found === undefined) {
            throw new Error(`The group "${groupId}" is not in the fleet.`);
        }
        return found;
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
        const directory = join(this.location.path, DIRECTORY_OF[kind], id);
        const prompt = kind === 'local' ? promptOf(systemPrompt) : undefined;
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
