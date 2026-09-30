/**
 * The feed of the whole fleet (#114): every message of every tab in one list —
 * a person to an agent, an agent to a person, one agent to another, anyone to
 * a group. Only messages: no turn ends, statuses, tool calls or thoughts.
 * Pure, like conversations.ts: the page and the tests share it.
 *
 * Each message is taken once, from the tab it lives in:
 * - a message to an agent, from a person or from another agent, from the tab
 *   of the agent that got it — the same place a conversation takes it from;
 * - a message of an agent to a person from the tab of that agent. What an agent
 *   says in a turn another agent asked for is not for a person: flotti sends it
 *   back to the one that asked, where it is taken as a message it got. A
 *   message an agent sent another one straight away (`to`) is taken where it
 *   arrived, too;
 * - a message to a group from the history of the group (docs/groups.md, #152):
 *   it lands in the tab of every member, marked with the group, and those are
 *   passed over — one row, not one per member. What a member answered in the
 *   turn a group message started is posted to the group, and taken there.
 */
import type { GroupSummary } from '../../src/dashboard-protocol.js';
import { groupTabId } from '../../src/dashboard-protocol.js';
import { present } from '../../src/present.js';
import { pairId } from './conversations.js';
import type { AgentFeed, FeedItem, MessageItem } from './feed.js';
import { groupMessageKey, textOf } from './groups.js';
import type { GroupFeed } from './groups.js';
/** How many messages the feed keeps: the latest of the whole fleet. */
const FLEET_FEED_SIZE = 200;
/** What sort of message it is: a plain one, one sent on, a task, the outcome of a task. */
type FleetMessageKind = 'message' | 'forwarded' | 'task' | 'result';
type FleetMessage = {
    /** Unique in the fleet, and tells where the message is: `<tab>:<seq>`, as in a conversation. */
    readonly key: string;
    /** The agent that wrote it; none when a person did. */
    readonly from: string | undefined;
    /** The agent it went to; none when it went to a person, or to a group. */
    readonly to: string | undefined;
    /** The group it went to, with its members: the filter by an agent matches them. */
    readonly group?: GroupSummary;
    /** Set on what a member answered in the turn a group message started: posted to the group by flotti. */
    readonly answer?: true;
    /** The tab it is in: an agent's, or a group's. */
    readonly tab: string;
    readonly seq: number;
    /** ISO 8601. */
    readonly time: string;
    readonly text: string;
    readonly kind: FleetMessageKind;
};
/** Where a click on a message leads: the tab of an agent, the conversation of two, or the tab of a group. */
type FleetPlace =
    | { readonly tab: 'agent'; readonly agentId: string; readonly seq: number }
    | { readonly tab: 'pair'; readonly pairId: string; readonly key: string }
    | { readonly tab: 'group'; readonly groupId: string; readonly key: string };
