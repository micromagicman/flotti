import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventBody, AgentStatus, Delegation, DelegationMark, DelegationState, Quote, SendOptions } from './agent-events.js';
import { describeError } from './describe-error.js';
import { present } from './present.js';
/** What the tasks need of the fleet: the supervisor gives it. */
interface DelegationFleet {
    /** The status of the agent; nothing when there is no such agent in the fleet. */
    status(agentId: string): AgentStatus | undefined;
    /** Sends to the agent; resolves once the agent took the message, rejects when it never will. */
    send(agentId: string, text: string, options: SendOptions): Promise<void>;
    /** Takes a message back out of the line of the agent; whether it was still there. */
    withdraw(agentId: string, messageId: string): boolean;
    /** Asks the agent to drop what it is working on. */
    cancel(agentId: string): Promise<void>;
    /** Puts an event of flotti's own into the tab of the agent, when it is in the fleet. */
    note(agentId: string, body: AgentEventBody): void;
}
/** Where a task stands right after it was given. */
type DelegationStart = {
    readonly delegation: Delegation;
    /** The agent is busy: the task waits in line and reaches it once it is done. */
    readonly queued: boolean;
};
/** A task taken back, as it stands now. */
type DelegationCancel = {
    readonly delegation: Delegation;
    /** False when the task was over already: it stays as it ended. */
    readonly canceled: boolean;
};
type DelegateOptions = {
    /** Id of the task; a new one when absent. An A2A agent names it: the id of its message. */
    readonly id?: string;
    /** ISO 8601 time the task is to be done by. */
    readonly deadline?: string;
    /**
     * Whether a task that fails at once is also told to the agent that gave it,
     * as a message. A tool call gets the failure in its result and needs no
     * message; the A2A inbox has no answer of its own, so it does.
     */
    readonly tellFailure?: boolean;
};
/** A task in the making: what the tabs show of it, and what flotti needs to follow it. */
type Task = {
    view: Delegation;
    /** The `messageId` of the task in the tab of the agent that got it. */
    readonly messageId: string;
    /** The task as the outcome quotes it: in the tab of the agent that got it, written by the one that gave it. */
    readonly quote: Quote;
    timer: NodeJS.Timeout | undefined;
};
/** The turn an agent spends on a task: what it said in it so far. */
type TaskTurn = {
    readonly task: Task;
    /** The turn paused to ask a person — input or a login — and goes on with the next message. */
    paused: boolean;
    /** The messages of the agent in the turn, by `messageId`, in the order they began. */
    readonly said: Map<string, string>;
};
/** A message of an agent, as its tab shows it. */
type MessageEvent = AgentEvent & { type: 'message' };
/** How a task ends: its state, and why when it did not complete. */
type Outcome = { readonly state: DelegationState; readonly why?: string };
/** Why a task cannot be given, by one check; nothing when this check lets it be given. */
type RefusalCheck = (delegation: Delegation, status: AgentStatus | undefined) => string | undefined;
/** A task the agent asks about that it never gave. */
class UnknownDelegationError extends Error {}
/** Turn ends that are a pause, not an end: the agent waits for a person and goes on after. */
const PAUSES: readonly string[] = ['input_required', 'auth_required'];
/** The longest a timer of Node waits. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How a task ends by the way the turn of the agent on it ended, for the ends flotti knows. */
const OUTCOMES: ReadonlyMap<string, Outcome> = new Map<string, Outcome>([
    ['end_turn', { state: 'completed' }],
    ['cancelled', { state: 'canceled', why: 'the agent that got it cancelled its turn' }],
    ['refusal', { state: 'failed', why: 'the agent refused it' }],
    ['max_tokens', { state: 'failed', why: 'the agent ran out of tokens' }],
    ['error', { state: 'failed', why: 'the turn of the agent on it ended with an error' }]
]);
/** Why a task cannot be given, checked in this order: the first that says something is the reason. */
const REFUSAL_CHECKS: readonly RefusalCheck[] = [
    ({ to }, status) => status === undefined ? `there is no agent "${to}" in the fleet` : undefined,
    ({ from, to }) => to === from ? 'an agent does not give tasks to itself' : undefined,
    ({ to }, status) => status === 'stopped' ? `"${to}" is stopped` : undefined,
    ({ deadline }) => deadline !== undefined && Number.isNaN(Date.parse(deadline)) ? `the deadline "${deadline}" is not a time` : undefined,
    ({ deadline }) => deadline !== undefined && Date.parse(deadline) <= Date.now() ? 'its deadline has passed already' : undefined
];
/** How a task ends by the way the turn of the agent on it ended, and why when it did not complete. */
function outcomeOf(reason: string): Outcome {
    return OUTCOMES.get(reason) ?? { state: 'failed', why: `the turn of the agent on it ended: ${reason}` };
}
/** The text of a message once this event of it is taken: added to its end, or set anew. */
function spoken(before: string | undefined, event: MessageEvent): string {
    return event.append ? (before ?? '') + event.text : event.text;
}
/** Whether the task is still in the making and the agent gave it or got it. */
function involves(task: Task, agentId: string): boolean {
    return task.view.state === 'working' && (task.view.to === agentId || task.view.from === agentId);
}
/** The task as it ended: in its new state, with the result when there is one. */
function ended({ delegationId, from, to, text, deadline }: Delegation, state: DelegationState, result: string): Delegation {
    return {
        delegationId,
        from,
        to,
        text,
        state,
        ...present('deadline', deadline),
        ...(result === '' ? {} : { result })
    };
}
/**
 * Whether a message is still on its way after `ms`: true then, false once it
 * was taken or refused before. A refusal, whenever it comes, goes to
 * `refused`, with whether it came after `ms`, before the answer.
 */
