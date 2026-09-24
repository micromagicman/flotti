/**
 * The conversations of the fleet: every message two agents sent each other,
 * in one lane per pair (#50). Pure, like feed.ts: the page and the tests
 * share it.
 *
 * A lane is gathered from the tabs of both agents, taking from each only the
 * messages it received from the other. Every message between agents lands in
 * the tab of its receiver, whichever way it went — a tool of the fleet or the
 * inbox of a remote agent — while the tab of the sender shows it only for the
 * inbox. So a message is taken once, and none is missed.
 */
import type { AgentFeed, MessageItem } from './feed.js';
/** Tab ids of conversations start with `_`, like the settings: no agent id does. */
const PAIR_PREFIX = '_pair:';
/** One message of a lane, and where it is: the tab of the agent it went to. */
type LaneMessage = {
    /** Unique in the lane, and tells where the message is: `<receiver>:<seq>`. */
    readonly key: string;
    readonly from: string;
    readonly to: string;
    readonly item: MessageItem;
};
type Conversation = {
    /** The tab id of the lane; the same whichever of the two wrote first. */
    readonly id: string;
    /** The agent that wrote first: its messages stand on the left. */
    readonly first: string;
    readonly second: string;
    /** Oldest first. */
    readonly messages: readonly LaneMessage[];
};
/** The tab id of the conversation of two agents: `:` is in no agent id, so the two part again. */
function pairId(one: string, other: string): string {
    return PAIR_PREFIX + [one, other].sort().join(':');
}
/** The two agents of a conversation tab; none for any other tab. */
function pairOf(tab: string): readonly [string, string] | undefined {
    if (!tab.startsWith(PAIR_PREFIX)) {
        return undefined;
    }
    const [one, other, ...rest] = tab.slice(PAIR_PREFIX.length).split(':');
    return one === undefined || other === undefined || one === '' || other === '' || rest.length > 0 ? undefined : [one, other];
}
/** The messages other agents of the fleet sent to `agentId`. */
function received(agentId: string, feed: AgentFeed, fleet: ReadonlySet<string>): LaneMessage[] {
    return feed.items.flatMap((item) => (item.kind === 'message' && item.role === 'user'
        && item.from !== undefined && item.from !== agentId && fleet.has(item.from)
        ? [{ key: `${agentId}:${item.seq}`, from: item.from, to: agentId, item }]
        : []));
}
/** Oldest first; one time in two tabs — the clock ticks in milliseconds — keeps the order of each tab. */
function byTime(one: LaneMessage, other: LaneMessage): number {
    return one.item.time.localeCompare(other.item.time) || one.to.localeCompare(other.to) || one.item.seq - other.item.seq;
}
function lastTime(conversation: Conversation): string {
    return conversation.messages.at(-1)?.item.time ?? '';
}
/**
 * Every conversation of the fleet, the one with the newest message first.
 * Only agents of the fleet count: a lane with an agent gone has no one to write to.
 */
function conversations(agentIds: readonly string[], feeds: Readonly<Record<string, AgentFeed>>): Conversation[] {
    const fleet = new Set(agentIds);
    const lanes = new Map<string, LaneMessage[]>();
    for (const agentId of agentIds) {
        const feed = feeds[agentId];
        for (const message of feed === undefined ? [] : received(agentId, feed, fleet)) {
            const id = pairId(message.from, message.to);
            lanes.set(id, [...(lanes.get(id) ?? []), message]);
        }
    }
    return [...lanes].map(([id, messages]): Conversation => {
        const sorted = messages.sort(byTime);
        const [head] = sorted as [LaneMessage];
        return { id, first: head.from, second: head.to, messages: sorted };
    }).sort((one, other) => lastTime(other).localeCompare(lastTime(one)) || one.id.localeCompare(other.id));
}
/**
 * The conversations the sidebar lists by name: the `room` newest, and the one
 * open when it is older. The rest are one tab away, in the list of them all.
 */
function shownInSidebar(all: readonly Conversation[], room: number, open: string | undefined): Conversation[] {
    const newest = all.slice(0, room);
    const opened = all.find((conversation) => conversation.id === open);
    return opened === undefined || newest.includes(opened) ? newest : [...newest, opened];
}
export { conversations, pairId, pairOf, shownInSidebar };
export type { Conversation, LaneMessage };