/** The fleet the feed is made of: the agents and their tabs, the groups and their histories. */
type FleetInput = {
    readonly agentIds: readonly string[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    readonly groups?: readonly GroupSummary[];
    readonly groupFeeds?: Readonly<Record<string, GroupFeed>>;
};
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
    return { key: `${agentId}:${item.seq}`, from, to, tab: agentId, seq: item.seq, time: item.time, text: textOf(item), kind: kindOf(item) };
}
/** Whether the turn a message of the agent is in was asked for by a person, and not by another agent or through a group. */
type Scan = { readonly forPerson: boolean; readonly taken: readonly FleetMessage[] };
/** Whether a message of the tab of `agentId` came from a person, or from an agent of the fleet other than itself. */
function fromFleet(from: string | undefined, agentId: string, fleet: ReadonlySet<string>): boolean {
    return from === undefined || (from !== agentId && fleet.has(from));
}
/** A message the agent got: from a person, or from another agent of the fleet; one through a group is the group's. */
function received(agentId: string, item: MessageItem, fleet: ReadonlySet<string>): FleetMessage | undefined {
    if (item.group !== undefined || !fromFleet(item.from, agentId, fleet)) {
        return undefined;
    }
    return fleetMessage(agentId, item, item.from, agentId);
}
/** A message the agent wrote: taken here only when it is for a person, not sent to an agent or posted to a group. */
function written(agentId: string, item: MessageItem, forPerson: boolean): FleetMessage | undefined {
    return item.to === undefined && item.group === undefined && forPerson ? fleetMessage(agentId, item, agentId, undefined) : undefined;
}
/** A message that came in from a person: not from an agent, not through a group. */
function fromPerson(item: MessageItem): boolean {
    return item.from === undefined && item.group === undefined;
}
/** A message of the tab: one the agent got begins a turn, asked for by whoever sent it. */
function scannedMessage(agentId: string, fleet: ReadonlySet<string>, scan: Scan, item: MessageItem): Scan {
    const forPerson = item.role === 'user' ? fromPerson(item) : scan.forPerson;
    const taken = item.role === 'user' ? received(agentId, item, fleet) : written(agentId, item, forPerson);
    return { forPerson, taken: taken === undefined ? scan.taken : [...scan.taken, taken] };
}
function scanned(agentId: string, fleet: ReadonlySet<string>) {
    return (scan: Scan, item: FeedItem): Scan => (item.kind === 'message' ? scannedMessage(agentId, fleet, scan, item) : scan);
}
/** The messages of the fleet the tab of `agentId` holds, oldest first. */
function messagesOfTab(agentId: string, feed: AgentFeed | undefined, fleet: ReadonlySet<string>): readonly FleetMessage[] {
    const start: Scan = { forPerson: true, taken: [] };
    return (feed?.items ?? []).reduce(scanned(agentId, fleet), start).taken;
}
/** The messages of a group, each one row: who wrote it → the group, tagged as an answer when flotti posted it for a member. */
function messagesOfGroup(group: GroupSummary, feed: GroupFeed | undefined): readonly FleetMessage[] {
    return (feed?.messages ?? []).map((message) => ({
        key: groupMessageKey(message),
        from: message.from,
        to: undefined,
        group,
        ...present('answer', message.turnAnswer),
        tab: groupTabId(group.id),
        seq: message.seq,
        time: message.time,
        text: textOf(message),
        kind: message.forwarded === undefined ? 'message' : 'forwarded'
    }));
}
/** Oldest first; one time in two tabs — the clock ticks in milliseconds — keeps the order of each tab. */
function byTime(one: FleetMessage, other: FleetMessage): number {
    return one.time.localeCompare(other.time) || one.tab.localeCompare(other.tab) || one.seq - other.seq;
}
/** The latest `size` messages of the whole fleet, oldest first. Only agents of the fleet count. */
function fleetMessages({ agentIds, feeds, groups = [], groupFeeds = {} }: FleetInput, size = FLEET_FEED_SIZE): FleetMessage[] {
    const fleet = new Set(agentIds);
    return [
        ...agentIds.flatMap((agentId) => messagesOfTab(agentId, feeds[agentId], fleet)),
        ...groups.flatMap((group) => messagesOfGroup(group, groupFeeds[group.id]))
    ].sort(byTime).slice(-size);
}
/** Whether the agent wrote or got the message: a message to a group went to every member. */
function concerns(message: FleetMessage, agentId: string): boolean {
    return message.from === agentId || message.to === agentId || message.group?.members.includes(agentId) === true;
}
/** The messages an agent wrote or got; all of them when no agent is picked. */
function messagesOf(messages: readonly FleetMessage[], agentId: string | undefined): readonly FleetMessage[] {
    return agentId === undefined ? messages : messages.filter((message) => concerns(message, agentId));
}
/** Where the message lives: in a group, its tab; between two agents, their conversation; else the tab of the agent. */
function placeOf(message: FleetMessage): FleetPlace {
    const { from, to, group } = message;
    if (group !== undefined) {
        return { tab: 'group', groupId: group.id, key: message.key };
    }
    return from === undefined || to === undefined
        ? { tab: 'agent', agentId: message.tab, seq: message.seq }
        : { tab: 'pair', pairId: pairId(from, to), key: message.key };
}
export { FLEET_FEED_SIZE, fleetMessages, messagesOf, placeOf };
export type { FleetInput, FleetMessage, FleetMessageKind, FleetPlace };
