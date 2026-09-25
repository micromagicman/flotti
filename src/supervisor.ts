import { randomUUID } from 'node:crypto';
import { A2AAgent } from './a2a-agent.js';
import type { AdminRequest } from './a2a-agent.js';
import { AgentAnswers } from './agent-answers.js';
import { waitingInLine } from './agent-events.js';
import type { AdminAction, AgentEvent, AgentEventBody, FleetAgent, Quote, SendOptions } from './agent-events.js';
import { HistoryFile } from './agent-history.js';
import type { ConnectionHealth } from './connection-health.js';
import { Delegations } from './delegations.js';
import type { DelegationCancel, DelegationFleet, DelegationStart } from './delegations.js';
import type { AgentSummary, Delivery, Harness } from './dashboard-protocol.js';
import { FleetAdmin } from './fleet-admin.js';
import type { AdminFleet, AdminOutcome } from './fleet-admin.js';
import type { DeliveredMessage, FleetToolsAccess } from './fleet-mcp.js';
import { LocalAgentProcess } from './local-agent.js';
import type { Agent, Fleet } from './types.js';
/**
 * The harness of an agent: the adapter of a local one, as its manifest tells,
 * and what a remote one says of itself once connected to. A plain ACP agent
 * and a remote one that says nothing get no harness: the summary leaves the
 * field out rather than guess.
 */
function harnessOf(agent: Agent, running: FleetAgent): { readonly harness?: Harness } {
    if (agent.kind !== 'local') {
        return running.harness === undefined ? {} : { harness: running.harness };
    }
    switch (agent.adapter) {
        case 'claude-code':
            return { harness: 'claude' };
        case 'codex':
            return { harness: 'codex' };
        case undefined:
            return {};
    }
}
/** What the supervisor says besides the agents' own events. */
type SupervisorNotice =
    | { readonly type: 'event'; readonly event: AgentEvent }
    | { readonly type: 'delivery'; readonly delivery: Delivery }
    /** The health of the connection of an agent changed. */
    | { readonly type: 'health'; readonly agentId: string; readonly health: ConnectionHealth }
    /** An agent was added, changed or removed, or the whole fleet was replaced. */
    | { readonly type: 'fleet'; readonly agents: readonly AgentSummary[] };
type SupervisorListener = (notice: SupervisorNotice) => void;
type SupervisorOptions = {
    /** How an agent of the fleet becomes a running one; tests put their own in. */
    readonly createAgent?: (agent: Agent) => FleetAgent;
    /** Events kept per agent for a page that connects later or reconnects. */
    readonly historyLimit?: number;
    /**
     * Whether the events of each agent are also written to its directory and
     * read back when flotti starts again, so its tab survives the restart.
     * Off unless asked for: `flotti run` asks, tests of fake fleets do not.
     */
    readonly persistHistory?: boolean;
    /** Where a problem with the history on disk is reported; standard error by default. */
    readonly warn?: (text: string) => void;
    /** How long a message may take to reach the agent before it counts as queued. */
    readonly queuedAfterMs?: number;
    /**
     * The fleet tools each agent flotti starts gets in its sessions; none when
     * absent. `flotti run` gives them, tests of fake fleets do not. A message
     * the supervisor sends on from one agent to another goes to `delivered`,
     * so that `reply` and `forward` of the receiver act on it.
     */
    readonly fleetTools?: {
        access(agentId: string): FleetToolsAccess;
        delivered?(message: DeliveredMessage): void;
    };
    /**
     * Whether an action of an administrator of the fleet waits for a person to
     * allow it in the dashboard; asked at every action, off when absent.
     */
    readonly confirmAdminActions?: () => boolean;
};
/** One agent of the fleet with what the dashboard needs of it. */
type Member = {
    readonly agent: Agent;
    readonly running: FleetAgent;
    readonly history: AgentEvent[];
    /**
     * Added to the numbers of the running agent's events. A changed agent is a
     * new running one that counts from one again; the offset keeps the numbers
     * of its id growing, so a page that has seen N still gets what comes next.
     */
    offset: number;
    /** The history on disk; absent when it is kept in memory only. */
    readonly file: HistoryFile | undefined;
    /** What the agent answers to a message of another agent, to send back to it. */
    readonly answers: AgentAnswers;
    unsubscribe: () => void;
    /** The harness the pages were last told the agent has: a change is announced. */
    harness: string | undefined;
    /** Whether the agent is in a turn: between a message it took and the end of its answer. */
    inTurn: boolean;
    /** Called once the turn is over: actions an administrator asked for on itself in the turn. */
    turnOver: (() => void)[];
};
/** What a member starts with besides its agent and its history. */
function freshMember(): Pick<Member, 'answers' | 'unsubscribe' | 'harness' | 'inTurn' | 'turnOver'> {
    return { answers: new AgentAnswers(), unsubscribe: () => undefined, harness: undefined, inTurn: false, turnOver: [] };
}
/** An agent the request names that is not in the fleet. */
class UnknownAgentError extends Error {}
/**
 * How an agent of the fleet runs: a local process, or a remote agent whose
 * requests as an administrator go to `onAdminRequest`.
 */
