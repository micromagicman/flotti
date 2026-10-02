import type { ConnectionHealth, HealthListener } from './connection-health.js';
import type { MemoryStatus } from './dashboard-protocol.js';
import { present } from './present.js';
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
        /**
         * Id of the group of the fleet (docs/groups.md) the message went through.
         * On a message to the agent (`role: 'user'`): it was posted to the group,
         * by the agent `from` names or by a person, and the tab shows the group.
         * On a message of the agent (`role: 'agent'`): the agent posts it to the
         * group, and flotti sends it on to every other member; one of `to` and
         * `group`, never both. In the history of the agent, a message it said
         * in the turn of a group message carries that group too (0.7.0, #172):
         * the turn is marked, see {@link AgentEvent}.
         */
        readonly group?: string;
        /**
         * The members the message mentions with `@<id>` (0.7.0, #174), in the
         * order of the text; absent when there are none. On a message to the
         * agent, which of them is itself is read from its own id in the list.
         */
        readonly mentions?: readonly string[];
        /** The message this one answers: a reply, from a person or from an agent. */
        readonly replyTo?: Quote;
        /**
         * The message is the answer flotti sent back on its own at the end of a
         * turn of the sender (`role: 'user'`, with `from` and `replyTo`): it gets
         * no answer back, or two agents would answer each other for ever. A reply
         * an agent sends itself, with its `reply` tool, is an ordinary message.
         */
        readonly turnAnswer?: true;
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
        /** As in a `message` event: the agent of the fleet that sent it, the group it came through, the members it mentions, what it answers, sends on or sends again, and the task it is about. */
        readonly from?: string;
        readonly group?: string;
        readonly mentions?: readonly string[];
        readonly replyTo?: Quote;
        readonly turnAnswer?: true;
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
    /**
     * Id of the group whose message started the turn this event is part of
     * (0.7.0, #172): flotti puts it on every event of such a turn it keeps —
     * the agent's messages, thoughts, tool calls, the `turn-end` — and the tab
     * of the agent does not show them, the tab of the group does. On a
     * `message` or `queued` event it is also the group the message went
     * through, as said there; a status is not marked.
     */
    readonly group?: string;
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
    /**
     * Id of the group the task was given in (0.7.0, #171): both agents are
     * members, the task and its outcome are posted there. Absent on a task of
     * 0.6.x, given agent to agent.
     */
    readonly group?: string;
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
    /** Id of the group the message was posted to (docs/groups.md); see the `group` of a `message` event. */
    readonly group?: string;
    /** The members the message mentions with `@<id>` (0.7.0, #174), in the order of the text; absent when there are none. */
    readonly mentions?: readonly string[];
    /** Whether this receiver is one of the mentioned members: the mark says `to you` instead of naming them. */
    readonly mentioned?: boolean;
    readonly replyTo?: Quote;
    /** The answer flotti sends back at the end of a turn; see the `turnAnswer` of a `message` event. */
    readonly turnAnswer?: true;
    readonly forwarded?: Forwarded;
    /** The `messageId` of an undelivered message this one sends again. */
    readonly retryOf?: string;
    /** The task the message gives, or the outcome of a task it tells; see the `delegation` of a `message` event. */
    readonly delegation?: DelegationMark;
};
/** The fields of a `message` or `queued` event a sent message carries on, beyond its text. */
function messageFields(options: SendOptions): Pick<AgentEvent & { type: 'message' }, 'from' | 'group' | 'mentions' | 'replyTo' | 'turnAnswer' | 'forwarded' | 'retryOf' | 'delegation'> {
    return {
        ...present('from', options.from),
        ...present('group', options.group),
        ...mentionsOf(options.mentions),
        ...present('replyTo', options.replyTo),
        ...present('turnAnswer', options.turnAnswer === true ? true as const : undefined),
        ...present('forwarded', options.forwarded),
        ...present('retryOf', options.retryOf),
        ...present('delegation', options.delegation)
    };
}
/** The `mentions` of a message event: present with the ids, absent when there are none. */
function mentionsOf(mentions: readonly string[] | undefined): { readonly mentions?: readonly string[] } {
    return mentions === undefined || mentions.length === 0 ? {} : { mentions };
}
/**
 * The mark in front of a message that says who sent it, through which group
 * and who is asked, for an agent that has no other place for it — a local
 * agent over ACP, a remote one without the inbox: `[from eva in group
 * release, to you]`, `[from eva in group release, to codex]` for the others,
 * `[from eva]`, `[in group release, to you]` for a message a person posted to
 * the group that mentions a member; nothing for a message of a person to the
 * agent itself.
 */
