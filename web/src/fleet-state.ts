/**
 * State of the whole page and how server messages change it. Pure, like
 * feed.ts: the hook in connection.ts only feeds it.
 */
import type { AgentSummary, ConnectionHealth, Delivery, GroupMessage, GroupSummary, ServerMessage } from '../../src/dashboard-protocol.js';
import { groupTabId } from '../../src/dashboard-protocol.js';
import { applyEvent, emptyFeed, settleAdminAction, settlePermission } from './feed.js';
import type { AgentFeed } from './feed.js';
import { EMPTY_GROUP_FEED, withGroupMessage } from './groups.js';
import type { GroupFeed } from './groups.js';
/** Where the socket is: `gone` — the server said it stops, and nothing reconnects. */
type Link = 'connecting' | 'open' | 'closed' | 'gone';
type FleetState = {
    readonly link: Link;
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** The groups of the fleet (docs/groups.md), as the server lists them, and the history of each by its id. */
    readonly groups: readonly GroupSummary[];
    readonly groupFeeds: Readonly<Record<string, GroupFeed>>;
    /** Late outcomes of queued messages, newest last. */
    readonly deliveries: readonly Delivery[];
};
type FleetAction =
    | { readonly type: 'link'; readonly link: Link }
    | { readonly type: 'server'; readonly message: ServerMessage }
    | { readonly type: 'permission-answered'; readonly agentId: string; readonly requestId: string }
    /** An action of an administrator allowed or refused here: it shows in two tabs, and both settle. */
    | { readonly type: 'admin-answered'; readonly actionId: string };
const initialState: FleetState = { link: 'connecting', agents: [], feeds: {}, groups: [], groupFeeds: {}, deliveries: [] };
function withFleet(state: FleetState, agents: readonly AgentSummary[], groups: readonly GroupSummary[]): FleetState {
    const feeds: Record<string, AgentFeed> = {};
    for (const agent of agents) {
        const known = state.feeds[agent.id];
        feeds[agent.id] = known === undefined ? emptyFeed(agent.status) : { ...known, status: agent.status };
    }
    const groupFeeds = Object.fromEntries(groups.map((group) => [group.id, state.groupFeeds[group.id] ?? EMPTY_GROUP_FEED]));
    return { ...state, agents, feeds, groups, groupFeeds };
}
/** The agent's connection is as healthy as the server says now. */
function withHealth(state: FleetState, agentId: string, health: ConnectionHealth): FleetState {
    return { ...state, agents: state.agents.map((agent) => (agent.id === agentId ? { ...agent, health } : agent)) };
}
type EventMessage = Extract<ServerMessage, { type: 'event' }>;
/** An event of an agent the page knows goes into its feed; one of any other agent is dropped. */
function withEvent(state: FleetState, event: EventMessage['event']): FleetState {
    const feed = state.feeds[event.agentId];
    if (feed === undefined) {
        return state;
    }
    return { ...state, feeds: { ...state.feeds, [event.agentId]: applyEvent(feed, event) } };
}
/** A message of a group the page knows goes into its history; one of any other group is dropped. */
function withGroupMessageOf(state: FleetState, message: GroupMessage): FleetState {
    const feed = state.groupFeeds[message.groupId];
    if (feed === undefined) {
        return state;
    }
    return { ...state, groupFeeds: { ...state.groupFeeds, [message.groupId]: withGroupMessage(feed, message) } };
}
function fromServer(state: FleetState, message: ServerMessage): FleetState {
    switch (message.type) {
        case 'fleet':
            return withFleet(state, message.agents, message.groups);
        case 'event':
            return withEvent(state, message.event);
        case 'group-message':
            return withGroupMessageOf(state, message.message);
        default:
            return fromServerNotice(state, message);
    }
}
function fromServerNotice(state: FleetState, message: Exclude<ServerMessage, { type: 'fleet' | 'event' | 'group-message' }>): FleetState {
    switch (message.type) {
        case 'delivery':
            return { ...state, deliveries: [...state.deliveries, message.delivery] };
        case 'health':
            return withHealth(state, message.agentId, message.health);
        case 'shutdown':
            return { ...state, link: 'gone' };
    }
}
/** Once the server said it stops, the socket stays gone. */
function withLink(state: FleetState, link: Link): FleetState {
    return state.link === 'gone' ? state : { ...state, link };
}
function fleetReducer(state: FleetState, action: FleetAction): FleetState {
    switch (action.type) {
        case 'link':
            return withLink(state, action.link);
        case 'server':
            return fromServer(state, action.message);
        default:
            return withAnswer(state, action);
    }
}
/** A permission request or an action of an administrator answered here. */
function withAnswer(state: FleetState, action: Exclude<FleetAction, { type: 'link' | 'server' }>): FleetState {
    switch (action.type) {
        case 'permission-answered':
            return withPermissionAnswered(state, action.agentId, action.requestId);
        case 'admin-answered':
            return { ...state, feeds: Object.fromEntries(Object.entries(state.feeds).map(([id, feed]) => [id, settleAdminAction(feed, action.actionId)])) };
    }
}
function withPermissionAnswered(state: FleetState, agentId: string, requestId: string): FleetState {
    const feed = state.feeds[agentId];
    return feed === undefined
        ? state
        : { ...state, feeds: { ...state.feeds, [agentId]: settlePermission(feed, requestId) } };
}
/** What the page has seen of each agent, and of each group under its tab id: sent on (re)connecting so the server sends only the rest. */
function seen(state: FleetState): Record<string, number> {
    return Object.fromEntries([
        ...Object.entries(state.feeds).map(([id, feed]) => [id, feed.lastSeq]),
        ...Object.entries(state.groupFeeds).map(([id, feed]) => [groupTabId(id), feed.lastSeq])
    ]);
}
export { fleetReducer, initialState, seen };
export type { FleetAction, FleetState, Link };
