import type { ConnectionHealth, HealthListener } from './connection-health.js';
import type { MemoryStatus } from './dashboard-protocol.js';
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
/** What an administrator of the fleet does to an agent (#55). */
type AdminAction = 'restart' | 'clear-context';
/**
 * Where an action of an administrator is:
 * - `pending`   — waits for a person to allow it in the dashboard;
 * - `refused`   — not done: a person refused it, or the caller may not do it;
 * - `scheduled` — allowed, and done once the turn the administrator asked it in is over: it acts on itself;
 * - `done`      — done;
 * - `failed`    — tried, and it did not work; the reason says why.
 */
type AdminActionState = 'pending' | 'refused' | 'scheduled' | 'done' | 'failed';
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
        /**
         * Id of the agent of the fleet that sent this message through flotti
         * (`role: 'user'`): it goes where a person's message goes, and the tab
         * shows who sent it. Absent for a message a person sent.
         */
        readonly from?: string;
        /**
         * Id of the agent of the fleet this message of the agent is for
         * (`role: 'agent'`): flotti sends it on to that agent, and the tab of the
         * sender shows it as sent there. Absent for an answer to a person.
         */
        readonly to?: string;
        /** The message this one answers: a reply, from a person or from an agent. */
        readonly replyTo?: Quote;
        /**
         * A message sent on as it was. The `text` of the event is then what the
         * one who forwarded it wrote above it, and may be empty.
         */
        readonly forwarded?: Forwarded;
        /** The `messageId` of an undelivered message this one sends again (`role: 'user'`). */
        readonly retryOf?: string;
        /**
         * The message is about a task one agent gave another: on a message of
         * the agent (`role: 'agent'`, with `to`) it gives the task; on a message
         * to the agent (`role: 'user'`) it is the task given to it, or — with a
         * `state` — the outcome of a task it gave.
         */
        readonly delegation?: DelegationMark;
    }
    /**
     * A message that has to wait in line: the agent is busy with another one,
     * or not ready yet. Once the agent takes it, a `message` event with the same
     * `messageId` follows; a message that never gets there ends with `unqueued`.
     */
    | {
        readonly type: 'queued';
        readonly messageId: string;
        readonly text: string;
        /** As in a `message` event: the agent of the fleet that sent it, what it answers, sends on or sends again, and the task it is about. */
        readonly from?: string;
        readonly replyTo?: Quote;
        readonly forwarded?: Forwarded;
        readonly retryOf?: string;
        readonly delegation?: DelegationMark;
    }
    /**
     * A queued message left the line without reaching the agent:
     * - `withdrawn` — a person took it back;
     * - `dropped`   — the agent stopped or restarted, or flotti did, before its turn;
     *                 `reason` says which.
     */
    | {
        readonly type: 'unqueued';
        readonly messageId: string;
        readonly outcome: 'withdrawn' | 'dropped';
        readonly reason?: string;
    }
    /** A piece of the agent's reasoning, shown apart from its answer. */
    | { readonly type: 'thought'; readonly text: string }
    /**
     * A line about what the agent is doing — "running the tests", "waiting for
     * CI" — said while it works, in a turn or on its own. Shown in the open, unlike
     * a thought, and not a message: it answers nobody.
     */
    | { readonly type: 'progress'; readonly text: string }
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
    /**
     * An action of an administrator of the fleet on an agent: the same event,
     * by `actionId`, in the tab of the administrator and in the tab of the
     * agent, once for every state it goes through.
     */
    | {
        readonly type: 'admin-action';
        readonly actionId: string;
        readonly action: AdminAction;
        /** Id of the administrator that asked for it. */
        readonly admin: string;
        /** Id of the agent it acts on; may be the administrator itself. */
        readonly target: string;
        readonly state: AdminActionState;
        /** Why it was refused or failed. */
        readonly reason?: string;
    }
    /** A line of diagnostics: from the agent itself, or from the side that runs it. */
    | { readonly type: 'log'; readonly source: 'agent' | 'flotti'; readonly text: string }
    /** Something the protocol said that has no event of its own here, untouched. */
    | { readonly type: 'raw'; readonly protocol: 'acp' | 'a2a'; readonly payload: unknown }
    /**
     * A task one agent of the fleet gave another, as it stands now: flotti puts
     * it in the tabs of both agents, again every time its state changes.
     */
    | ({ readonly type: 'delegation' } & Delegation)
    /** The agent asks flotti to cancel a task it gave another agent. */
    | { readonly type: 'cancel-delegation'; readonly delegationId: string };