function senderMark(options: SendOptions): string | undefined {
    const parts = [
        ...(options.from === undefined ? [] : [`from ${options.from}`]),
        ...(options.group === undefined ? [] : [`in group ${options.group}`])
    ];
    return parts.length === 0 ? undefined : `[${parts.join(' ')}${addressedMark(options)}]`;
}
/** Who of the group is asked: `, to you` for a mentioned receiver, `, to <ids>` for the others, nothing when nobody is mentioned. */
function addressedMark(options: SendOptions): string {
    const mentions = options.mentions;
    if (mentions === undefined || mentions.length === 0) {
        return '';
    }
    return options.mentioned === true ? ', to you' : `, to ${mentions.join(', ')}`;
}
/** The text with the sender mark in front of it, when there is one to put. */
function markedText(text: string, options: SendOptions): string {
    const mark = senderMark(options);
    return mark === undefined ? text : `${mark} ${text}`;
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
        } else if (leavesLine(event)) {
            waiting.delete(event.messageId);
        }
    }
    return [...waiting.values()];
}
/** Whether the event takes a queued message out of the line: it was taken back, or the agent took it. */
function leavesLine(event: AgentEvent): event is AgentEvent & { type: 'unqueued' | 'message' } {
    return event.type === 'unqueued' || (event.type === 'message' && event.role === 'user');
}
/**
 * The line above a message about a task: the agent that gets a task learns
 * that its answer is the result, the one that gave it how it ended.
 */
function delegationLine(mark: DelegationMark): string {
    return mark.state === undefined ? givenLine(mark) : OUTCOME_LINES[mark.state](mark.id);
}
/** The line above a task given to the agent that reads it. */
function givenLine(mark: DelegationMark): string {
    const due = mark.deadline === undefined ? '' : ` It is due by ${mark.deadline}.`;
    return `Task ${mark.id}, given to you.${due} What you answer in this turn is its result; end the turn when it is done.`;
}
/** The line above the outcome of a task, told to the agent that gave it, by how the task ended. */
const OUTCOME_LINES: { readonly [S in DelegationState]: (id: string) => string } = {
    completed: (id) => `The task ${id} you gave is completed.`,
    working: (id) => `The task ${id} you gave is working.`,
    failed: (id) => `The task ${id} you gave has failed.`,
    canceled: (id) => `The task ${id} you gave was canceled.`
};
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
    return [
        replyPart(options.replyTo, reader),
        options.delegation === undefined ? undefined : delegationLine(options.delegation),
        text.trim() === '' ? undefined : text,
        forwardPart(options.forwarded, reader)
    ].filter((part): part is string => part !== undefined).join('\n\n');
}
/** The quoted message a reply answers, above the answer. */
function replyPart(replyTo: Quote | undefined, reader: string): string | undefined {
    if (replyTo === undefined) {
        return undefined;
    }
    const quoted = replyTo.text.split('\n').map((line) => `> ${line}`).join('\n');
    return `In reply to a message from ${whose(replyTo.author, reader)}:\n${quoted}`;
}
/** The message sent on, under what was written above it. */
function forwardPart(forwarded: Forwarded | undefined, reader: string): string | undefined {
    return forwarded === undefined ? undefined : `Forwarded from ${whose(forwarded.author, reader)}:\n\n${forwarded.text}`;
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
export { AgentEvents, WITHDRAWN, composeText, markedText, messageFields, senderMark, waitingInLine };
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
