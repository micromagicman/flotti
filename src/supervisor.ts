import { randomUUID } from 'node:crypto';
import { A2AAgent } from './a2a-agent.js';
import type { AdminRequest } from './a2a-agent.js';
import { AgentAnswers } from './agent-answers.js';
import type { Answer } from './agent-answers.js';
import { waitingInLine } from './agent-events.js';
import { AnswerDeliveryRule, DEFAULT_ANSWER_DELIVERY } from './answer-delivery.js';
import type { AnswerDelivery } from './answer-delivery.js';
import type { AdminAction, AgentEvent, AgentEventBody, FleetAgent, Quote, SendOptions } from './agent-events.js';
import { HistoryFile, agentEvents } from './agent-history.js';
import type { ConnectionHealth } from './connection-health.js';
import { Delegations } from './delegations.js';
import type { DelegationCancel, DelegationFleet, DelegationStart } from './delegations.js';
import type { AgentSummary, Delivery, GroupMessage, GroupSummary, Harness, MemoryStatus } from './dashboard-protocol.js';
import { FleetAdmin } from './fleet-admin.js';
import type { AdminFleet, AdminOutcome } from './fleet-admin.js';
import type { DeliveredMessage, FleetToolsAccess } from './fleet-mcp.js';
import { GroupHistory } from './group-history.js';
import { canReach, groupView, groupsOf, sharedGroups } from './groups.js';
import type { GroupView, PeerSummary } from './groups.js';
import { LocalAgentProcess } from './local-agent.js';
import { present } from './present.js';
import type { Agent, Fleet, Group, LocalAgent, LocalAgentAdapter } from './types.js';
/** The harness each ACP adapter runs. */
const ADAPTER_HARNESS: Readonly<Record<LocalAgentAdapter, Harness>> = {
    'claude-code': 'claude',
    codex: 'codex'
};
/** Statuses after which no turn of the agent will end. */
const STOPPED_STATUSES: ReadonlySet<string> = new Set([ 'stopped', 'error' ]);
/**
 * The harness of an agent: the adapter of a local one, as its manifest tells,
 * and what a remote one says of itself once connected to. A plain ACP agent
 * and a remote one that says nothing get no harness: the summary leaves the
 * field out rather than guess.
 */
function harnessOf(agent: Agent, running: FleetAgent): { readonly harness?: Harness } {
    return present('harness', agent.kind === 'local' ? adapterHarness(agent.adapter) : running.harness);
}
function adapterHarness(adapter: LocalAgentAdapter | undefined): Harness | undefined {
    return adapter === undefined ? undefined : ADAPTER_HARNESS[adapter];
}
/**
 * The memory of an agent as the dashboard shows it: what the running agent
 * delivered, and for a remote agent that flotti gives it none (#94).
 */