function queuedAfter(sent: Promise<void>, ms: number, refused: (error: unknown, late: boolean) => void): Promise<boolean> {
    let late = false;
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            late = true;
            resolve(true);
        }, ms);
        const done = (): void => {
            clearTimeout(timer);
            resolve(false);
        };
        sent.then(done, (error: unknown) => {
            refused(error, late);
            done();
        });
    });
}
/** The parts that say something, one paragraph each. */
function joined(...parts: (string | undefined)[]): string {
    return parts.map((part) => part?.trim() ?? '').filter((part) => part !== '').join('\n\n');
}
/**
 * Tasks one agent of the fleet gives another, and what becomes of them. A task
 * is a message with an id: it goes in line with the other messages of the
 * agent that gets it, and the turn the agent spends on it is its work. How the
 * turn ends is how the task ends — `end_turn` completes it, with what the agent
 * said as the result; a cancelled turn cancels it; any other end fails it — and
 * the outcome goes back to the agent that gave the task, by itself, as a
 * message from the other one. The tabs of both agents show the task as it
 * stands, from the moment it is given to its outcome.
 *
 * A task that cannot be given — no such agent, the agent is stopped, it will
 * not take the message — fails at once, saying why. The agent that gave it may
 * take it back until it is over, and may give it a deadline: a task not over by
 * then fails, and the agent working on it is told to stop.
 */
