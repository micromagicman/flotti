/**
 * The one shape every agent of the fleet has for the dashboard, whether it is a
 * local process spoken to over ACP or a remote service spoken to over A2A: the
 * dashboard subscribes to events and sends messages without knowing which.
 *
 * Kept deliberately small. What only one protocol has (ACP tool calls and plans,
 * A2A artifacts) is either folded into these events or added here when the
 * dashboard learns to show it — not guessed at in advance.
 */
/**
 * What the agent is doing, as the dashboard tab shows it:
 * - `starting` — being started or connected to; not ready for messages yet;
 * - `idle`     — ready and doing nothing;
 * - `working`  — busy with a message;
 * - `waiting`  — stopped half-way and waiting for a person: a permission to
 *                grant, more input, a login;
 * - `error`    — the last attempt failed; the reason says why;
 * - `stopped`  — stopped on purpose and not coming back by itself.
 */
type AgentStatus = 'starting' | 'idle' | 'working' | 'waiting' | 'error' | 'stopped';
type AgentEvent =
    /** The agent status changed. */
    | {
        readonly type: 'status';
        readonly status: AgentStatus;
        /** Why, in a few words, when there is more to say than the status itself. */
        readonly reason?: string;
    }
    /**
     * A piece of a message. Pieces with one `messageId` make one message on the
     * screen: `append: false` sets its text (starting the message, or replacing
     * it), `append: true` adds the text to its end.
     */
    | {
        readonly type: 'message';
        readonly role: 'user' | 'agent';
        readonly messageId: string;
        readonly text: string;
        readonly append: boolean;
    };
type AgentEventListener = (event: AgentEvent) => void;
/** An agent of the fleet as the dashboard drives it. */
interface AgentConnection {
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
     * agent has accepted the message, not when it has answered.
     */
    send(text: string): Promise<void>;
    /** Asks the agent to drop what it is working on; does nothing when it is not busy. */
    cancel(): Promise<void>;
    /** Stops and starts the agent again; the conversation starts anew. */
    restart(): Promise<void>;
    /** Stops the agent, or disconnects from it; queued messages are dropped. */
    stop(): Promise<void>;
}
/**
 * Keeps the listeners of one agent and hands events to them. A listener that
 * throws is the listener's problem: it does not stop the others, nor the agent.
 */
class AgentEvents {
    private readonly listeners = new Set<AgentEventListener>();
    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit(event: AgentEvent): void {
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
export type { AgentConnection, AgentEvent, AgentEventListener, AgentStatus };