function memoryOf(agent: Agent, running: FleetAgent): MemoryStatus | undefined {
    if (running.memory !== undefined) {
        return running.memory;
    }
    return agent.kind === 'remote'
        ? { state: 'unsupported', reason: 'a remote agent keeps its own memory: flotti gives it none yet' }
        : undefined;
}
/** The memory a running agent delivered, as a value to compare. */
function memoryKey(running: FleetAgent): string {
    return JSON.stringify(running.memory ?? null);
}
/** The history of an agent that joins: where its numbers go on from, and its file. */
type RestoredHistory = { offset: number; historyFile: HistoryFile<AgentEvent> | undefined; restoredAny: boolean };
/** What the supervisor says besides the agents' own events. */
type SupervisorNotice =
    | { readonly type: 'event'; readonly event: AgentEvent }
    | { readonly type: 'delivery'; readonly delivery: Delivery }
    /** The health of the connection of an agent changed. */
    | { readonly type: 'health'; readonly agentId: string; readonly health: ConnectionHealth }
    /** An agent was added, changed or removed, or the whole fleet was replaced. */
    | { readonly type: 'fleet'; readonly agents: readonly AgentSummary[]; readonly groups: readonly GroupSummary[] }
    /** A message was posted to a group (docs/groups.md): one line of its history, with how each member took it. */
    | { readonly type: 'group-message'; readonly message: GroupMessage };
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
    /**
     * How the answers of the agents reach the tabs (#157): piece by piece, or
     * whole once complete. Asked when a message starts, so a change holds for
     * the next one; `streamed` when absent.
     */
    readonly answerDelivery?: () => AnswerDelivery;
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
    readonly file: HistoryFile<AgentEvent> | undefined;
    /** What the agent answers to a message of another agent, to send back to it. */
    readonly answers: AgentAnswers;
    unsubscribe: () => void;
    /** The harness the pages were last told the agent has: a change is announced. */
    harness: string | undefined;
    /** The memory status the pages were last told, as JSON: a change is announced. */
    memory: string | undefined;
    /** Whether the agent is in a turn: between a message it took and the end of its answer. */
    inTurn: boolean;
    /** Called once the turn is over: actions an administrator asked for on itself in the turn. */
    turnOver: (() => void)[];
};
/** What a member starts with besides its agent and its history. */
function freshMember(): Pick<Member, 'answers' | 'unsubscribe' | 'harness' | 'memory' | 'inTurn' | 'turnOver'> {
    return { answers: new AgentAnswers(), unsubscribe: () => undefined, harness: undefined, memory: undefined, inTurn: false, turnOver: [] };
}
/** An agent the request names that is not in the fleet. */
class UnknownAgentError extends Error {}
/** A group the request names that is not in the fleet. */
class UnknownGroupError extends Error {}
function groupsById(groups: readonly Group[]): Map<string, Group> {
    return new Map(groups.map((group: Group) => [group.id, group]));
}
/** Groups by id, the order of the fleet directory. */
function groupOrder(left: Group, right: Group): number {
    return left.id < right.id ? -1 : 1;
}
/** A group as the page lists it. */
function groupSummary(group: Group): GroupSummary {
    return { id: group.id, name: group.name, ...present('topic', group.topic), members: group.members };
}
/** The fleet as one remote agent is told of it (docs/a2a-fleet.md): its peers and its groups. */
type FleetView = { readonly roster: () => PeerSummary[]; readonly groups: () => GroupView[] };
/**
 * How an agent of the fleet runs: a local process, or a remote agent whose
 * requests as an administrator go to `onAdminRequest`.
 */
