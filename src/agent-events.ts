/**
 * What an agent tells the people watching it, the same for every agent of the
 * fleet: a local one driven over ACP and a remote one reached over A2A. The
 * dashboard reads only these events and never the protocol behind them; what a
 * protocol has and this model does not goes out as a `raw` event rather than
 * being dropped.
 *
 * Kept small on purpose: a kind of event is added here when a consumer needs it,
 * not because one protocol happens to have it.
 */

/**
 * Where an agent is, in the words of the person watching it:
 * - `offline`  — not running or not reachable, and nobody is bringing it back;
 * - `starting` — being started or connected to, including waiting to retry;
 * - `idle`     — ready for a message;
 * - `working`  — busy with a message;
 * - `waiting`  — busy, and stuck until a person decides something;
 * - `error`    — gave up; needs a person to look at it.
 */
type AgentStatus = 'offline' | 'starting' | 'idle' | 'working' | 'waiting' | 'error';

/** Progress of one tool call the agent makes. */
type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** One answer a person may give to a permission request, as the agent offered it. */
type PermissionOption = {
    readonly optionId: string;
    readonly name: string;
    /** `allow_once`, `allow_always`, `reject_once` or `reject_always`; kept as the agent sent it. */
    readonly kind: string;
};

type AgentEventBody =
    /** The agent moved to another status; `detail` says why, for people. */
    | { readonly type: 'status'; readonly status: AgentStatus; readonly detail?: string }
    /**
     * A piece of a message. Agents stream their answers, so one message comes in
     * many pieces; pieces with the same `messageId` belong together, and pieces
     * without one belong to the message before.
     */
    | {
        readonly type: 'message';
        readonly role: 'user' | 'agent';
        readonly text: string;
        readonly messageId?: string;
    }
    /** A piece of the agent's reasoning, shown apart from its answer. */
    | { readonly type: 'thought'; readonly text: string }
    /**
     * A tool call started or changed. The first event of a `toolCallId` carries
     * what is known; the later ones carry only what changed.
     */
    | {
        readonly type: 'tool-call';
        readonly toolCallId: string;
        readonly title?: string;
        readonly status?: ToolCallStatus;
        /** The protocol's own record of the call — diff, command output — for a consumer that knows the protocol. */
        readonly raw?: unknown;
    }
    /** The agent is stuck until a person picks one of the options. */
    | {
        readonly type: 'permission';
        readonly requestId: string;
        readonly title: string;
        readonly options: readonly PermissionOption[];
    }
    /** The agent finished with a message: `end_turn`, `cancelled`, `refusal` and so on. */
    | { readonly type: 'turn-end'; readonly reason: string }
    /** A line of diagnostics: from the agent itself, or from the side that runs it. */
    | { readonly type: 'log'; readonly source: 'agent' | 'supavisor'; readonly text: string }
    /** Something the protocol said that has no event of its own here, untouched. */
    | { readonly type: 'raw'; readonly protocol: 'acp' | 'a2a'; readonly payload: unknown };

/** An event with its place in the agent's history. */
type AgentEvent = AgentEventBody & {
    readonly agentId: string;
    /** Grows by one with every event of this agent, so a consumer can ask for "everything after N". */
    readonly seq: number;
    /** ISO 8601 time the event happened. */
    readonly time: string;
};

type AgentEventListener = (event: AgentEvent) => void;

/** What the dashboard does with any agent, local or remote. */
interface FleetAgent {
    readonly id: string;
    readonly status: AgentStatus;
    /** Sends a message; resolves with the reason the agent stopped working on it. */
    send(text: string): Promise<string>;
    /** Asks the agent to drop the message it is working on. */
    cancel(): Promise<void>;
    /** Calls the listener with every event from now on; returns the way to stop. */
    subscribe(listener: AgentEventListener): () => void;
}

export type {
    AgentEvent,
    AgentEventBody,
    AgentEventListener,
    AgentStatus,
    FleetAgent,
    PermissionOption,
    ToolCallStatus
};
