import { A2AAgent } from './a2a-agent.js';
import type { AgentEvent, FleetAgent } from './agent-events.js';
import type { AgentSummary, Delivery } from './dashboard-protocol.js';
import { LocalAgentProcess } from './local-agent.js';
import type { Agent, Fleet } from './types.js';
/** What the supervisor says besides the agents' own events. */
type SupervisorNotice =
    | { readonly type: 'event'; readonly event: AgentEvent }
    | { readonly type: 'delivery'; readonly delivery: Delivery };
type SupervisorListener = (notice: SupervisorNotice) => void;
type SupervisorOptions = {
    /** How an agent of the fleet becomes a running one; tests put their own in. */
    readonly createAgent?: (agent: Agent) => FleetAgent;
    /** Events kept per agent for a page that connects later or reconnects. */
    readonly historyLimit?: number;
    /** How long a message may take to reach the agent before it counts as queued. */
    readonly queuedAfterMs?: number;
};
/** One agent of the fleet with what the dashboard needs of it. */
type Member = {
    readonly agent: Agent;
    readonly running: FleetAgent;
    readonly history: AgentEvent[];
};
/** An agent the request names that is not in the fleet. */
class UnknownAgentError extends Error {}
function defaultAgent(agent: Agent): FleetAgent {
    return agent.kind === 'local' ? new LocalAgentProcess(agent) : new A2AAgent(agent);
}
function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
/**
 * The fleet at work: every agent started, its events numbered and kept, so a
 * page that connects later — or loses its connection for a while — gets what
 * it missed. It is the one source of truth; pages only subscribe to it.
 */
class Supervisor {
    private readonly members = new Map<string, Member>();
    private readonly listeners = new Set<SupervisorListener>();
    private readonly historyLimit: number;
    private readonly queuedAfterMs: number;
    private readonly unsubscribe: (() => void)[] = [];
    constructor(fleet: Fleet, options: SupervisorOptions = {}) {
        const createAgent = options.createAgent ?? defaultAgent;
        this.historyLimit = options.historyLimit ?? 5000;
        this.queuedAfterMs = options.queuedAfterMs ?? 500;
        for (const agent of fleet.agents) {
            const member: Member = { agent, running: createAgent(agent), history: [] };
            this.members.set(agent.id, member);
            this.unsubscribe.push(member.running.subscribe((event) => this.keep(member, event)));
        }
    }
    /** The agents in fleet order: local first, then remote, each by id. */
    agents(): AgentSummary[] {
        return [...this.members.values()].map(({ agent, running }) => ({
            id: agent.id,
            name: agent.name,
            kind: agent.kind,
            ...(agent.description === undefined ? {} : { description: agent.description }),
            status: running.status
        }));
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
        await Promise.all([...this.members.values()].map(({ running }) => running.stop().catch(() => undefined)));
        for (const stop of this.unsubscribe.splice(0)) {
            stop();
        }
    }
    /** Sends a message to one agent; says whether it was taken, waits in line, or failed. */
    send(agentId: string, text: string): Promise<Delivery> {
        return this.deliver(this.member(agentId), text);
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
    private keep(member: Member, event: AgentEvent): void {
        member.history.push(event);
        if (member.history.length > this.historyLimit) {
            member.history.splice(0, member.history.length - this.historyLimit);
        }
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
    private deliver(member: Member, text: string): Promise<Delivery> {
        const agentId = member.agent.id;
        const sent = member.running.send(text).then(
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
