/**
 * The agent form as text fields, and the way to and from the manifest. Pure,
 * like feed.ts: the form in components/AgentForm.tsx only renders it.
 */
import type { AgentConfig, LocalAgentConfig, RemoteAgentConfig } from '../../src/dashboard-protocol.js';
import type { LocalAgentAdapter, RemoteAuth, RestartPolicy } from '../../src/types.js';
type Draft = {
    readonly kind: 'local' | 'remote';
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** Local agents. */
    readonly adapter: LocalAgentAdapter | '';
    readonly model: string;
    readonly command: string;
    /** One argument per line. */
    readonly arguments: string;
    readonly workdir: string;
    /** `NAME=value`, one per line. */
    readonly env: string;
    readonly restart: RestartPolicy | '';
    readonly heartbeatTimeoutSec: string;
    readonly systemPrompt: string;
    /**
     * Remote agents: `sshTarget` when reached over SSH, `url` otherwise.
     * Local agents: the host flotti starts the agent on; empty for this machine.
     */
    readonly sshTarget: string;
    readonly sshAgent: string;
    readonly url: string;
    readonly authType: RemoteAuth['type'];
    readonly tokenEnv: string;
    readonly header: string;
    readonly valueEnv: string;
};
/** What the adapters are started with, as README.md says: picking an adapter fills them in. */
const PRESETS: Readonly<Record<LocalAgentAdapter, { readonly command: string; readonly arguments: readonly string[] }>> = {
    'claude-code': { command: 'npx', arguments: ['-y', '@agentclientprotocol/claude-agent-acp@0.81.1'] },
    'codex': { command: 'npx', arguments: ['-y', '@agentclientprotocol/codex-acp@1.13.1'] }
};
const EMPTY: Draft = {
    kind: 'local',
    id: '',
    name: '',
    description: '',
    adapter: '',
    model: '',
    command: '',
    arguments: '',
    workdir: '',
    env: '',
    restart: '',
    heartbeatTimeoutSec: '',
    systemPrompt: '',
    sshTarget: '',
    sshAgent: '',
    url: '',
    authType: 'none',
    tokenEnv: '',
    header: '',
    valueEnv: ''
};
/** A new agent: a local one starts as Claude Code, the adapter most people have. */
function newDraft(kind: 'local' | 'remote'): Draft {
    return kind === 'local' ? withAdapter({ ...EMPTY, kind }, 'claude-code') : { ...EMPTY, kind };
}
function lines(text: string): string[] {
    return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
/** Picks the adapter, and its command with it when the command is empty or is another adapter's. */
function withAdapter(draft: Draft, adapter: LocalAgentAdapter | ''): Draft {
    const presets = Object.values(PRESETS);
    const preset = presets.find((known) =>
        known.command === draft.command.trim() && known.arguments.join('\n') === lines(draft.arguments).join('\n'));
    const replaceable = draft.command.trim() === '' || preset !== undefined;
    if (adapter === '' || !replaceable) {
        return { ...draft, adapter };
    }
    return { ...draft, adapter, command: PRESETS[adapter].command, arguments: PRESETS[adapter].arguments.join('\n') };
}
function fromConfig(config: AgentConfig): Draft {
    const common = { ...EMPTY, kind: config.kind, id: config.id, name: config.name ?? '', description: config.description ?? '' };
    if (config.kind === 'remote') {
        const auth = config.auth ?? { type: 'none' };
        return {
            ...common,
            sshTarget: config.ssh?.target ?? '',
            sshAgent: config.ssh?.agent ?? '',
            url: config.url ?? '',
            authType: auth.type,
            tokenEnv: auth.type === 'bearer' ? auth.tokenEnv : '',
            header: auth.type === 'api-key' ? auth.header : '',
            valueEnv: auth.type === 'api-key' ? auth.valueEnv : ''
        };
    }
    return {
        ...common,
        adapter: config.adapter ?? '',
        model: config.model ?? '',
        command: config.command,
        arguments: (config.arguments ?? []).join('\n'),
        workdir: config.workdir ?? '',
        sshTarget: config.ssh ?? '',
        env: Object.entries(config.env ?? {}).map(([name, value]) => `${name}=${value}`).join('\n'),
        restart: config.restart ?? '',
        heartbeatTimeoutSec: config.heartbeatTimeoutSec === undefined ? '' : String(config.heartbeatTimeoutSec),
        systemPrompt: config.systemPrompt ?? ''
    };
}
function optional<K extends string, V>(key: K, value: V | undefined | ''): Partial<Record<K, V>> {
    return value === undefined || value === '' ? {} : { [key]: value } as Record<K, V>;
}
/**
 * The manifest the draft says. The server checks it the way `flotti run`
 * does; here only what text fields cannot say on their own is checked.
 *
 * @throws Error when a line of the environment has no `=`, or the timeout is not a number.
 */
function toConfig(draft: Draft): AgentConfig {
    const common = {
        id: draft.id.trim(),
        ...optional('name', draft.name.trim()),
        ...optional('description', draft.description.trim())
    };
    if (draft.kind === 'remote') {
        const auth: RemoteAuth = draft.authType === 'bearer'
            ? { type: 'bearer', tokenEnv: draft.tokenEnv.trim() }
            : draft.authType === 'api-key'
                ? { type: 'api-key', header: draft.header.trim(), valueEnv: draft.valueEnv.trim() }
                : { type: 'none' };
        const target = draft.sshTarget.trim();
        const remote: RemoteAgentConfig = target === ''
            ? { kind: 'remote', ...common, url: draft.url.trim(), auth }
            : { kind: 'remote', ...common, ssh: { target, ...optional('agent', draft.sshAgent.trim()) }, auth };
        return remote;
    }
    const env: Record<string, string> = {};
    for (const line of lines(draft.env)) {
        const at = line.indexOf('=');
        if (at <= 0) {
            throw new Error(`Environment: "${line}" is not NAME=value.`);
        }
        env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    const timeout = draft.heartbeatTimeoutSec.trim();
    if (timeout !== '' && !(Number(timeout) > 0)) {
        throw new Error(`Heartbeat timeout: "${timeout}" is not a positive number of seconds.`);
    }
    const local: LocalAgentConfig = {
        kind: 'local',
        ...common,
        ...optional('adapter', draft.adapter),
        ...optional('model', draft.model.trim()),
        command: draft.command.trim(),
        arguments: lines(draft.arguments),
        ...optional('ssh', draft.sshTarget.trim()),
        ...optional('workdir', draft.workdir.trim()),
        env,
        ...optional('restart', draft.restart),
        ...(timeout === '' ? {} : { heartbeatTimeoutSec: Number(timeout) }),
        systemPrompt: draft.systemPrompt
    };
    return local;
}
export { PRESETS, fromConfig, newDraft, toConfig, withAdapter };
export type { Draft };
