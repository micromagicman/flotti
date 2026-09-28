/**
 * The feed of the whole fleet (#114): every message of every tab in one list —
 * a person to an agent, an agent to a person, one agent to another. Only
 * messages: no turn ends, statuses, tool calls or thoughts. Pure, like
 * conversations.ts: the page and the tests share it.
 *
 * Each message is taken once, from the tab it lives in:
 * - a message to an agent, from a person or from another agent, from the tab
 *   of the agent that got it — the same place a conversation takes it from;
 * - a message of an agent to a person from the tab of that agent. What an agent
 *   says in a turn another agent asked for is not for a person: flotti sends it
 *   back to the one that asked, where it is taken as a message it got. A
 *   message an agent sent another one straight away (`to`) is taken where it
 *   arrived, too.
 */
import { pairId } from './conversations.js';
import type { AgentFeed, FeedItem, MessageItem } from './feed.js';
/** How many messages the feed keeps: the latest of the whole fleet. */
const FLEET_FEED_SIZE = 200;
/** What sort of message it is: a plain one, one sent on, a task, the outcome of a task. */
type FleetMessageKind = 'message' | 'forwarded' | 'task' | 'result';
type FleetMessage = {
    /** Unique in the fleet, and tells where the message is: `<agent of the tab>:<seq>`, as in a conversation. */
    readonly key: string;
    /** The agent that wrote it; none when a person did. */
    readonly from: string | undefined;
    /** The agent it went to; none when it went to a person. */
    readonly to: string | undefined;
    /** The agent in whose tab it is. */
    readonly agentId: string;
    readonly seq: number;
    /** ISO 8601. */
    readonly time: string;
    readonly text: string;
    readonly kind: FleetMessageKind;
};
/** Where a click on a message leads: the tab of an agent, or the conversation of two. */
type FleetPlace =
    | { readonly tab: 'agent'; readonly agentId: string; readonly seq: number }
    | { readonly tab: 'pair'; readonly pairId: string; readonly key: string };
function kindOf(item: MessageItem): FleetMessageKind {
    if (item.forwarded !== undefined) {
        return 'forwarded';
    }
    if (item.delegation === undefined) {
        return 'message';
    }
    return item.delegation.state === undefined ? 'task' : 'result';
}
function fleetMessage(agentId: string, item: MessageItem, from: string | undefined, to: string | undefined): FleetMessage {
    const text = item.text.trim() === '' ? item.forwarded?.text ?? item.text : item.text;
    return { key: `${agentId}:${item.seq}`, from, to, agentId, seq: item.seq, time: item.time, text, kind: kindOf(item) };
}
/** Who asked for the turn a message of the agent is in: a person (`undefined`) or another agent. */
type Scan = { readonly asker: string | undefined; readonly taken: readonly FleetMessage[] };
/** A message the agent got: from a person, or from an agent of the fleet other than itself. */
function received(agentId: string, item: MessageItem, fleet: ReadonlySet<string>): FleetMessage | undefined {
    const from = item.from;
    if (from !== undefined && (from === agentId || !fleet.has(from))) {
        return undefined;
    }
    return fleetMessage(agentId, item, from, agentId);
}
/** A message the agent wrote: taken here only when it is for a person. */
function written(agentId: string, item: MessageItem, asker: string | undefined): FleetMessage | undefined {
    return item.to === undefined && asker === undefined ? fleetMessage(agentId, item, agentId, undefined) : undefined;
}
/** A message of the tab: one the agent got begins a turn, asked for by whoever sent it. */
function scannedMessage(agentId: string, fleet: ReadonlySet<string>, scan: Scan, item: MessageItem): Scan {
    const asker = item.role === 'user' ? item.from : scan.asker;
    const taken = item.role === 'user' ? received(agentId, item, fleet) : written(agentId, item, asker);
    return { asker, taken: taken === undefined ? scan.taken : [...scan.taken, taken] };
}
function scanned(agentId: string, fleet: ReadonlySet<string>) {
    return (scan: Scan, item: FeedItem): Scan => (item.kind === 'message' ? scannedMessage(agentId, fleet, scan, item) : scan);
}
/** The messages of the fleet the tab of `agentId` holds, oldest first. */
function messagesOfTab(agentId: string, feed: AgentFeed | undefined, fleet: ReadonlySet<string>): readonly FleetMessage[] {
    const start: Scan = { asker: undefined, taken: [] };
    return (feed?.items ?? []).reduce(scanned(agentId, fleet), start).taken;
}
/** Oldest first; one time in two tabs — the clock ticks in milliseconds — keeps the order of each tab. */
function byTime(one: FleetMessage, other: FleetMessage): number {
    return one.time.localeCompare(other.time) || one.agentId.localeCompare(other.agentId) || one.seq - other.seq;
}
/** The latest `size` messages of the whole fleet, oldest first. Only agents of the fleet count. */
function fleetMessages(agentIds: readonly string[], feeds: Readonly<Record<string, AgentFeed>>, size = FLEET_FEED_SIZE): FleetMessage[] {
    const fleet = new Set(agentIds);
    return agentIds.flatMap((agentId) => messagesOfTab(agentId, feeds[agentId], fleet)).sort(byTime).slice(-size);
}
/** The messages an agent wrote or got; all of them when no agent is picked. */
function messagesOf(messages: readonly FleetMessage[], agentId: string | undefined): readonly FleetMessage[] {
    return agentId === undefined ? messages : messages.filter((message) => message.from === agentId || message.to === agentId);
}
/** Where the message lives: between two agents, their conversation; else the tab of the agent. */
function placeOf(message: FleetMessage): FleetPlace {
    const { from, to } = message;
    return from === undefined || to === undefined
        ? { tab: 'agent', agentId: message.agentId, seq: message.seq }
        : { tab: 'pair', pairId: pairId(from, to), key: message.key };
}
export { FLEET_FEED_SIZE, fleetMessages, messagesOf, placeOf };
export type { FleetMessage, FleetMessageKind, FleetPlace };