/** An event with its place in the agent's history. */
type AgentEvent = AgentEventBody & {
    readonly agentId: string;
    /** Grows by one with every event of this agent, so a consumer can ask for "everything after N". */
    readonly seq: number;
    /** ISO 8601 time the event happened. */
    readonly time: string;
};
type AgentEventListener = (event: AgentEvent) => void;
/**
 * The message a reply answers, as the reply carries it: where it is, who wrote
 * it and what it said. The text travels with the reply, so the agent reads
 * what it is answered to even when that message is long gone from its feed.
 */
type Quote = {
    /** Id of the agent in whose tab the quoted message is. */
    readonly agentId: string;
    /** The `messageId` of the quoted message in that tab. */
    readonly messageId: string;
    /**
     * The `seq` of the event that began the quoted message, when the one who
     * quotes saw it: an agent may use one message id turn after turn, a `seq`
     * is never used twice in a tab.
     */
    readonly seq?: number;
    /** Id of the agent that wrote it; absent when a person did. */
    readonly author?: string;
    readonly text: string;
};
/**
 * Where a task one agent gave another stands:
 * - `working`   — given, and waiting in line or being worked on;
 * - `completed` — the agent that got it finished its turn on it;
 * - `failed`    — it could not be given, the agent failed it, or its deadline passed;
 * - `canceled`  — the agent that gave it took it back, or the one that got it cancelled it.
 */
type DelegationState = 'working' | 'completed' | 'failed' | 'canceled';
/** What a message says of the task it is about. */
type DelegationMark = {
    /** Id of the task, as the agent that gave it knows it. */
    readonly id: string;
    /** ISO 8601 time the task is to be done by. */
    readonly deadline?: string;
    /** On the outcome sent to the agent that gave the task: how it ended. */
    readonly state?: DelegationState;
};
/** A task one agent of the fleet gave another, as the tabs of both show it. */
type Delegation = {
    readonly delegationId: string;
    /** Id of the agent that gave the task. */
    readonly from: string;
    /** Id of the agent the task was given to. */
    readonly to: string;
    readonly text: string;
    readonly state: DelegationState;
    /** ISO 8601 time the task is to be done by. */
    readonly deadline?: string;
    /** What the agent answered, once completed; why, once failed or canceled. */
    readonly result?: string;
};
/** A message sent on to another agent as it was. */
type Forwarded = {
    /** Id of the agent that wrote it; absent when a person did. */
    readonly author?: string;
    readonly text: string;
};
/**
 * Who a message is from, when it is not a person, and what it answers or
 * sends on. A person in the dashboard and an agent calling a tool of flotti
 * say it the same way.
 */
type SendOptions = {
    /** Id of the agent of the fleet that sends the message; see the `from` of a `message` event. */
    readonly from?: string;
    /** The `messageId` the message gets in the tab of the receiver; a new one when absent. */
    readonly messageId?: string;
    readonly replyTo?: Quote;
    readonly forwarded?: Forwarded;
    /** The `messageId` of an undelivered message this one sends again. */
    readonly retryOf?: string;
    /** The task the message gives, or the outcome of a task it tells; see the `delegation` of a `message` event. */
    readonly delegation?: DelegationMark;
};
/** The fields of a `message` or `queued` event a sent message carries on, beyond its text. */
function messageFields(options: SendOptions): Pick<AgentEvent & { type: 'message' }, 'from' | 'replyTo' | 'forwarded' | 'retryOf' | 'delegation'> {
    return {
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        ...(options.forwarded === undefined ? {} : { forwarded: options.forwarded }),
        ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
        ...(options.delegation === undefined ? {} : { delegation: options.delegation })
    };
}
/** Why a message taken back out of the line never reached the agent: its `send` rejects with it. */
const WITHDRAWN = 'the message was taken out of the line';
/**
 * The messages still in line after these events of one agent, oldest first:
 * queued, and neither taken — its `message` event came — nor out of the line.
 */
function waitingInLine(events: readonly AgentEvent[]): (AgentEvent & { type: 'queued' })[] {
    const waiting = new Map<string, AgentEvent & { type: 'queued' }>();
    for (const event of events) {
        if (event.type === 'queued') {
            waiting.set(event.messageId, event);
        } else if (event.type === 'unqueued' || (event.type === 'message' && event.role === 'user')) {
            waiting.delete(event.messageId);
        }
    }
    return [...waiting.values()];
}
/**
 * The line above a message about a task: the agent that gets a task learns
 * that its answer is the result, the one that gave it how it ended.
 */