function defaultAgent(
    fleetTools: SupervisorOptions['fleetTools'],
    onAdminRequest: (agentId: string, request: AdminRequest) => void
): (agent: Agent) => FleetAgent {
    return (agent) => agent.kind === 'local'
        ? new LocalAgentProcess(agent, fleetTools === undefined ? {} : { fleetTools: fleetTools.access(agent.id) })
        : new A2AAgent(agent, { onAdminRequest: (request) => onAdminRequest(agent.id, request) });
}
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
/** Local agents first, then remote ones, each group by id — the order of the fleet directory. */
function fleetOrder(left: Agent, right: Agent): number {
    if (left.kind !== right.kind) {
        return left.kind === 'local' ? -1 : 1;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
/**
 * The fleet at work: every agent started, its events numbered and kept, so a
 * page that connects later — or loses its connection for a while — gets what
 * it missed. It is the one source of truth; pages only subscribe to it.
 *
 * The fleet changes while it runs: the settings page adds, changes and
 * removes agents, and may point flotti at another fleet directory altogether.
 */
class Supervisor {
    private readonly members = new Map<string, Member>();
    private readonly listeners = new Set<SupervisorListener>();
    private readonly createAgent: (agent: Agent) => FleetAgent;
    private readonly historyLimit: number;
    private readonly queuedAfterMs: number;
    private readonly persistHistory: boolean;
    private readonly warn: (text: string) => void;
    /** Told of each message the supervisor sends on from one agent to another. */
    private readonly delivered: ((message: DeliveredMessage) => void) | undefined;
    /** Last number given to an event of each id, kept when the agent goes: numbers of an id only grow. */
    private readonly lastSeq = new Map<string, number>();
    /** Tasks agents give one another. */
    private readonly delegations: Delegations;
    /** What administrators of the fleet do to the agents. */
    private readonly admin: FleetAdmin;
    constructor(fleet: Fleet, options: SupervisorOptions = {}) {
        this.createAgent = options.createAgent
            ?? defaultAgent(options.fleetTools, (agentId, request) => void this.adminRequest(agentId, request));
        this.admin = new FleetAdmin(this.adminFleet(), options.confirmAdminActions === undefined ? {} : { confirm: options.confirmAdminActions });
        this.historyLimit = options.historyLimit ?? 5000;
        this.queuedAfterMs = options.queuedAfterMs ?? 500;
        this.persistHistory = options.persistHistory ?? false;
        this.warn = options.warn ?? ((text) => console.error(text));
        this.delivered = options.fleetTools?.delivered?.bind(options.fleetTools);
        this.delegations = new Delegations(this.delegationFleet(), this.queuedAfterMs);
        for (const agent of fleet.agents) {
            this.join(agent, []);
        }
    }
    /** The agents in fleet order: local first, then remote, each by id. */
    agents(): AgentSummary[] {
        return [...this.members.values()]
            .sort((left, right) => fleetOrder(left.agent, right.agent))
            .map(({ agent, running }) => ({
                id: agent.id,
                name: agent.name,
                kind: agent.kind,
                ...(agent.description === undefined ? {} : { description: agent.description }),
                ...harnessOf(agent, running),
                status: running.status,
                ...(running.health === undefined ? {} : { health: running.health }),
                ...(agent.admin === true ? { admin: true as const } : {})
            }));
    }
    /** The agent as its manifest describes it. */
    agent(agentId: string): Agent {
        return this.member(agentId).agent;
    }
    /** Kept events of the agent that came after `afterSeq`, oldest first. */
    history(agentId: string, afterSeq = 0): AgentEvent[] {
        return this.member(agentId).history.filter((event) => event.seq > afterSeq);
    }
    /** Calls the listener with every event and late delivery from now on; returns the way to stop. */
    subscribe(listener: SupervisorListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Starts every agent at once and waits for them all. An agent that fails to
     * start does not stop the others: its status says why, and a restart is the
     * way to try again.
     */
    async start(): Promise<void> {
        await Promise.all([...this.members.values()].map(({ running }) => running.start().catch(() => undefined)));
    }
    /** Stops every agent: local processes end, remote connections close. */
    async stop(): Promise<void> {
        const members = [...this.members.values()];
        await Promise.all(members.map(({ running }) => running.stop().catch(() => undefined)));
        for (const member of members) {
            member.unsubscribe();
        }
    }
    /** Starts one agent; resolves once it can take messages, or rejects saying why it cannot. */
    startAgent(agentId: string): Promise<void> {
        return this.member(agentId).running.start();
    }
    /** Stops one agent; it stays stopped until it is started again. */
    stopAgent(agentId: string): Promise<void> {
        return this.member(agentId).running.stop();
    }
    /**
     * Takes a new agent into the fleet and starts it, as `flotti run` starts
     * every agent. Returns once it is in the fleet, not once it has started:
     * its status says how that goes.
     */
    add(agent: Agent): void {
        if (this.members.has(agent.id)) {
            throw new Error(`There is an agent "${agent.id}" in the fleet already.`);
        }
        const member = this.join(agent, []);
        this.announce();
        void member.running.start().catch(() => undefined);
    }
    /**
     * Puts a changed manifest to work. The agent is stopped and runs on with the
     * new one — started again unless it had been stopped on purpose — and keeps
     * its history: its tab goes on where it was.
     */
    async replace(agent: Agent): Promise<void> {
        const old = this.member(agent.id);
        const wasStopped = old.running.status === 'stopped';
        await old.running.stop().catch(() => undefined);
        old.unsubscribe();
        const member = this.join(agent, old.history, old.file);
        this.announce();
        if (!wasStopped) {
            void member.running.start().catch(() => undefined);
        }
    }
    /** Stops the agent and lets it go: it is no longer in the fleet. */
    async remove(agentId: string): Promise<void> {
        const member = this.member(agentId);
        this.members.delete(agentId);
        this.delegations.left(agentId);
        await member.running.stop().catch(() => undefined);
        member.unsubscribe();
        this.announce();
    }
    /**
     * Stops every agent and works with another fleet from now on: the settings
     * page pointed flotti at another fleet directory. Resolves once the old
     * agents are stopped and the new ones are starting; their statuses say how
     * that goes.
     */
    async load(fleet: Fleet): Promise<void> {
        await this.stop();
        this.members.clear();
        this.delegations.clear();
        for (const agent of fleet.agents) {
            this.join(agent, []);
        }
        this.announce();
        void this.start();
    }
    /**
     * Sends a message to one agent; says whether it was taken, waits in line, or failed.
     *
     * A message from another agent of the fleet names it in `from`: the
     * receiver is told who it is from, and its tab shows the message as sent by
     * that agent. This is how one agent writes to another, whatever carries the
     * words to flotti — the A2A inbox (`to` of a `message` event), or a tool of
     * flotti the agent calls.
     *
     * @throws UnknownAgentError when either agent is not in the fleet.
     */
    send(agentId: string, text: string, options: SendOptions = {}): Promise<Delivery> {
        const member = this.member(agentId);
        if (options.from !== undefined) {
            this.member(options.from);
        }
        return this.deliver(member, text, options);
    }
    /**
     * Sends one message to many agents, each on its own: an agent that is down
     * or busy does not hold the others up.
     *
     * @param agentIds Which agents; all of them when absent.
     */
    async broadcast(text: string, agentIds?: readonly string[]): Promise<Delivery[]> {
        const members = agentIds === undefined
            ? [...this.members.values()]
            : [...new Set(agentIds)].map((id) => this.member(id));
        return Promise.all(members.map((member) => this.deliver(member, text)));
    }
    /**
     * Takes a message that waits in line for the agent back out of it.
     *
     * @returns Whether it was still waiting: one the agent took already stays.
     * @throws UnknownAgentError when the agent is not in the fleet.
     */
    withdraw(agentId: string, messageId: string): boolean {
        return this.member(agentId).running.withdraw(messageId);
    }
    /** The fleet as the tasks agents give one another see it. */
    private delegationFleet(): DelegationFleet {
        return {
            status: (agentId) => this.members.get(agentId)?.running.status,
            send: (agentId, text, sendOptions) => {
                const member = this.members.get(agentId);
                return member === undefined
                    ? Promise.reject(new UnknownAgentError(`There is no agent "${agentId}" in the fleet.`))
                    : member.running.send(text, sendOptions);
            },
            withdraw: (agentId, messageId) => this.members.get(agentId)?.running.withdraw(messageId) ?? false,
            cancel: (agentId) => this.members.get(agentId)?.running.cancel() ?? Promise.resolve(),
            note: (agentId, body) => {
                const member = this.members.get(agentId);
                if (member !== undefined) {
                    this.put(member, body);
                }
            }
        };
    }
    /**
     * One agent of the fleet gives another a task: see {@link Delegations}.
     * Resolves at once with the task failed when it cannot be given, and within
     * the time a message may take to reach the agent otherwise.
     *
     * @param deadline ISO 8601 time the task is to be done by.
     * @throws UnknownAgentError when the agent that gives it is not in the fleet.
     */
    delegate(from: string, to: string, text: string, deadline?: string): Promise<DelegationStart> {
        this.member(from);
        return this.delegations.delegate(from, to, text, deadline === undefined ? {} : { deadline });
    }
    /**
     * Takes back a task the agent gave; a task already over stays as it ended.
     *
     * @throws UnknownDelegationError when the agent gave no such task.
     */
    cancelDelegation(from: string, delegationId: string): DelegationCancel {
        return this.delegations.cancel(from, delegationId);
    }
    cancel(agentId: string): Promise<void> {
        return this.member(agentId).running.cancel();
    }
    /** Restarts the agent; resolves once it is back, or rejects saying why it is not. */
    restart(agentId: string): Promise<void> {
        return this.member(agentId).running.restart();
    }
    answerPermission(agentId: string, requestId: string, optionId?: string): boolean {
        return this.member(agentId).running.answerPermission(requestId, optionId);
    }
    /** Starts the conversation of the agent anew: its next message goes without the old history. */
    clearContext(agentId: string): Promise<void> {
        return this.member(agentId).running.clearContext();
    }
    /**
     * An agent of the fleet, as an administrator, restarts an agent or clears
     * its context; refused when it is not an administrator.
     */
    administer(adminId: string, action: AdminAction, target: string): Promise<AdminOutcome> {
        return this.admin.request(adminId, action, target);
    }
    /**
     * A person allows or refuses an action of an administrator waiting for it.
     *
     * @returns Whether such an action was waiting.
     */
    answerAdminAction(actionId: string, allow: boolean): boolean {
        return this.admin.answer(actionId, allow);
    }
    /** The fleet as the administrators act on it. */
    private adminFleet(): AdminFleet {
        return {
            agents: () => this.agents(),
            restart: (agentId) => this.restart(agentId),
            clearContext: (agentId) => this.clearContext(agentId),
            note: (agentId, body) => {
                const member = this.members.get(agentId);
                if (member !== undefined) {
                    this.put(member, body);
                }
            },
            turnOver: (agentId) => this.turnOver(agentId)
        };
    }
    /**
     * A remote administrator asked through its inbox. It has no tool call to
     * answer, so a refusal or a failure comes to it as a message.
     */
    private async adminRequest(adminId: string, request: AdminRequest): Promise<void> {
        const outcome = await this.administer(adminId, request.action, request.target);
        const member = this.members.get(adminId);
        if (!outcome.ok && member !== undefined) {
            void this.hand(member, `[flotti] ${outcome.text}`, {});
        }
    }
    /** Resolves once the turn the agent is in is over; at once when it is in none, or is gone. */
    private turnOver(agentId: string): Promise<void> {
        const member = this.members.get(agentId);
        if (member === undefined || !member.inTurn) {
            return Promise.resolve();
        }
        return new Promise((resolve) => member.turnOver.push(resolve));
    }
    private member(agentId: string): Member {
        const member = this.members.get(agentId);
        if (member === undefined) {
            throw new UnknownAgentError(`There is no agent "${agentId}" in the fleet.`);
        }
        return member;
    }
    /**
     * Puts an agent to work in the fleet. A changed one goes on with the
     * history it had; any other reads what its directory kept from the runs
     * before, and a line says where that ends.
     */
    private join(agent: Agent, history: AgentEvent[], file?: HistoryFile): Member {
        const { offset, historyFile, restoredAny } = this.restoreHistory(agent, history, file);
        const member: Member = {
            agent,
            running: this.createAgent(agent),
            history,
            offset,
            file: historyFile,
            ...freshMember()
        };
        this.members.set(agent.id, member);
        if (restoredAny) {
            this.markRestored(member);
        }
        this.listen(member);
        return member;
    }
    /**
     * Hears every event of the member's agent and passes on the health of its
     * connection. The health is not kept in the history: only the latest one
     * matters, and the summary carries it.
     */
    private listen(member: Member): void {
        const agentId = member.agent.id;
        const events = member.running.subscribe((event) => this.hear(member, event));
        const health = member.running.onHealth?.((changed) => this.notify({ type: 'health', agentId, health: changed }));
        member.unsubscribe = () => {
            events();
            health?.();
        };
    }
    /**
     * Keeps one event of the member's agent, forwards what it says to another
     * agent — a message, or a task it gives — follows the tasks it works on, and
     * sends its answer to a message of another agent back to that one.
     */
    private hear(member: Member, event: AgentEvent): void {
        if (event.type === 'status') {
            this.noticeHarness(member);
        }
        this.followTurn(member, event);
        this.keep(member, event);
        this.pass(member, event);
        this.delegations.take(member.agent.id, event);
        const answer = member.answers.take(event);
        if (answer !== undefined) {
            this.forward(member, answer.to, answer.text, answer.replyTo);
        }
    }
    /** What the agent says to another one goes there: a message, a task, taking a task back. */
    private pass(member: Member, event: AgentEvent): void {
        const from = member.agent.id;
        if (event.type === 'cancel-delegation') {
            try {
                this.delegations.cancel(from, event.delegationId);
            } catch (error) {
                this.say(member, `could not take back task ${event.delegationId}: ${describeError(error)}`);
            }
        } else if (event.type === 'message' && event.role === 'agent' && event.to !== undefined) {
            if (event.delegation === undefined) {
                this.forward(member, event.to, event.text);
            } else {
                const { id, deadline } = event.delegation;
                void this.delegations.delegate(from, event.to, event.text, { id, tellFailure: true, ...(deadline === undefined ? {} : { deadline }) });
            }
        }
    }
    /**
     * Keeps track of whether the agent is in a turn; when the turn is over — or
     * the agent stopped, so no turn will end — what waited for that goes on.
     */
    private followTurn(member: Member, event: AgentEvent): void {
        if (event.type === 'message' && event.role === 'user') {
            member.inTurn = true;
            return;
        }
        const over = event.type === 'turn-end' || (event.type === 'status' && (event.status === 'stopped' || event.status === 'error'));
        if (over) {
            member.inTurn = false;
            // After the turn-end is kept: what waits restarts or clears the agent, and that comes after it in the tab.
            setImmediate(() => member.turnOver.splice(0).forEach((resolve) => resolve()));
        }
    }
    /**
     * Opens the history file of an agent that has none yet and, when the
     * given history is empty, fills it with what the file kept from before.
     */
    private restoreHistory(
        agent: Agent,
        history: AgentEvent[],
        file: HistoryFile | undefined
    ): { offset: number; historyFile: HistoryFile | undefined; restoredAny: boolean } {
        let offset = this.lastSeq.get(agent.id) ?? 0;
        let historyFile = file;
        let restoredAny = false;
        if (historyFile === undefined && this.persistHistory) {
            historyFile = new HistoryFile(agent.id, agent.directory, this.historyLimit, this.warn);
            const restored = historyFile.load();
            const last = restored.at(-1)?.seq ?? 0;
            if (history.length === 0 && restored.length > 0 && last > offset) {
                history.push(...restored);
                offset = last;
                restoredAny = true;
            }
        }
        return { offset, historyFile, restoredAny };
    }
    /**
     * The line that says where the restored history ends. The line of messages
     * lived in memory and is gone: what waited in it is said to be dropped, so
     * the tab does not show it waiting for ever.
     */
    private markRestored(member: Member): void {
        const lost = waitingInLine(member.history);
        this.afterRestore(member, { type: 'log', source: 'flotti', text: 'flotti was started again; everything above is from before.' });
        for (const { messageId } of lost) {
            this.afterRestore(member, { type: 'unqueued', messageId, outcome: 'dropped', reason: 'flotti restarted' });
        }
    }
    /** An event of flotti's own after the restored history, before anything the agent says. */
    private afterRestore(member: Member, body: AgentEventBody): void {
        this.keep(member, { ...body, agentId: member.agent.id, seq: 1, time: new Date().toISOString() } as AgentEvent);
        member.offset += 1;
    }
    /**
     * A remote agent tells its harness once connected to, which it says with a
     * status: the pages learn it with the fleet, and only when it changed.
     */
    private noticeHarness(member: Member): void {
        const harness = member.running.harness;
        if (harness === member.harness) {
            return;
        }
        member.harness = harness;
        if (this.members.get(member.agent.id) === member) {
            this.announce();
        }
    }
    private announce(): void {
        this.notify({ type: 'fleet', agents: this.agents() });
    }
    private keep(member: Member, received: AgentEvent): void {
        this.store(member, member.offset === 0 ? received : { ...received, seq: received.seq + member.offset });
    }
    /**
     * Puts a line of flotti's own into the tab of an agent, between its events:
     * it takes the next number, and the agent's events after it move one up.
     */
    private say(member: Member, text: string): void {
        this.put(member, { type: 'log', source: 'flotti', text });
    }
    /** Puts an event of flotti's own into the tab of an agent, the way {@link say} puts a line. */
    private put(member: Member, body: AgentEventBody): void {
        const agentId = member.agent.id;
        member.offset += 1;
        this.store(member, {
            ...body,
            agentId,
            seq: (this.lastSeq.get(agentId) ?? 0) + 1,
            time: new Date().toISOString()
        } as AgentEvent);
    }
    private store(member: Member, event: AgentEvent): void {
        this.lastSeq.set(event.agentId, event.seq);
        member.history.push(event);
        if (member.history.length > this.historyLimit) {
            member.history.splice(0, member.history.length - this.historyLimit);
        }
        member.file?.append(event, member.history);
        this.notify({ type: 'event', event });
    }
    private notify(notice: SupervisorNotice): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(notice);
            } catch {
                // One broken page must not break the others.
            }
        }
    }
    /**
     * Sends on what an agent said to another one — a message of its own, or,
     * with `replyTo`, its answer to a message of that one. The sender does not
     * wait for the receiver: a message that cannot be delivered is a line in
     * the tab of the sender, saying why.
     */
    private forward(sender: Member, to: string, text: string, replyTo?: Quote): void {
        const from = sender.agent.id;
        const receiver = this.members.get(to);
        const failed = (why: string): void => {
            // Still in the fleet: it may have been removed while the message went.
            if (this.members.get(from) === sender) {
                this.say(sender, `could not deliver the ${replyTo === undefined ? 'message' : 'answer'} to "${to}": ${why}`);
            }
        };
        if (receiver === undefined) {
            failed('there is no such agent in the fleet');
        } else if (receiver === sender) {
            failed('an agent does not send messages to itself');
        } else {
            void this.handOn(receiver, from, text, replyTo).then((error) => {
                if (error !== undefined) {
                    failed(error);
                }
            });
        }
    }
    /**
     * Hands a message of one agent to another and, once it is taken, tells the
     * fleet tools, so `reply` and `forward` of the receiver act on it. Resolves
     * with why it failed, or with nothing.
     */
    private async handOn(receiver: Member, from: string, text: string, replyTo: Quote | undefined): Promise<string | undefined> {
        const messageId = randomUUID();
        const delivery = await this.hand(receiver, text, replyTo === undefined ? { from, messageId } : { from, messageId, replyTo });
        if (delivery.result === 'failed') {
            return delivery.error ?? 'the agent did not take it';
        }
        this.delivered?.({ to: receiver.agent.id, from, messageId, text });
        return undefined;
    }
    /** Hands the message over; resolves once the agent took it or it failed, however long that takes. */
    private hand(member: Member, text: string, options: SendOptions): Promise<Delivery> {
        const agentId = member.agent.id;
        return member.running.send(text, options).then(
            (): Delivery => ({ agentId, result: 'taken' }),
            (error: unknown): Delivery => ({ agentId, result: 'failed', error: describeError(error) })
        );
    }
    /**
     * Hands the message over and answers within `queuedAfterMs`: an agent busy
     * with another message takes it only later, and the answer does not wait
     * for that — a `delivery` notice tells how it ended.
     */
    private deliver(member: Member, text: string, options: SendOptions = {}): Promise<Delivery> {
        const agentId = member.agent.id;
        const sent = this.hand(member, text, options);
        return new Promise((resolve) => {
            let answered = false;
            const timer = setTimeout(() => {
                answered = true;
                resolve({ agentId, result: 'queued' });
            }, this.queuedAfterMs);
            void sent.then((delivery) => {
                clearTimeout(timer);
                if (answered) {
                    this.notify({ type: 'delivery', delivery });
                } else {
                    resolve(delivery);
                }
            });
        });
    }
}
export { UnknownDelegationError } from './delegations.js';
export { Supervisor, UnknownAgentError };
export type { SupervisorListener, SupervisorNotice, SupervisorOptions };
