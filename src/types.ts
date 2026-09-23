/**
 * What flotti does with a local agent that stopped:
 * - `always`     — restart it whatever the exit code was;
 * - `on-failure` — restart it only after a non-zero exit code or a lost heartbeat;
 * - `never`      — leave it stopped.
 */
type RestartPolicy = 'always' | 'on-failure' | 'never';
/**
 * Which ACP adapter the `command` of a local agent starts. It tells flotti how
 * to hand the model, the system prompt and the skills over to it; an agent without
 * one is driven by plain ACP only.
 */
type LocalAgentAdapter = 'claude-code' | 'codex';
/** How a remote agent is reached. Only A2A for now. */
type RemoteProtocol = 'a2a';
/**
 * How flotti proves itself to a remote agent. The secret itself never sits in
 * the manifest: the manifest names the environment variable that holds it, and
 * the variable is read when the connection is made.
 */
type RemoteAuth =
    | { readonly type: 'none' }
    | { readonly type: 'bearer'; readonly tokenEnv: string }
    | { readonly type: 'api-key'; readonly header: string; readonly valueEnv: string };
/** What every agent of the fleet has, local or remote. */
type AgentBase = {
    /** Name of the agent directory; unique across the whole fleet. */
    readonly id: string;
    /** Human-readable name; the id when the manifest says nothing. */
    readonly name: string;
    /** One line about the agent, for the dashboard. */
    readonly description?: string;
    /** Absolute path of the agent directory. */
    readonly directory: string;
    /** Absolute path of the manifest inside it. */
    readonly manifestPath: string;
};
/**
 * An agent flotti starts itself, from `<fleet>/local/<id>/`. The optional
 * fields of the manifest are already filled with the documented defaults.
 */
type LocalAgent = AgentBase & {
    readonly kind: 'local';
    /** ACP adapter the command starts; absent means a plain ACP agent. */
    readonly adapter?: LocalAgentAdapter;
    /** Model the agent is asked to use; absent means the adapter's own default. */
    readonly model?: string;
    /** Executable to run. */
    readonly command: string;
    /** Arguments passed to the executable; empty when the manifest says nothing. */
    readonly arguments: readonly string[];
    /** Absolute working directory; the agent directory when the manifest says nothing. */
    readonly workdir: string;
    /** Variables added to the agent environment; empty when the manifest says nothing. */
    readonly env: Readonly<Record<string, string>>;
    /** What to do when the agent stops; `on-failure` when the manifest says nothing. */
    readonly restart: RestartPolicy;
    /** Seconds without a heartbeat before the agent counts as lost; 60 when the manifest says nothing. */
    readonly heartbeatTimeoutSec: number;
    /** Absolute path of `system-prompt.md`, when the agent has one. */
    readonly systemPromptFile?: string;
    /** Absolute path of the agent's own skills; flotti creates it and never reads it. */
    readonly skillsDirectory: string;
    /** Absolute path of the agent's memory bank; flotti creates it and never reads it. */
    readonly memoryDirectory: string;
};
/** An agent that runs elsewhere and is reached over the network, from `<fleet>/remote/<id>/`. */
type RemoteAgent = AgentBase & {
    readonly kind: 'remote';
    readonly protocol: RemoteProtocol;
    /** Address of the agent, `http:` or `https:`. */
    readonly url: string;
    /** `{type: 'none'}` when the manifest says nothing. */
    readonly auth: RemoteAuth;
};
type Agent = LocalAgent | RemoteAgent;
/** Which of the four ways gave flotti the fleet directory: `settings` is the one the dashboard saved. */
type FleetSource = 'argument' | 'environment' | 'settings' | 'default';
/** Fleet directory flotti decided to read, and why that one. */
type FleetLocation = {
    /** Absolute path, with `~` already expanded. */
    readonly path: string;
    readonly source: FleetSource;
};
/** Result of reading the fleet: nothing is started by reading it. */
type Fleet = {
    readonly location: FleetLocation;
    /** Whether the fleet directory exists; a missing default one reads as an empty fleet. */
    readonly exists: boolean;
    /** Local agents first, then remote ones, each group ordered by id. */
    readonly agents: readonly Agent[];
};
export type {
    Agent,
    AgentBase,
    Fleet,
    FleetLocation,
    FleetSource,
    LocalAgent,
    LocalAgentAdapter,
    RemoteAgent,
    RemoteAuth,
    RemoteProtocol,
    RestartPolicy
};