function delegationLine(mark: DelegationMark): string {
    switch (mark.state) {
        case 'completed':
        case 'working':
            return `The task ${mark.id} you gave is ${mark.state}.`;
        case 'failed':
            return `The task ${mark.id} you gave has failed.`;
        case 'canceled':
            return `The task ${mark.id} you gave was canceled.`;
        case undefined:
            break;
    }
    const due = mark.deadline === undefined ? '' : ` It is due by ${mark.deadline}.`;
    return `Task ${mark.id}, given to you.${due} What you answer in this turn is its result; end the turn when it is done.`;
}
/** Whose message it was, as the agent that reads it is told. */
function whose(author: string | undefined, reader: string): string {
    if (author === undefined) {
        return 'the person';
    }
    return author === reader ? 'you' : `agent "${author}"`;
}
/**
 * The text the agent `reader` gets for a message: a reply puts the quoted
 * message above the answer, a forward puts the forwarded one under what was
 * written above it. Who sent it is not in here: each kind of agent says that
 * its own way.
 */
function composeText(text: string, options: SendOptions, reader: string): string {
    const parts: string[] = [];
    if (options.replyTo !== undefined) {
        const quoted = options.replyTo.text.split('\n').map((line) => `> ${line}`).join('\n');
        parts.push(`In reply to a message from ${whose(options.replyTo.author, reader)}:\n${quoted}`);
    }
    if (options.delegation !== undefined) {
        parts.push(delegationLine(options.delegation));
    }
    if (text.trim() !== '') {
        parts.push(text);
    }
    if (options.forwarded !== undefined) {
        parts.push(`Forwarded from ${whose(options.forwarded.author, reader)}:\n\n${options.forwarded.text}`);
    }
    return parts.join('\n\n');
}
/** An agent of the fleet as the dashboard drives it, local or remote. */
interface FleetAgent {
    /** Id of the agent: the name of its directory in the fleet. */
    readonly agentId: string;
    /** The status the last `status` event reported. */
    readonly status: AgentStatus;
    /**
     * The program that runs the agent, when the agent says it itself — a remote
     * one does once connected to. Absent for an agent whose manifest tells it.
     */
    readonly harness?: string;
    /** The memory flotti delivered to the agent (#101); absent when it has nothing to say. */
    readonly memory?: MemoryStatus;
    /** Calls the listener with every event from now on; returns the way to stop. */
    subscribe(listener: AgentEventListener): () => void;
    /** The fleet changed: an agent told who is in it is told again (docs/a2a-fleet.md). */
    fleetChanged?(): void;
    /** Starts the agent, or connects to it; resolves once it can take messages. */
    start(): Promise<void>;
    /**
     * Sends a message from a person. A busy agent gets it once it is done with
     * the previous one: messages queue, they do not interrupt. Resolves when the
     * agent has taken the message, not when it has answered: what comes of it
     * arrives as events, down to `turn-end`. Rejects when the message never
     * reached the agent — not started, stopped, gone before its turn.
     *
     * A message another agent sends goes the same way, with `from` naming the
     * sender: the agent is told who it is from, and its `message` event says so.
     *
     * A message that has to wait says so at once with a `queued` event, under
     * the `messageId` of the options — or one of its own when they give none.
     */
    send(text: string, options?: SendOptions): Promise<void>;
    /**
     * Takes a message that waits in line back out of it, before the agent got
     * it: an `unqueued` event says so, and its `send` rejects.
     *
     * @returns Whether the message was still waiting.
     */
    withdraw(messageId: string): boolean;
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
    /**
     * Starts the conversation anew: the next message goes without what was
     * said before. Drops the message in work. A local agent gets a new ACP
     * session, a remote one a new `contextId`.
     */
    clearContext(): Promise<void>;
    /** Stops the agent, or disconnects from it; queued messages are dropped. */
    stop(): Promise<void>;
    /**
     * Health of the connection to an agent reached over one that has to be kept
     * open — an SSH tunnel; absent for any other agent.
     */
    readonly health?: ConnectionHealth;
    /** Calls the listener whenever {@link health} changes; returns the way to stop. */
    onHealth?(listener: HealthListener): () => void;
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
export { AgentEvents, WITHDRAWN, composeText, messageFields, waitingInLine };
export type {
    AdminAction,
    AdminActionState,
    AgentEvent,
    AgentEventBody,
    AgentEventListener,
    AgentStatus,
    Delegation,
    DelegationMark,
    DelegationState,
    FleetAgent,
    Forwarded,
    PermissionOption,
    Quote,
    SendOptions,
    ToolCallStatus
};
