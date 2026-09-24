import { AgentEvents, messageFields } from '../src/agent-events.js';
import type { AgentEventBody, AgentEventListener, AgentStatus, FleetAgent, SendOptions } from '../src/agent-events.js';
import type { Agent, Fleet, LocalAgent } from '../src/types.js';
/**
 * A fleet agent in memory, for the supervisor and the dashboard server: it
 * answers "you said: …" at once, or holds messages while `busy`, or refuses
 * them while `broken`. Protocols have their own tests; here only the
 * `FleetAgent` shape matters.
 */
class FakeFleetAgent implements FleetAgent {
    readonly calls: string[] = [];
    /** What came with each message, beyond its text. */
    readonly options: SendOptions[] = [];
    busy = false;
    broken = false;
    /** What the agent says runs it, as a remote agent tells once connected to. */
    harness: string | undefined;
    private readonly events: AgentEvents;
    private current: AgentStatus = 'stopped';
    private held: (() => void)[] = [];
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
        if (this.busy) {
            await new Promise<void>((resolve) => this.held.push(resolve));
        }
        this.emit({ type: 'message', role: 'user', messageId: `u-${text}`, text, append: false, ...messageFields(options) });
        this.emit({ type: 'message', role: 'agent', messageId: `a-${text}`, text: `you said: ${text}`, append: false });
        this.emit({ type: 'turn-end', reason: 'end_turn' });
    }
    /** Lets the held messages through. */
    release(): void {
        this.busy = false;
        for (const resolve of this.held.splice(0)) {
            resolve();
        }
    }
    askPermission(requestId: string): void {
        this.permission = requestId;
        this.emit({ type: 'permission', requestId, title: 'Delete everything', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] });
    }
    async cancel(): Promise<void> {
        this.calls.push('cancel');
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
