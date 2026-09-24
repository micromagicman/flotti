import { AgentEvents, WITHDRAWN, messageFields } from '../src/agent-events.js';
import type { AgentEventBody, AgentEventListener, AgentStatus, FleetAgent, SendOptions } from '../src/agent-events.js';
import type { Agent, Fleet, LocalAgent } from '../src/types.js';
/** A message held while the agent is busy. */
type Held = { readonly messageId: string; readonly resolve: () => void; readonly reject: (error: Error) => void };
/**
 * A fleet agent in memory, for the supervisor and the dashboard server: it
 * answers "you said: …" at once, or holds messages while `busy`, or refuses
 * them while `broken`; while `slow` it starts its turn and ends it only when
 * told to — `finish` — or cancelled. Protocols have their own tests; here only the
 * `FleetAgent` shape matters.
 */
class FakeFleetAgent implements FleetAgent {
    readonly calls: string[] = [];
    /** What came with each message, beyond its text. */
    readonly options: SendOptions[] = [];
    busy = false;
    broken = false;
    slow = false;
    /** What the agent says runs it, as a remote agent tells once connected to. */
    harness: string | undefined;
    private readonly events: AgentEvents;
    private current: AgentStatus = 'stopped';
    /** Messages held while `busy`, in line: each says it is `queued`, and may be withdrawn. */
    private held: Held[] = [];
    /** A turn of a `slow` agent that has not ended yet. */
    private open = false;
    private finished = 0;
    private permission: string | undefined;
    constructor(readonly agentId: string) {
        this.events = new AgentEvents(agentId);
    }
    get status(): AgentStatus {
        return this.current;
    }
    subscribe(listener: AgentEventListener): () => void {
        return this.events.subscribe(listener);
    }
    emit(body: AgentEventBody): void {
        if (body.type === 'status') {
            this.current = body.status;
        }
        this.events.emit(body);
    }
    async start(): Promise<void> {
        this.calls.push('start');
        this.emit({ type: 'status', status: this.broken ? 'error' : 'idle' });
        if (this.broken) {
            throw new Error('broken');
        }
    }
    async send(text: string, options: SendOptions = {}): Promise<void> {
        this.calls.push(options.from === undefined ? `send ${text}` : `send ${text} from ${options.from}`);
        this.options.push(options);
        if (this.broken) {
            throw new Error(`${this.agentId} is broken`);
        }
        const messageId = options.messageId ?? `u-${text}`;
        if (this.busy) {
            this.emit({ type: 'queued', messageId, text, ...messageFields(options) });
            await new Promise<void>((resolve, reject) => this.held.push({ messageId, resolve, reject }));
        }
        this.emit({ type: 'message', role: 'user', messageId, text, append: false, ...messageFields(options) });
        if (this.slow) {
            this.open = true;
            return;
        }
        this.emit({ type: 'message', role: 'agent', messageId: `a-${text}`, text: `you said: ${text}`, append: false });
        this.emit({ type: 'turn-end', reason: 'end_turn' });
    }
    /** Lets the held messages through. */
    release(): void {
        this.busy = false;
        for (const held of this.held.splice(0)) {
            held.resolve();
        }
    }
    withdraw(messageId: string): boolean {
        this.calls.push(`withdraw ${messageId}`);
        const index = this.held.findIndex((held) => held.messageId === messageId);
        const [held] = index === -1 ? [] : this.held.splice(index, 1);
        if (held === undefined) {
            return false;
        }
        this.emit({ type: 'unqueued', messageId, outcome: 'withdrawn' });
        held.reject(new Error(WITHDRAWN));
        return true;
    }
    /** Ends the open turn of a `slow` agent, saying `text` first. */
    finish(text: string, reason = 'end_turn'): void {
        this.open = false;
        if (text !== '') {
            this.emit({ type: 'message', role: 'agent', messageId: `f-${++this.finished}`, text, append: false });
        }
        this.emit({ type: 'turn-end', reason });
    }
    askPermission(requestId: string): void {
        this.permission = requestId;
        this.emit({ type: 'permission', requestId, title: 'Delete everything', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] });
    }
    async cancel(): Promise<void> {
        this.calls.push('cancel');
        if (this.open) {
            this.finish('', 'cancelled');
        }
    }
    answerPermission(requestId: string, optionId?: string): boolean {
        this.calls.push(`permission ${requestId} ${optionId ?? '-'}`);
        const waiting = this.permission === requestId;
        this.permission = undefined;
        return waiting;
    }
    async restart(): Promise<void> {
        this.calls.push('restart');
        this.emit({ type: 'status', status: 'starting', reason: 'restarting' });
        this.emit({ type: 'status', status: 'idle' });
    }
    async clearContext(): Promise<void> {
        this.calls.push('clear-context');
        if (this.broken) {
            throw new Error(`${this.agentId} is broken`);
        }
    }
    async stop(): Promise<void> {
        this.calls.push('stop');
        this.emit({ type: 'status', status: 'stopped' });
    }
}
function localAgent(id: string): LocalAgent {
    return {
        kind: 'local',
        id,
        name: id.toUpperCase(),
        directory: `/fleet/local/${id}`,
        manifestPath: `/fleet/local/${id}/agent.json`,
        command: 'fake',
        arguments: [],
        workdir: `/fleet/local/${id}`,
        env: {},
        restart: 'on-failure',
        heartbeatTimeoutSec: 60,
        skillsDirectory: `/fleet/local/${id}/skills`,
        memoryDirectory: `/fleet/local/${id}/memory`
    };
}
/** A fleet of fake agents with these ids, and the way to reach each fake. */
function fakeFleet(...ids: string[]): { fleet: Fleet; fakes: Map<string, FakeFleetAgent>; createAgent: (agent: Agent) => FleetAgent } {
    const fakes = new Map(ids.map((id) => [id, new FakeFleetAgent(id)]));
    const fleet: Fleet = { location: { path: '/fleet', source: 'argument' }, exists: true, agents: ids.map(localAgent) };
    const createAgent = (agent: Agent): FleetAgent => {
        const fake = fakes.get(agent.id);
        if (fake === undefined) {
            throw new Error(`no fake for ${agent.id}`);
        }
        return fake;
    };
    return { fleet, fakes, createAgent };
}
export { FakeFleetAgent, fakeFleet };