class Delegations {
    private readonly tasks = new Map<string, Task>();
    /** The task each agent is working on, by the id of the agent. */
    private readonly turns = new Map<string, TaskTurn>();
    constructor(private readonly fleet: DelegationFleet, private readonly queuedAfterMs: number) {}
    /**
     * Gives the task. Resolves within the time a message may take before it
     * counts as queued: with the task failed at once, or working — taken, or
     * waiting in line.
     */
    delegate(from: string, to: string, text: string, options: DelegateOptions = {}): Promise<DelegationStart> {
        const known = this.known(options.id);
        if (known !== undefined) {
            return Promise.resolve({ delegation: known.view, queued: false });
        }
        const task = this.newTask(from, to, text, options);
        const refusal = this.refusal(task.view);
        if (refusal !== undefined) {
            this.settle(task, 'failed', refusal, options.tellFailure === true);
            return Promise.resolve({ delegation: task.view, queued: false });
        }
        this.show(task);
        this.arm(task);
        return this.hand(task, options.tellFailure === true);
    }
    /**
     * Takes a task back: out of the line when the agent has not started on it,
     * and the agent told to stop when it has. The agent that gave it knows, so
     * no outcome is sent to it. A task already over stays as it ended.
     *
     * @throws UnknownDelegationError when `from` gave no such task.
     */
    cancel(from: string, delegationId: string): DelegationCancel {
        const task = this.tasks.get(delegationId);
        if (task === undefined || task.view.from !== from) {
            throw new UnknownDelegationError(`"${from}" gave no task "${delegationId}"`);
        }
        const canceled = task.view.state === 'working';
        this.stop(task, 'canceled', `taken back by "${from}"`, false);
        return { delegation: task.view, canceled };
    }
    /** Follows the events of an agent: the turn it spends on a task ends the task. */
    take(agentId: string, event: AgentEvent): void {
        if (event.type === 'turn-end') {
            this.turnEnded(agentId, event.reason);
            return;
        }
        if (event.type === 'message') {
            this.messageShown(agentId, event);
        }
    }
    /** The agent left the fleet: the tasks it gave and the tasks it got fail. */
    left(agentId: string): void {
        this.turns.delete(agentId);
        for (const task of this.tasks.values()) {
            if (involves(task, agentId)) {
                this.stop(task, 'failed', `"${agentId}" left the fleet`, task.view.from !== agentId);
            }
        }
    }
    /** Forgets every task: the fleet was replaced. */
    clear(): void {
        for (const task of this.tasks.values()) {
            clearTimeout(task.timer);
        }
        this.tasks.clear();
        this.turns.clear();
    }
    /** The task given before under this id; nothing for a new one. */
    private known(id: string | undefined): Task | undefined {
        return id === undefined ? undefined : this.tasks.get(id);
    }
    private newTask(from: string, to: string, text: string, options: DelegateOptions): Task {
        const id = options.id ?? randomUUID();
        const messageId = randomUUID();
        const task: Task = {
            view: {
                delegationId: id,
                from,
                to,
                text,
                state: 'working',
                ...present('deadline', options.deadline)
            },
            messageId,
            quote: { agentId: to, messageId, author: from, text },
            timer: undefined
        };
        this.tasks.set(id, task);
        return task;
    }
    /** Why the task cannot be given at all; nothing when it can. */
    private refusal(delegation: Delegation): string | undefined {
        const status = this.fleet.status(delegation.to);
        for (const check of REFUSAL_CHECKS) {
            const why = check(delegation, status);
            if (why !== undefined) {
                return why;
            }
        }
        return undefined;
    }
    /**
     * Sends the task to the agent. A refusal within the wait fails the task at
     * once; a later one — the agent stopped before its turn came — fails it
     * then, and the agent that gave it is told.
     */
    private hand(task: Task, tellFailure: boolean): Promise<DelegationStart> {
        const { delegationId: id, from, to, text, deadline } = task.view;
        const sent = this.fleet.send(to, text, {
            from,
            messageId: task.messageId,
            delegation: { id, ...present('deadline', deadline) }
        });
        const queued = queuedAfter(sent, this.queuedAfterMs, (error, late) => {
            this.settle(task, 'failed', `"${to}" did not get it: ${describeError(error)}`, late || tellFailure);
        });
        return queued.then((waiting) => ({ delegation: task.view, queued: waiting }));
    }
    /** Fails the task once its deadline passes. */
    private arm(task: Task): void {
        const { deadline } = task.view;
        if (deadline === undefined) {
            return;
        }
        task.timer = setTimeout(() => this.stop(task, 'failed', 'its deadline passed', true), Math.min(Date.parse(deadline) - Date.now(), MAX_TIMER_MS));
        task.timer.unref();
    }
    /** Ends a task before the agent is done with it: taken out of its line, or the agent told to stop. */
    private stop(task: Task, state: DelegationState, why: string, tell: boolean): void {
        if (task.view.state !== 'working') {
            return;
        }
        const { to } = task.view;
        const working = this.isWorkedOn(task);
        if (!working) {
            this.fleet.withdraw(to, task.messageId);
        }
        this.settle(task, state, why, tell);
        if (working) {
            void this.fleet.cancel(to).catch(() => undefined);
        }
    }
    /** Whether the agent the task went to is working on it now. */
    private isWorkedOn(task: Task): boolean {
        return this.turns.get(task.view.to)?.task === task;
    }
    /** A message in the tab of the agent: one it got, or one it says. */
    private messageShown(agentId: string, event: MessageEvent): void {
        if (event.role === 'user') {
            this.messageCame(agentId, event);
            return;
        }
        if (event.to === undefined) {
            this.said(agentId, event);
        }
    }
    /** What the agent says in the turn it spends on a task, kept for the result; nothing while the turn is paused. */
    private said(agentId: string, event: MessageEvent): void {
        const turn = this.turns.get(agentId);
        if (turn !== undefined && !turn.paused) {
            turn.said.set(event.messageId, spoken(turn.said.get(event.messageId), event));
        }
    }
    private messageCame(agentId: string, event: MessageEvent): void {
        const task = this.handedTask(agentId, event);
        if (task !== undefined) {
            this.begin(agentId, task);
            return;
        }
        this.resume(agentId);
    }
    /** The task this message hands the agent; nothing for any other message. */
    private handedTask(agentId: string, event: MessageEvent): Task | undefined {
        const task = this.markedTask(event.delegation);
        return task !== undefined && task.view.to === agentId && task.messageId === event.messageId ? task : undefined;
    }
    /** The task a message carries as the task itself, not as its outcome. */
    private markedTask(mark: DelegationMark | undefined): Task | undefined {
        return mark === undefined || mark.state !== undefined ? undefined : this.tasks.get(mark.id);
    }
    /** The answer a paused turn waited for: the work on the task goes on. */
    private resume(agentId: string): void {
        const turn = this.turns.get(agentId);
        if (turn?.paused === true) {
            turn.paused = false;
        }
    }
    private begin(agentId: string, task: Task): void {
        const before = this.turns.get(agentId);
        if (before !== undefined && before.task !== task) {
            this.settle(before.task, 'failed', `"${agentId}" went on to other work before it finished this task`, true);
        }
        this.turns.set(agentId, { task, paused: false, said: new Map() });
        if (task.view.state !== 'working') {
            // Taken back, or overdue, while it was on its way to the agent.
            void this.fleet.cancel(agentId).catch(() => undefined);
        }
    }
    private turnEnded(agentId: string, reason: string): void {
        const turn = this.turns.get(agentId);
        if (turn === undefined) {
            return;
        }
        if (PAUSES.includes(reason)) {
            turn.paused = true;
            return;
        }
        this.turns.delete(agentId);
        const said = joined(...turn.said.values());
        const { state, why } = outcomeOf(reason);
        this.settle(turn.task, state, joined(why, said), true);
    }
    /** Ends the task as it ended, shows that in both tabs and, when `tell`, tells the agent that gave it. */
    private settle(task: Task, state: DelegationState, result: string, tell: boolean): void {
        if (task.view.state !== 'working') {
            return;
        }
        clearTimeout(task.timer);
        task.view = ended(task.view, state, result);
        this.show(task);
        if (tell) {
            this.tellGiver(task);
        }
    }
    /** The task as it stands, in the tabs of both agents. */
    private show(task: Task): void {
        const event: AgentEventBody = { type: 'delegation', ...task.view };
        this.fleet.note(task.view.from, event);
        if (task.view.to !== task.view.from) {
            this.fleet.note(task.view.to, event);
        }
    }
    /**
     * Sends the outcome to the agent that gave the task: from the agent that got
     * it, quoting the task. It answers the task, so it gets no answer back.
     */
    private tellGiver(task: Task): void {
        const { delegationId: id, from, to, state, result } = task.view;
        const fromAgent = this.fleet.status(to) === undefined ? {} : { from: to };
        this.fleet.send(from, result ?? '', { ...fromAgent, replyTo: task.quote, delegation: { id, state } }).catch((error: unknown) => {
            this.fleet.note(from, { type: 'log', source: 'flotti', text: `could not deliver the outcome of task ${id}: ${describeError(error)}` });
        });
    }
}
export { Delegations, UnknownDelegationError };
export type { DelegateOptions, DelegationCancel, DelegationFleet, DelegationStart };
