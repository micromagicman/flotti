/**
 * The one shape every agent of the fleet has for the dashboard, whether it is a
 * local process spoken to over ACP or a remote service spoken to over A2A: the
 * dashboard subscribes to events, sends messages, cancels, restarts — and never
 * learns which protocol is behind. What a protocol has and this model does not
 * goes out as a `raw` event rather than being dropped.
 *
 * Kept small on purpose: a kind of event is added here when a consumer needs it,
 * not because one protocol happens to have it.
 */
/**
 * What the agent is doing, as the dashboard tab shows it:
 * - `starting` — being started or connected to, including waiting to retry; not ready for messages yet;
 * - `idle`     — ready and doing nothing;
 * - `working`  — busy with a message;
 * - `waiting`  — stopped half-way and waiting for a person: a permission to
 *                grant, more input, a login;
 * - `error`    — gave up, or the last attempt failed; the reason says why;
 * - `stopped`  — not running, and not coming back by itself: stopped on purpose,
 *                never started, or exited where its policy says to leave it so.
 */
type AgentStatus = 'starting' | 'idle' | 'working' | 'waiting' | 'error' | 'stopped';
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
    /** The agent status changed. */
    | {
        readonly type: 'status';
        readonly status: AgentStatus;
        /** Why, in a few words, when there is more to say than the status itself. */
        readonly reason?: string;
    }
    /**
     * A piece of a message. Agents stream their answers, so one message comes in
     * many pieces. Pieces with one `messageId` make one message on the screen:
     * `append: false` sets its text (starting the message, or replacing it),
     * `append: true` adds the text to its end.
     */
    | {
        readonly type: 'message';
        readonly role: 'user' | 'agent';
        readonly messageId: string;
        readonly text: string;
        readonly append: boolean;
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
    /** The agent is stuck until a person picks one of the options: see {@link FleetAgent.answerPermission}. */
    | {
        readonly type: 'permission';
        readonly requestId: string;
        readonly title: string;
        readonly options: readonly PermissionOption[];
    }
    /**
     * The agent is done with a message, for now or for good: `end_turn`,
     * `cancelled`, `refusal`, `max_tokens`, `error`, or — when it paused to ask
     * a person — `input_required` and `auth_required`.
     */
    | { readonly type: 'turn-end'; readonly reason: string }
    /** A line of diagnostics: from the agent itself, or from the side that runs it. */
    | { readonly type: 'log'; readonly source: 'agent' | 'flotti'; readonly text: string }
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
/** An agent of the fleet as the dashboard drives it, local or remote. */
interface FleetAgent {
    /** Id of the agent: the name of its directory in the fleet. */
    readonly agentId: string;
    /** The status the last `status` event reported. */
    readonly status: AgentStatus;
    /** Calls the listener with every event from now on; returns the way to stop. */
    subscribe(listener: AgentEventListener): () => void;
    /** Starts the agent, or connects to it; resolves once it can take messages. */
    start(): Promise<void>;
    /**
     * Sends a message from a person. A busy agent gets it once it is done with
     * the previous one: messages queue, they do not interrupt. Resolves when the
     * agent has taken the message, not when it has answered: what comes of it
     * arrives as events, down to `turn-end`. Rejects when the message never
     * reached the agent — not started, stopped, gone before its turn.
     */
    send(text: string): Promise<void>;
    /** Asks the agent to drop what it is working on; does nothing when it is not busy. */
    cancel(): Promise<void>;
    /**
     * Answers a `permission` event with one of the options it offered, or
     * refuses it when no option is given.
     *
     * @returns Whether such a request was waiting.
     */
    answerPermission(requestId: string, optionId?: string): boolean;
    /**
     * Stops and starts the agent again. The conversation goes on when the agent
     * can pick it up, and starts anew when it cannot; a `status` or `log` event
     * says which.
     */
    restart(): Promise<void>;
    /** Stops the agent, or disconnects from it; queued messages are dropped. */
    stop(): Promise<void>;
}
/**
 * Keeps the listeners of one agent and hands its events to them, numbered and
 * timed. A listener that throws is the listener's problem: it does not stop the
 * others, nor the agent.
 */
class AgentEvents {
    private readonly listeners = new Set<AgentEventListener>();
    private seq = 0;
    constructor(private readonly agentId: string) {}
    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(body: AgentEventBody): void {
        const event = { ...body, agentId: this.agentId, seq: ++this.seq, time: new Date().toISOString() } as AgentEvent;
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // A broken subscriber must not take the agent down with it.
            }
        }
    }
    clear(): void {
        this.listeners.clear();
    }
}
export { AgentEvents };
export type {
    AgentEvent,
    AgentEventBody,
    AgentEventListener,
    AgentStatus,
    FleetAgent,
    PermissionOption,
    ToolCallStatus
};
