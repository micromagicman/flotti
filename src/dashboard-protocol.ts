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
    /** Set for an administrator of the fleet: it may restart the other agents and clear their context. */
    readonly admin?: true;
    /**
     * Whether the agent has the memory of #101, as flotti delivered it — never
     * what the agent says. Absent until a local agent was started once.
     */
    readonly memory?: MemoryStatus;
};
/**
 * The memory of an agent: `on` with the version of the policy it got and where
 * the built-in skill stands — flotti's own, one of the agent's own of the same
 * name, or not written; `unsupported` when flotti cannot give it memory;
 * `unavailable` when the bank cannot be read or written. An unavailable bank
 * is never shown as an empty one.
 */
type MemoryStatus =
    | { readonly state: 'on'; readonly policy: number; readonly skill: 'builtin' | 'user' | 'missing' }
    | { readonly state: 'unsupported' | 'unavailable'; readonly reason: string };
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
/** Body of `POST /api/admin-actions/<actionId>`: a person allows or refuses an action of an administrator. */
type AdminAnswer = {
    readonly allow: boolean;
};
/** `GET /api/admin-settings`, the body of `PUT /api/admin-settings` and the answer to it. */
type AdminSettings = {
    /**
     * Whether every action of an administrator waits for a person to allow it
     * in the dashboard; when off, it is done at once.
     */
    readonly confirmActions: boolean;
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
    /** An administrator of the fleet; `false` or absent means it is not one. */
    readonly admin?: boolean;
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
    /** An administrator of the fleet; `false` or absent means it is not one. */
    readonly admin?: boolean;
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
/** Which moments earn a notification outside the browser; each is switched on its own. */
type NotificationEvents = {
    /** An agent waits for a person: an answer, a permission. */
    readonly waiting: boolean;
    /** An agent failed, or its process fell. */
    readonly error: boolean;
    /** The SSH connection to an agent is lost. */
    readonly connection: boolean;
};
/**
 * The notifications outside the browser as the page sees them:
 * `GET /api/notifications`, and the answer to `PUT` there. Secrets never come
 * back to the page: it learns whether a bot token is saved, not the token.
 */
type NotificationSettings = {
    readonly events: NotificationEvents;
    /** Minutes before a person is told again that an agent still waits; 0 tells once. */
    readonly repeatMinutes: number;
    /** Address the notifications link to; the address of this dashboard when absent. */
    readonly dashboardUrl?: string;
    readonly telegram: {
        readonly enabled: boolean;
        readonly chatId?: string;
        /** Whether a bot token is saved; the token itself stays on the server. */
        readonly botTokenSet: boolean;
    };
    readonly webPush: {
        readonly enabled: boolean;
        /** The public key browsers subscribe with (VAPID, base64url). */
        readonly publicKey: string;
        /** How many browsers are subscribed. */
        readonly subscriptions: number;
    };
};
/**
 * Body of `PUT /api/notifications`: what to change, the rest is kept. A bot
 * token left out keeps the saved one; an empty one removes it.
 */
type NotificationSettingsChange = {
    readonly events?: Partial<NotificationEvents>;
    readonly repeatMinutes?: number;
    /** An empty one goes back to the address of this dashboard. */
    readonly dashboardUrl?: string;
    readonly telegram?: { readonly enabled?: boolean; readonly chatId?: string; readonly botToken?: string };
    readonly webPush?: { readonly enabled?: boolean };
};
/**
 * Body of `POST /api/notifications/subscriptions` (a browser subscribes) and
 * of `DELETE` there (it stops): the `PushSubscription` of the browser as JSON.
 */
type PushSubscriptionBody = {
    readonly endpoint: string;
    readonly keys?: { readonly p256dh: string; readonly auth: string };
};
/** Answer to `POST /api/notifications/test`: how the test notification went over each channel switched on. */
type NotificationTestResponse = {
    readonly results: readonly { readonly channel: string; readonly ok: boolean; readonly error?: string }[];
};
/** A note of the memory bank of an agent, as the list of them shows it. */
type MemoryNoteSummary = {
    /** Where the note is in the memory bank, folders joined with `/`: `process/release.md`. */
    readonly path: string;
    /** The first `# heading` of the note, or its file name without `.md`. */
    readonly title: string;
    /** When the file last changed, in milliseconds since the epoch. */
    readonly modifiedAt: number;
    /** Size of the file in bytes. */
    readonly size: number;
    /** The notes its `[[links]]` name, as written: without the label and the heading. */
    readonly links: readonly string[];
    /** Set when the note is too large to read: it is listed, but not shown. */
    readonly tooLarge?: true;
};
/**
 * `GET /api/agents/<id>/memory`: the notes of the memory bank of a local agent,
 * read-only. `?q=words` keeps the notes whose title, path or text has them.
 * An agent whose memory is not on this machine — a remote one, or a local one
 * started over SSH — has none to show, and the answer says why.
 */
type MemoryBank =
    | {
        readonly available: true;
        /** Absolute path of the memory bank. */
        readonly directory: string;
        /** Notes in the order of their paths. */
        readonly notes: readonly MemoryNoteSummary[];
        /** Set when there were more notes than the dashboard lists. */
        readonly truncated?: true;
    }
    | { readonly available: false; readonly reason: string };
/** `GET /api/agents/<id>/memory/<path>`, the path encoded as one segment: one note, with its text. */
type MemoryNote = {
    readonly path: string;
    /** Absolute path of the file, for a person to open it elsewhere. */
    readonly file: string;
    readonly modifiedAt: number;
    readonly size: number;
    /** The markdown of the note as it is in the file. */
    readonly text: string;
};
/** Answer to any request that went wrong. */
type ErrorResponse = {
    readonly error: string;
};
export type {
    AdminAnswer,
    AdminSettings,
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
    MemoryBank,
    MemoryNote,
    MemoryNoteSummary,
    MemoryStatus,
    NotificationEvents,
    NotificationSettings,
    NotificationSettingsChange,
    NotificationTestResponse,
    PermissionAnswer,
    PushSubscriptionBody,
    RemoteAgentConfig,
    SendRequest,
    ServerMessage,
    SshAgentsRequest,
    SshAgentsResponse
};
