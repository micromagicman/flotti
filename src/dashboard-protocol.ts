/**
 * What the dashboard server and the page say to each other. Types only, with
 * no Node in them, so the page — built by Vite for the browser — imports the
 * very same ones and the two sides cannot drift apart.
 *
 * The page reads over one WebSocket (`/ws`) and acts over plain HTTP (`/api`):
 * every action has an answer of its own — a broadcast answers agent by agent —
 * while the socket only carries what the agents do.
 */
import type { AgentEvent, AgentStatus } from './agent-events.js';
/** An agent of the fleet as the page lists it. */
type AgentSummary = {
    readonly id: string;
    readonly name: string;
    readonly kind: 'local' | 'remote';
    readonly description?: string;
    readonly status: AgentStatus;
};
/**
 * What the page sends over the socket: the last `seq` it has seen of each
 * agent. The server answers with what came after it, then keeps the socket
 * going live. A page that has seen nothing sends an empty map.
 */
type ClientMessage = {
    readonly type: 'subscribe';
    readonly since: Readonly<Record<string, number>>;
};
/** What the server sends over the socket. */
type ServerMessage =
    /** First message of every connection: the fleet as it is now. */
    | { readonly type: 'fleet'; readonly agents: readonly AgentSummary[] }
    /** One event of one agent, from history or live; `seq` tells which. */
    | { readonly type: 'event'; readonly event: AgentEvent }
    /** How a message that had to wait in line ended up: taken at last, or dropped. */
    | { readonly type: 'delivery'; readonly delivery: Delivery }
    /** The server is going away: `flotti stop`, or Ctrl+C. */
    | { readonly type: 'shutdown' };
/** Body of `POST /api/agents/<id>/messages` and of `POST /api/broadcast`. */
type SendRequest = {
    readonly text: string;
    /** Broadcast only: which agents get it; every agent of the fleet when absent. */
    readonly agents?: readonly string[];
};
/** Body of `POST /api/agents/<id>/permissions/<requestId>`; no option refuses the request. */
type PermissionAnswer = {
    readonly optionId?: string;
};
/** How one agent took a message. */
type Delivery = {
    readonly agentId: string;
    /**
     * - `taken`  — the agent has it;
     * - `queued` — the agent is busy and the message waits in line; a `delivery`
     *              message on the socket says later how it ended;
     * - `failed` — it never got there.
     */
    readonly result: 'taken' | 'queued' | 'failed';
    /** Why it failed. */
    readonly error?: string;
};
/** Answer to a broadcast: one delivery per agent it went to, in fleet order. */
type BroadcastResponse = {
    readonly deliveries: readonly Delivery[];
};
/** Answer to any request that went wrong. */
type ErrorResponse = {
    readonly error: string;
};
export type {
    AgentSummary,
    BroadcastResponse,
    ClientMessage,
    Delivery,
    ErrorResponse,
    PermissionAnswer,
    SendRequest,
    ServerMessage
};
