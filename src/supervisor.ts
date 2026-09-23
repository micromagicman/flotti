import { A2AAgent } from './a2a-agent.js';
import type { AgentEvent, FleetAgent } from './agent-events.js';
import { HistoryFile } from './agent-history.js';
import type { AgentSummary, Delivery, Harness } from './dashboard-protocol.js';
import type { FleetToolsAccess } from './fleet-mcp.js';
import { LocalAgentProcess } from './local-agent.js';
import type { Agent, Fleet } from './types.js';
/**
 * The harness of an agent, as far as its manifest tells: the adapter of a local
 * one. A plain ACP agent and a remote A2A one say nothing about it, and the
 * summary leaves the field out rather than guess.
 */
function harnessOf(agent: Agent): { readonly harness?: Harness } {
    if (agent.kind !== 'local') {
        return {};
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
     * absent. `flotti run` gives them, tests of fake fleets do not.
     */
    readonly fleetTools?: { access(agentId: string): FleetToolsAccess };
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
    unsubscribe: () => void;
};
/** An agent the request names that is not in the fleet. */
class UnknownAgentError extends Error {}
function defaultAgent(
    fleetTools: SupervisorOptions['fleetTools']
): (agent: Agent) => FleetAgent {
    return (agent) => agent.kind === 'local'
        ? new LocalAgentProcess(agent, fleetTools === undefined ? {} : { fleetTools: fleetTools.access(agent.id) })
        : new A2AAgent(agent);
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
    /** Last number given to an event of each id, kept when the agent goes: numbers of an id only grow. */
    private readonly lastSeq = new Map<string, number>();
    constructor(fleet: Fleet, options: SupervisorOptions = {}) {
        this.createAgent = options.createAgent ?? defaultAgent(options.fleetTools);
        this.historyLimit = options.historyLimit ?? 5000;
        this.queuedAfterMs = options.queuedAfterMs ?? 500;
        this.persistHistory = options.persistHistory ?? false;
        this.warn = options.warn ?? ((text) => console.error(text));
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
                ...harnessOf(agent),
                status: running.status
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
        for (const agent of fleet.agents) {
            this.join(agent, []);
        }
        this.announce();
        void this.start();
    }
    /**
     * Sends a message to one agent; says whether it was taken, waits in line, or failed.
     *
     * @param from Id of the agent of the fleet that sends it, when not a person:
     *     the fleet tools send so, and the `message` event of the receiver carries it.
     */
    send(agentId: string, text: string, from?: string): Promise<Delivery> {
        return this.deliver(this.member(agentId), text, from);
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
        const member: Member = {
            agent,
            running: this.createAgent(agent),
            history,
            offset,
            file: historyFile,
            unsubscribe: () => undefined
        };
        this.members.set(agent.id, member);
        if (restoredAny) {
            this.keep(member, {
                type: 'log',
                source: 'flotti',
                text: 'flotti was started again; everything above is from before.',
                agentId: agent.id,
                seq: 1,
                time: new Date().toISOString()
            });
            member.offset += 1;
        }
        member.unsubscribe = member.running.subscribe((event) => this.keep(member, event));
        return member;
    }
    private announce(): void {
        this.notify({ type: 'fleet', agents: this.agents() });
    }
    private keep(member: Member, received: AgentEvent): void {
        const event = member.offset === 0 ? received : { ...received, seq: received.seq + member.offset };
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
     * Hands the message over and answers within `queuedAfterMs`: an agent busy
     * with another message takes it only later, and the answer does not wait
     * for that — a `delivery` notice tells how it ended.
     */
    private deliver(member: Member, text: string, from?: string): Promise<Delivery> {
        const agentId = member.agent.id;
        const sent = member.running.send(text, from).then(
            (): Delivery => ({ agentId, result: 'taken' }),
            (error: unknown): Delivery => ({ agentId, result: 'failed', error: describeError(error) })
        );
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
export { Supervisor, UnknownAgentError };
export type { SupervisorListener, SupervisorNotice, SupervisorOptions };
