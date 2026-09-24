/**
 * What the dashboard server and the page say to each other. Types only, with
 * no Node in them, so the page — built by Vite for the browser — imports the
 * very same ones and the two sides cannot drift apart.
 *
 * The page reads over one WebSocket (`/ws`) and acts over plain HTTP (`/api`):
 * every action has an answer of its own — a broadcast answers agent by agent —
 * while the socket only carries what the agents do.
 */
import type { AgentEvent, AgentStatus, Forwarded, Quote } from './agent-events.js';
import type { ConnectionHealth } from './connection-health.js';
import type { FleetSource, LocalAgentAdapter, RemoteAuth, RemoteSsh, RestartPolicy } from './types.js';
/**
 * The program that runs the agent: the `adapter` of a local agent, or what a
 * remote agent says of itself (docs/a2a-ssh.md, "Which harness runs the
 * agent"). `claude` and `codex` are the ones flotti knows; any other name a
 * remote agent gives is kept and shown as it is, never guessed at.
 */
type Harness = string;
/** An agent of the fleet as the page lists it. */
type AgentSummary = {
    readonly id: string;
    readonly name: string;
    readonly kind: 'local' | 'remote';
    readonly description?: string;
    /** Absent when flotti does not know it; never guessed. */
    readonly harness?: Harness;
    readonly status: AgentStatus;
    /** Health of the SSH connection of a remote agent reached over one; absent for any other. */
    readonly health?: ConnectionHealth;
};
/**
 * What the page sends over the socket: the last `seq` it has seen of each
 * agent. The server answers with what came after it, then keeps the socket
 * going live. A page that has seen nothing sends an empty map.
 */
type ClientMessage = {
    readonly type: 'subscribe';
    readonly since: Readonly<Record<string, number>>;
};
/** What the server sends over the socket. */
type ServerMessage =
    /** First message of every connection, and again whenever an agent is added, changed or removed. */
    | { readonly type: 'fleet'; readonly agents: readonly AgentSummary[] }
    /** One event of one agent, from history or live; `seq` tells which. */
    | { readonly type: 'event'; readonly event: AgentEvent }
    /** How a message that had to wait in line ended up: taken at last, or dropped. */
    | { readonly type: 'delivery'; readonly delivery: Delivery }
    /** The health of the connection of an agent changed: it came up or dropped, a round trip was measured, the agent was heard from. */
    | { readonly type: 'health'; readonly agentId: string; readonly health: ConnectionHealth }
    /** The server is going away: `flotti stop`, or Ctrl+C. */
    | { readonly type: 'shutdown' };
/** Body of `POST /api/agents/<id>/messages` and of `POST /api/broadcast`. */
type SendRequest = {
    /** May be empty only when a message is forwarded: nothing written above it. */
    readonly text: string;
    /** Broadcast only: which agents get it; every agent of the fleet when absent. */
    readonly agents?: readonly string[];
    /** One agent only: the message this one answers. */
    readonly replyTo?: Quote;
    /** One agent only: a message of this or another tab, sent on as it was. */
    readonly forwarded?: Forwarded;
    /** One agent only: the `messageId` of a message that was not delivered, sent again with this one. */
    readonly retryOf?: string;
};
/** Body of `POST /api/agents/<id>/permissions/<requestId>`; no option refuses the request. */
type PermissionAnswer = {
    readonly optionId?: string;
};
/** How one agent took a message. */
type Delivery = {
    readonly agentId: string;
    /**
     * - `taken`  — the agent has it;
     * - `queued` — the agent is busy and the message waits in line; a `delivery`
     *              message on the socket says later how it ended. The tab of the
     *              agent learns it from the `queued` event, and a person may take
     *              the message back: `DELETE /api/agents/<id>/queue/<messageId>`;
     * - `failed` — it never got there.
     */
    readonly result: 'taken' | 'queued' | 'failed';
    /** Why it failed. */
    readonly error?: string;
};
/** Answer to a broadcast: one delivery per agent it went to, in fleet order. */
type BroadcastResponse = {
    readonly deliveries: readonly Delivery[];
};
/** The fleet directory: `GET /api/fleet`, and the answer to `PUT /api/fleet`. */
type FleetInfo = {
    /** Absolute path of the fleet directory this run works with. */
    readonly path: string;
    readonly source: FleetSource;
    /**
     * Set when the run was started with `--fleet` or `FLOTTI_FLEET`: that
     * wins over the saved directory, so the next run started the same way
     * opens that one again.
     */
    readonly pinnedBy?: 'argument' | 'environment';
    /** Where the chosen directory is saved; absent without a home directory. */
    readonly settingsFile?: string;
};
/** Body of `PUT /api/fleet`: the directory to work with from now on. */
type FleetSwitch = {
    /** Absolute, or starting with `~`. */
    readonly path: string;
};
/**
 * The manifest of a local agent as the settings page edits it: the fields of
 * `agent.json` as they are written in the file — defaults are not filled in —
 * and the system prompt. A field left out is left out of the file.
 */
type LocalAgentConfig = {
    readonly kind: 'local';
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly adapter?: LocalAgentAdapter;
    readonly model?: string;
    readonly command: string;
    readonly arguments?: readonly string[];
    /** `user@host`: flotti starts the agent on that host over SSH. */
    readonly ssh?: string;
    readonly workdir?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly restart?: RestartPolicy;
    readonly heartbeatTimeoutSec?: number;
    /** Text of `system-prompt.md`; empty or absent means no such file. */
    readonly systemPrompt?: string;
};
/**
 * The manifest of a remote agent as the settings page edits it: reached at
 * `url`, or through an SSH tunnel to the host `ssh` names.
 */
type RemoteAgentConfig = {
    readonly kind: 'remote';
    readonly id: string;
    readonly name?: string;
    readonly description?: string;
    readonly url?: string;
    readonly ssh?: RemoteSsh;
    readonly auth?: RemoteAuth;
};
/** Body of `POST /api/ssh-agents`: the one thing a person gives to add the agents of a host. */
type SshAgentsRequest = {
    /** `user@host`, or `user@host:port`; the user's public key is already on the host. */
    readonly target: string;
};
/** Answer to `POST /api/ssh-agents`: the agents the host publishes that joined the fleet. */
type SshAgentsResponse = {
    readonly added: readonly AgentSummary[];
    /** Ids of the agents of the fleet the host's agents already were. */
    readonly present?: readonly string[];
};
/**
 * Body of `POST /api/agents` (a new agent) and of `PUT /api/agents/<id>`
 * (a change), and the answer to `GET /api/agents/<id>`.
 */
type AgentConfig = LocalAgentConfig | RemoteAgentConfig;
/** Answer to any request that went wrong. */
type ErrorResponse = {
    readonly error: string;
};
export type {
    AgentConfig,
    ConnectionHealth,
    AgentSummary,
    BroadcastResponse,
    ClientMessage,
    Delivery,
    ErrorResponse,
    FleetInfo,
    FleetSwitch,
    Harness,
    LocalAgentConfig,
    PermissionAnswer,
    RemoteAgentConfig,
    SendRequest,
    ServerMessage,
    SshAgentsRequest,
    SshAgentsResponse
};