function defaultAgent(
    fleetTools: SupervisorOptions['fleetTools'],
    onAdminRequest: (agentId: string, request: AdminRequest) => void,
    fleetOf: (agentId: string) => FleetView
): (agent: Agent) => FleetAgent {
    return (agent) => agent.kind === 'local'
        ? new LocalAgentProcess(agent, fleetTools === undefined ? {} : { fleetTools: fleetTools.access(agent.id) })
        : new A2AAgent(agent, { onAdminRequest: (request) => onAdminRequest(agent.id, request), fleet: fleetOf(agent.id) });
}
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
/** Local agents first, then remote ones, each group by id — the order of the fleet directory. */
function fleetOrder(left: Agent, right: Agent): number {
    if (left.kind !== right.kind) {
        return left.kind === 'local' ? -1 : 1;
    }
    return compareIds(left.id, right.id);
}
function compareIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
/** A local agent on this machine with an adapter: the memory tools have a bank for it (#101). */
function hasMemoryBank(agent: Agent): agent is LocalAgent {
    return agent.kind === 'local' && agent.ssh === undefined && agent.adapter !== undefined;
}
/** The rule of the answer delivery (#157) over the choice given; `streamed` for every message when none is. */
function answerRule(options: SupervisorOptions): AnswerDeliveryRule {
    return new AnswerDeliveryRule(options.answerDelivery ?? (() => DEFAULT_ANSWER_DELIVERY));
}
/** How much history is kept, and whether it outlives flotti. */
function historyTuning(options: SupervisorOptions): { readonly limit: number; readonly persist: boolean } {
    return { limit: options.historyLimit ?? 5000, persist: options.persistHistory ?? false };
}
/** How long a delivery waits before it says queued, and where warnings go. */
function deliveryTuning(options: SupervisorOptions): { readonly queuedAfterMs: number; readonly warn: (text: string) => void } {
    return { queuedAfterMs: options.queuedAfterMs ?? 500, warn: options.warn ?? ((text) => console.error(text)) };
}
function deliveredOf(fleetTools: SupervisorOptions['fleetTools']): ((message: DeliveredMessage) => void) | undefined {
    return fleetTools?.delivered?.bind(fleetTools);
}
function adminOptions(confirm: SupervisorOptions['confirmAdminActions']): ConstructorParameters<typeof FleetAdmin>[1] {
    return present('confirm', confirm);
}
/** The events of the file that go into an empty history: newer than anything numbered since flotti started. */
function restorable(restored: AgentEvent[], history: readonly AgentEvent[], offset: number): AgentEvent[] {
    return history.length === 0 && restored.length > 0 && lastSeqOf(restored) > offset ? restored : [];
}
function lastSeqOf(events: readonly AgentEvent[]): number {
    return events.at(-1)?.seq ?? 0;
}
/** A message of an agent meant for another agent. */
function isAgentMessage(event: AgentEvent): event is AgentEvent & { type: 'message'; to: string } {
    return event.type === 'message' && event.role === 'agent' && event.to !== undefined;
}
/** A message of an agent posted to a group. */
function isGroupMessage(event: AgentEvent): event is AgentEvent & { type: 'message'; group: string } {
    return event.type === 'message' && event.role === 'agent' && event.group !== undefined;
}
/** A message to a group: who posts it, when it is an agent, and what it answers or sends on. */
type GroupSendOptions = Pick<SendOptions, 'from' | 'replyTo' | 'forwarded' | 'turnAnswer'>;
/** A member the message did not reach: it is not in the fleet, or it did not take it. */
function failed(agentId: string, error: string): Delivery {
    return { agentId, result: 'failed', error };
}
/** After this event, no turn of the agent is going on. */
function endsTurn(event: AgentEvent): boolean {
    return event.type === 'turn-end' || (event.type === 'status' && STOPPED_STATUSES.has(event.status));
}
function turnAnswerMark(turnAnswer: boolean): { turnAnswer?: true } {
    return turnAnswer ? { turnAnswer: true } : {};
}
/** The ids of the groups the agent shares with another one; with itself, the groups it is in. */
function groupsShared(groups: readonly Group[], agentId: string, other: string): string[] {
    return agentId === other ? groupsOf(groups, agentId).map((group) => group.id) : sharedGroups(groups, agentId, other);
}
/** The real reason a message was refused, as the tab of the sender says it to a person (docs/groups.md). */
function notInAGroup(from: string, to: string): string {
    return `"${to}" is not in a group with "${from}"`;
}
/** The real reason a message to a group was refused, as the tab of the sender says it to a person. */
function notInGroup(from: string, groupId: string): string {
    return `"${from}" is not in group "${groupId}"`;
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
    /** The one place the rule of #157 is applied: on the way of every event to the history and the pages. */
    private readonly delivery: AnswerDeliveryRule;
    /** The groups of the fleet (docs/groups.md), by id. */
    private groupList = new Map<string, Group>();
    /** The messages of each group, by id; opened when a group is first written to or read. */
    private readonly groupHistories = new Map<string, GroupHistory>();
    /** Last number given to a message of each group, kept when the group goes: numbers of a group only grow. */
    private readonly lastGroupSeq = new Map<string, number>();
    /**
     * The message being posted to each group, by id: the next one waits for
     * it, so the lines of a group are in the order the messages were sent —
     * an answer to a message never stands above it.
     */
    private readonly posting = new Map<string, Promise<unknown>>();
    constructor(fleet: Fleet, options: SupervisorOptions = {}) {
        this.createAgent = options.createAgent
            ?? defaultAgent(options.fleetTools, (agentId, request) => void this.adminRequest(agentId, request), (agentId) => this.fleetView(agentId));
        this.admin = new FleetAdmin(this.adminFleet(), adminOptions(options.confirmAdminActions));
        this.delivery = answerRule(options);
        const history = historyTuning(options);
        this.historyLimit = history.limit;
        this.persistHistory = history.persist;
        const delivery = deliveryTuning(options);
        this.queuedAfterMs = delivery.queuedAfterMs;
        this.warn = delivery.warn;
        this.delivered = deliveredOf(options.fleetTools);
        this.delegations = new Delegations(this.delegationFleet(), this.queuedAfterMs);
        for (const agent of fleet.agents) {
            this.join(agent, []);
        }
        this.groupList = groupsById(fleet.groups);
    }
    /** The agents in fleet order: local first, then remote, each by id. */
    agents(): AgentSummary[] {
        return [...this.members.values()]
            .sort((left, right) => fleetOrder(left.agent, right.agent))
            .map(({ agent, running }) => {
                const memory = memoryOf(agent, running);
                return {
                    id: agent.id,
                    name: agent.name,
                    kind: agent.kind,
                    ...present('description', agent.description),
                    ...harnessOf(agent, running),
                    status: running.status,
                    ...present('health', running.health),
                    ...(agent.admin === true ? { admin: true as const } : {}),
                    ...present('memory', memory)
                };
            });
    }
    /**
     * The memory bank the memory tools work on for this agent (#101): a local
     * agent on this machine with an adapter has one; any other has none.
     */
    memoryBank(agentId: string): string | undefined {
        const agent = this.members.get(agentId)?.agent;
        return agent !== undefined && hasMemoryBank(agent) ? agent.memoryDirectory : undefined;
    }
    /** The agent as its manifest describes it. */
    agent(agentId: string): Agent {
        return this.member(agentId).agent;
    }
    /** The groups of the fleet, by id. */
    groups(): GroupSummary[] {
        return this.groupsInOrder().map(groupSummary);
    }
    /**
     * The agents this one sees (docs/groups.md): the members of every group it
     * is in — with the ids of the groups the two share — and itself; none at
     * all when it is in no group with anyone, so that it does not take the
     * fleet for empty by mistake.
     */
    peers(agentId: string): PeerSummary[] {
        if (!this.hasPeers(agentId)) {
            return [];
        }
        const groups = this.groupsInOrder();
        return this.agents().flatMap((agent) => {
            const shared = groupsShared(groups, agentId, agent.id);
            return shared.length === 0 ? [] : [{ ...agent, groups: shared }];
        });
    }
    /** The groups the agent is in, as it sees them: the members by id and name. */
    groupsOf(agentId: string): GroupView[] {
        return groupsOf(this.groupsInOrder(), agentId).map((group) => groupView(group, (id) => this.members.get(id)?.agent.name));
    }
    /** Whether `from` may write to `to`: the two share a group (docs/groups.md). */
    canReach(from: string, to: string): boolean {
        return canReach(this.groupsInOrder(), from, to);
    }
    /**
     * Whether `from` may write to `to`; when it may not because of the groups,
     * the tab of `from` says so, for a person to read — the agent itself is
     * told only that there is no such agent among those it can write to.
     */
    mayWrite(from: string, to: string): boolean {
        if (this.canReach(from, to)) {
            return true;
        }
        const sender = this.members.get(from);
        if (sender !== undefined && this.members.has(to)) {
            this.say(sender, notInAGroup(from, to));
        }
        return false;
    }
    /**
     * Whether `from` may post to the group: it is a member. When it may not,
     * the tab of `from` says the real reason, for a person to read — the agent
     * itself is told only that there is no such group among its own.
     */
    mayPost(from: string, groupId: string): boolean {
        const why = this.postRefusal(from, groupId);
        if (why !== undefined && this.groupList.has(groupId)) {
            this.tell(from, why);
        }
        return why === undefined;
    }
    /** Why the agent cannot post to the group at all; nothing when it can. */
    private postRefusal(from: string, groupId: string): string | undefined {
        const group = this.groupList.get(groupId);
        if (group === undefined) {
            return 'there is no such group in the fleet';
        }
        return group.members.includes(from) ? undefined : notInGroup(from, groupId);
    }
    /** A line of flotti's own in the tab of the agent, when it is in the fleet. */
    private tell(agentId: string, text: string): void {
        const member = this.members.get(agentId);
        if (member !== undefined) {
            this.say(member, text);
        }
    }
    /**
     * The messages of the group that came after `afterSeq`, oldest first.
     *
     * @throws UnknownGroupError when there is no such group.
     */
    groupHistory(groupId: string, afterSeq = 0): GroupMessage[] {
        return this.historyOf(this.group(groupId)).since(afterSeq);
    }
    /**
     * Posts a message to a group (docs/groups.md): to every member but the
     * one who posts it, each on its own, as a broadcast goes — a member that
     * is down or busy holds nobody up, and one not in the fleet fails — and
     * into the history of the group, with how each member took it. A person
     * posts with no `from`; an agent that posts is checked at the door it came
     * through, not here. Resolves with the message as the history keeps it,
     * within the time a message may take to reach an agent.
     *
     * @throws UnknownGroupError when there is no such group.
     */
    async sendToGroup(groupId: string, text: string, options: GroupSendOptions = {}): Promise<GroupMessage> {
        const group = this.group(groupId);
        const posted = (this.posting.get(groupId) ?? Promise.resolve()).then(() => this.postToGroup(group, text, options));
        this.posting.set(groupId, posted.catch(() => undefined));
        return posted;
    }
    /** Hands the message to every other member and writes it down with how each took it. */
    private async postToGroup(group: Group, text: string, options: GroupSendOptions): Promise<GroupMessage> {
        const receivers = group.members.filter((id) => id !== options.from);
        const deliveries = await Promise.all(receivers.map((id) => this.deliverToMember(id, text, { ...options, group: group.id })));
        return this.post(group, text, options, deliveries);
    }
    /** Whether the agent is in a group with anyone of the fleet. */
    private hasPeers(agentId: string): boolean {
        return this.agents().some((agent) => canReach(this.groupsInOrder(), agentId, agent.id));
    }
    private groupsInOrder(): Group[] {
        return [...this.groupList.values()].sort(groupOrder);
    }
    /** The fleet as a remote agent is told of it. */
    private fleetView(agentId: string): FleetView {
        return { roster: () => this.peers(agentId), groups: () => this.groupsOf(agentId) };
    }
    /**
     * The group as its file describes it.
     *
     * @throws UnknownGroupError when there is no such group.
     */
    group(groupId: string): Group {
        const group = this.groupList.get(groupId);
        if (group === undefined) {
            throw new UnknownGroupError(`There is no group "${groupId}" in the fleet.`);
        }
        return group;
    }
    /** Takes a new group into the fleet; the pages and the agents learn it with the fleet. */
    addGroup(group: Group): void {
        if (this.groupList.has(group.id)) {
            throw new Error(`There is a group "${group.id}" in the fleet already.`);
        }
        this.groupList.set(group.id, group);
        this.announce();
    }
    /** Puts a changed group file to work. */
    replaceGroup(group: Group): void {
        this.group(group.id);
        this.groupList.set(group.id, group);
        this.announce();
    }
    /** Lets the group go: it is no longer in the fleet; the numbers of its messages are kept in case it is made again. */
    removeGroup(groupId: string): void {
        this.group(groupId);
        this.groupList.delete(groupId);
        this.forgetHistory(groupId);
        this.announce();
    }
    /** The history of the group, opened on first use: from its file when the run keeps histories. */
    private historyOf(group: Group): GroupHistory {
        const known = this.groupHistories.get(group.id);
        if (known !== undefined) {
            return known;
        }
        const directory = this.persistHistory ? group.directory : undefined;
        const history = new GroupHistory(group.id, directory, this.historyLimit, this.warn, this.lastGroupSeq.get(group.id) ?? 0);
        this.groupHistories.set(group.id, history);
        return history;
    }
    /** Closes the book on the history of a group that goes: where its numbers got to is kept. */
    private forgetHistory(groupId: string): void {
        const history = this.groupHistories.get(groupId);
        if (history !== undefined) {
            this.lastGroupSeq.set(groupId, history.last);
            this.groupHistories.delete(groupId);
        }
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
        for (const groupId of [...this.groupHistories.keys()]) {
            this.forgetHistory(groupId);
        }
        this.groupList = groupsById(fleet.groups);
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
            },
            mayWrite: (from, to) => this.mayWrite(from, to)
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
            mayWrite: (from, to) => this.mayWrite(from, to),
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
    private join(agent: Agent, history: AgentEvent[], file?: HistoryFile<AgentEvent>): Member {
        const { offset, historyFile, restoredAny } = this.restoreHistory(agent, history, file);
        const member: Member = {
            agent,
            running: this.createAgent(agent),
            history,
            offset,
            file: historyFile,
            ...freshMember()
        };
        member.memory = JSON.stringify(member.running.memory ?? null);
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
            this.rosterChanged();
        }
        this.followTurn(member, event);
        this.keep(member, event);
        this.pass(member, event);
        this.delegations.take(member.agent.id, event);
        const answer = member.answers.take(event);
        if (answer !== undefined) {
            this.sendBack(member, answer);
        }
    }
    /**
     * The answer of a turn goes back where the message came from: to the
     * group it was posted to, or to the agent that sent it. It goes even when
     * the answering agent is no longer in the group, or in a group with the
     * sender: the exchange was allowed on its way in (docs/groups.md).
     */
    private sendBack(member: Member, answer: Answer): void {
        if (answer.group !== undefined) {
            this.answerGroup(member, answer.group, answer.text, answer.replyTo);
        } else if (answer.to !== undefined) {
            this.forward(member, answer.to, answer.text, answer.replyTo, true);
        }
    }
    /** The answer of a turn posted back to the group as a message of the agent, marked so; a group that is gone is a line in its tab. */
    private answerGroup(member: Member, groupId: string, text: string, replyTo: Quote): void {
        if (!this.groupList.has(groupId)) {
            this.say(member, `could not post the answer to group "${groupId}": there is no such group in the fleet`);
            return;
        }
        void this.sendToGroup(groupId, text, { from: member.agent.id, replyTo, turnAnswer: true });
    }
    /** What the agent says to another one goes there: a message, a task, taking a task back; what it says to a group is posted there. */
    private pass(member: Member, event: AgentEvent): void {
        if (event.type === 'cancel-delegation') {
            this.takeBack(member, event.delegationId);
        } else if (isAgentMessage(event)) {
            this.sendOn(member, event);
        } else if (isGroupMessage(event)) {
            this.postOn(member, event);
        }
    }
    /**
     * A message of the agent to a group: posted to it when the agent is a
     * member; a line in the tab of the agent otherwise, saying why, as for a
     * message to an agent it cannot write to.
     */
    private postOn(member: Member, event: AgentEvent & { type: 'message'; group: string }): void {
        const why = this.postRefusal(member.agent.id, event.group);
        if (why === undefined) {
            void this.sendToGroup(event.group, event.text, { from: member.agent.id });
        } else {
            this.say(member, `could not post the message to group "${event.group}": ${why}`);
        }
    }
    /** The agent takes back a task it gave. */
    private takeBack(member: Member, delegationId: string): void {
        try {
            this.delegations.cancel(member.agent.id, delegationId);
        } catch (error) {
            this.say(member, `could not take back task ${delegationId}: ${describeError(error)}`);
        }
    }
    /** A message of the agent to another one: passed on, or given as a task. */
    private sendOn(member: Member, event: AgentEvent & { type: 'message'; to: string }): void {
        if (event.delegation === undefined) {
            this.forward(member, event.to, event.text);
            return;
        }
        const { id, deadline } = event.delegation;
        void this.delegations.delegate(member.agent.id, event.to, event.text, { id, tellFailure: true, ...present('deadline', deadline) });
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
        if (endsTurn(event)) {
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
        file: HistoryFile<AgentEvent> | undefined
    ): RestoredHistory {
        const offset = this.lastSeq.get(agent.id) ?? 0;
        if (file !== undefined || !this.persistHistory) {
            return { offset, historyFile: file, restoredAny: false };
        }
        return this.openHistory(agent, history, offset);
    }
    /** Opens the history file of the agent and puts what it kept into an empty history. */
    private openHistory(agent: Agent, history: AgentEvent[], offset: number): RestoredHistory {
        const historyFile = new HistoryFile(`agent "${agent.id}"`, agent.directory, this.historyLimit, this.warn, agentEvents(agent.id));
        const restored = restorable(historyFile.load(), history, offset);
        history.push(...restored);
        return { offset: restored.length === 0 ? offset : lastSeqOf(restored), historyFile, restoredAny: restored.length > 0 };
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
     * A remote agent tells its harness once connected to, and a local one what
     * memory it was given once started, which each says with a status: the
     * pages learn it with the fleet, and only when it changed.
     */
    private noticeHarness(member: Member): void {
        const harness = member.running.harness;
        const memory = memoryKey(member.running);
        if (harness === member.harness && memory === member.memory) {
            return;
        }
        member.harness = harness;
        member.memory = memory;
        if (this.members.get(member.agent.id) === member) {
            this.announce();
        }
    }
    private announce(): void {
        this.notify({ type: 'fleet', agents: this.agents(), groups: this.groups() });
        this.rosterChanged();
    }
    /** The agents that are told who is in the fleet learn it changed (docs/a2a-fleet.md). */
    private rosterChanged(): void {
        for (const { running } of this.members.values()) {
            running.fleetChanged?.();
        }
    }
    /**
     * Keeps an event for the tab, through the rule of the answer delivery: a
     * piece of an answer held back is not kept yet, and the whole answer, once
     * complete, is kept as a line of flotti's own before the event that
     * completed it — it takes the next number, as {@link put} numbers.
     */
    private keep(member: Member, received: AgentEvent): void {
        const { released, kept } = this.delivery.take(member, received, member.inTurn);
        if (released !== undefined) {
            this.put(member, released);
        }
        if (kept) {
            this.store(member, member.offset === 0 ? received : { ...received, seq: received.seq + member.offset });
        }
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
     * with `replyTo`, its answer to a message of that one. `turnAnswer` marks
     * the answer flotti sends back at the end of a turn: the receiver owes none
     * to it, and it goes back even when the two no longer share a group — the
     * exchange was allowed on its way in (docs/groups.md); a message of the
     * agent's own is checked at this door. The sender does not wait for the
     * receiver: a message that cannot be delivered is a line in the tab of the
     * sender, saying why.
     */
    private forward(sender: Member, to: string, text: string, replyTo?: Quote, turnAnswer = false): void {
        const receiver = this.members.get(to);
        if (receiver === undefined) {
            this.undelivered(sender, to, replyTo, 'there is no such agent in the fleet');
            return;
        }
        const refusal = this.forwardRefusal(sender, receiver, turnAnswer);
        if (refusal !== undefined) {
            this.undelivered(sender, to, replyTo, refusal);
            return;
        }
        void this.handOn(receiver, sender.agent.id, text, replyTo, turnAnswer).then((error) => {
            if (error !== undefined) {
                this.undelivered(sender, to, replyTo, error);
            }
        });
    }
    /** A message that did not reach the receiver is a line in the tab of the sender, saying why. */
    private undelivered(sender: Member, to: string, replyTo: Quote | undefined, why: string): void {
        // Still in the fleet: it may have been removed while the message went.
        if (this.members.get(sender.agent.id) === sender) {
            this.say(sender, `could not deliver the ${replyTo === undefined ? 'message' : 'answer'} to "${to}": ${why}`);
        }
    }
    /** Why the message cannot be sent on to the receiver at all; nothing when it can. */
    private forwardRefusal(sender: Member, receiver: Member, turnAnswer: boolean): string | undefined {
        if (receiver === sender) {
            return 'an agent does not send messages to itself';
        }
        return turnAnswer || this.canReach(sender.agent.id, receiver.agent.id) ? undefined : notInAGroup(sender.agent.id, receiver.agent.id);
    }
    /**
     * Hands a message of one agent to another and, once it is taken, tells the
     * fleet tools, so `reply` and `forward` of the receiver act on it. Resolves
     * with why it failed, or with nothing.
     */
    private async handOn(receiver: Member, from: string, text: string, replyTo: Quote | undefined, turnAnswer: boolean): Promise<string | undefined> {
        const messageId = randomUUID();
        const delivery = await this.hand(receiver, text, {
            from,
            messageId,
            ...present('replyTo', replyTo),
            ...turnAnswerMark(turnAnswer)
        });
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
        return this.answerWithin(member.agent.id, this.hand(member, text, options));
    }
    /**
     * Hands a message posted to a group to one member, under a `messageId` of
     * its own tab, and answers within `queuedAfterMs` as {@link deliver} does.
     * Once an agent's message is taken, the fleet tools are told, so `reply`
     * of the member answers the group. A member not in the fleet fails at once.
     */
    private deliverToMember(agentId: string, text: string, options: SendOptions & { group: string }): Promise<Delivery> {
        const member = this.members.get(agentId);
        if (member === undefined) {
            return Promise.resolve(failed(agentId, 'not in the fleet'));
        }
        const messageId = randomUUID();
        const sent = this.hand(member, text, { ...options, messageId });
        void sent.then((delivery) => this.tellTaken(delivery, agentId, messageId, text, options));
        return this.answerWithin(agentId, sent);
    }
    /** Tells the fleet tools of a message of an agent that a member took: its `reply` and `forward` act on it. */
    private tellTaken(delivery: Delivery, to: string, messageId: string, text: string, options: SendOptions & { group: string }): void {
        if (delivery.result === 'taken' && options.from !== undefined) {
            this.delivered?.({ to, from: options.from, messageId, text, group: options.group, ...present('forwarded', options.forwarded) });
        }
    }
    /** Writes the message down as the line of the group and tells the pages. */
    private post(group: Group, text: string, options: GroupSendOptions, deliveries: readonly Delivery[]): GroupMessage {
        const message = this.historyOf(group).add({
            messageId: randomUUID(),
            ...present('from', options.from),
            text,
            ...present('replyTo', options.replyTo),
            ...present('forwarded', options.forwarded),
            ...turnAnswerMark(options.turnAnswer === true),
            deliveries
        });
        this.notify({ type: 'group-message', message });
        return message;
    }
    /** The delivery as it ends, or `queued` after `queuedAfterMs`: a `delivery` notice then tells how it ended. */
    private answerWithin(agentId: string, sent: Promise<Delivery>): Promise<Delivery> {
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
export { Supervisor, UnknownAgentError, UnknownGroupError };
export type { GroupSendOptions, SupervisorListener, SupervisorNotice, SupervisorOptions };
