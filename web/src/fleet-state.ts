/**
 * State of the whole page and how server messages change it. Pure, like
 * feed.ts: the hook in connection.ts only feeds it.
 */
import type { AgentSummary, Delivery, ServerMessage } from '../../src/dashboard-protocol.js';
import { applyEvent, emptyFeed, settlePermission } from './feed.js';
import type { AgentFeed } from './feed.js';
/** Where the socket is: `gone` — the server said it stops, and nothing reconnects. */
type Link = 'connecting' | 'open' | 'closed' | 'gone';
type FleetState = {
    readonly link: Link;
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** Late outcomes of queued messages, newest last. */
    readonly deliveries: readonly Delivery[];
};
type FleetAction =
    | { readonly type: 'link'; readonly link: Link }
    | { readonly type: 'server'; readonly message: ServerMessage }
    | { readonly type: 'permission-answered'; readonly agentId: string; readonly requestId: string };
const initialState: FleetState = { link: 'connecting', agents: [], feeds: {}, deliveries: [] };
function withFleet(state: FleetState, agents: readonly AgentSummary[]): FleetState {
    const feeds: Record<string, AgentFeed> = {};
    for (const agent of agents) {
        const known = state.feeds[agent.id];
        feeds[agent.id] = known === undefined ? emptyFeed(agent.status) : { ...known, status: agent.status };
    }
    return { ...state, agents, feeds };
}
function fromServer(state: FleetState, message: ServerMessage): FleetState {
    switch (message.type) {
        case 'fleet':
            return withFleet(state, message.agents);
        case 'event': {
            const feed = state.feeds[message.event.agentId];
            if (feed === undefined) {
                return state;
            }
            return { ...state, feeds: { ...state.feeds, [message.event.agentId]: applyEvent(feed, message.event) } };
        }
        case 'delivery':
            return { ...state, deliveries: [...state.deliveries, message.delivery] };
        case 'shutdown':
            return { ...state, link: 'gone' };
    }
}
function fleetReducer(state: FleetState, action: FleetAction): FleetState {
    switch (action.type) {
        case 'link':
            return state.link === 'gone' ? state : { ...state, link: action.link };
        case 'server':
            return fromServer(state, action.message);
        case 'permission-answered': {
            const feed = state.feeds[action.agentId];
            return feed === undefined
                ? state
                : { ...state, feeds: { ...state.feeds, [action.agentId]: settlePermission(feed, action.requestId) } };
        }
    }
}
/** What the page has seen of each agent: sent on (re)connecting so the server sends only the rest. */
function seen(state: FleetState): Record<string, number> {
    return Object.fromEntries(Object.entries(state.feeds).map(([id, feed]) => [id, feed.lastSeq]));
}
export { fleetReducer, initialState, seen };
export type { FleetAction, FleetState, Link };
