/**
 * The groups of the fleet on the page (docs/groups.md, #152): the tab of a
 * group, its history as the socket sends it, and the pure parts of the tab —
 * the message as the lane shows it, how the members took it, the message a
 * quote points at, the task given inside the group, the one click that puts
 * every agent in one group. Pure: the page and the tests share it.
 */
import type { Delegation, DelegationState, Quote } from '../../src/agent-events.js';
import type { AgentSummary, Delivery, GroupConfig, GroupMessage, GroupSummary } from '../../src/dashboard-protocol.js';
import { groupTabId } from '../../src/dashboard-protocol.js';
import { present } from '../../src/present.js';
import type { MessageItem } from './feed.js';
/** Tab ids of groups start with `_`, like the settings: no agent id does. See {@link groupTabId}. */
const GROUP_PREFIX = '_group:';
/** The id of the group whose tab this is; none for any other tab. */
function groupOf(tab: string): string | undefined {
    return tab.startsWith(GROUP_PREFIX) && tab.length > GROUP_PREFIX.length ? tab.slice(GROUP_PREFIX.length) : undefined;
}
/** The history of a group as the page keeps it: its messages oldest first, and the last `seq` seen. */
type GroupFeed = {
    readonly messages: readonly GroupMessage[];
    readonly lastSeq: number;
};
const EMPTY_GROUP_FEED: GroupFeed = { messages: [], lastSeq: 0 };
/**
 * A message goes in once: one with a `seq` the page has is the same message
 * again — a replay after a reconnect, not taken again — or the line as the
 * history has it now, once a member that was in line took the message or
 * failed it (#162): then it takes the place of the one the page had.
 */
function withGroupMessage(feed: GroupFeed, message: GroupMessage): GroupFeed {
    if (message.seq > feed.lastSeq) {
        return { messages: [...feed.messages, message], lastSeq: message.seq };
    }
    const kept = feed.messages.find((known) => known.seq === message.seq);
    if (kept === undefined || sameDeliveries(kept.deliveries, message.deliveries)) {
        return feed;
    }
    return { ...feed, messages: feed.messages.map((known) => (known.seq === message.seq ? message : known)) };
}
function sameDeliveries(one: readonly Delivery[], other: readonly Delivery[]): boolean {
    return one.length === other.length && one.every((delivery, index) => sameDelivery(delivery, other[index]));
}
function sameDelivery(one: Delivery, other: Delivery | undefined): boolean {
    return other !== undefined && one.agentId === other.agentId && one.result === other.result && one.error === other.error;
}
/** Unique in the fleet, and tells where the message is: `<tab of the group>:<seq>`, as `<agent>:<seq>` does for a tab. */
function groupMessageKey(message: GroupMessage): string {
    return `${groupTabId(message.groupId)}:${message.seq}`;
}
/** What the message says: the words written above a forward, or what it forwards when nothing was. */
function textOf(message: Pick<GroupMessage, 'text' | 'forwarded'>): string {
    return message.text.trim() === '' ? message.forwarded?.text ?? message.text : message.text;
}
/**
 * The message as the lane of the group shows it: the shape of a message of a
 * tab, so the body, the quote, Reply and Forward are the tab's own. Every
 * message stands as one that came in (`role: 'user'`), with `from` naming the
 * agent that wrote it — none for a person — the way the tab of a member has it.
 */
function laneItem(message: GroupMessage): MessageItem {
    return {
        kind: 'message',
        key: groupMessageKey(message),
        role: 'user',
        messageId: message.messageId,
        seq: message.seq,
        time: message.time,
        text: message.text,
        ...present('from', message.from),
        ...(message.mentions === undefined || message.mentions.length === 0 ? {} : { mentions: message.mentions }),
        ...present('replyTo', message.replyTo),
        ...present('forwarded', message.forwarded)
    };
}
/** Whether an agent of that id is in the fleet: a member that is not is kept in the group and shown so. */
function inFleet(agents: readonly AgentSummary[], id: string): boolean {
    return agents.some((agent) => agent.id === id);
}
/** Who took the message, who has it in line, and who never got it, by name, in the order of the deliveries. */
type Took = { readonly [R in Delivery['result']]: readonly string[] };
function tookNames(deliveries: readonly Delivery[], nameOf: (id: string) => string): Took {
    const of = (result: Delivery['result']): string[] => deliveries.filter((delivery) => delivery.result === result).map((delivery) => nameOf(delivery.agentId));
    return { taken: of('taken'), queued: of('queued'), failed: of('failed') };
}
/**
 * The message of the lane a quote points at. A person's reply names the group
 * as the tab of the quoted message; an answer of a member quotes the message
 * as its own tab got it, so it is found by who wrote it and what it said,
 * the last such one before the answer. None when the lane does not have it.
 */
function quotedInLane(messages: readonly GroupMessage[], groupId: string, quote: Quote, before = Infinity): GroupMessage | undefined {
    if (quote.agentId === groupTabId(groupId)) {
        return messages.find((message) => (quote.seq === undefined ? message.messageId === quote.messageId : message.seq === quote.seq));
    }
    return [...messages].reverse().find((message) => message.seq < before && message.from === quote.author && textOf(message) === quote.text);
}
/**
 * The task the line gives (0.7.0, #171) as it stands now: the state of the
 * last line of the lane about it — its outcome, once posted — and not the
 * result, which the line of the outcome says itself. None for a line that
 * gives no task, such as the line of an outcome.
 */
function taskOf(messages: readonly GroupMessage[], message: GroupMessage): Delegation | undefined {
    const given = message.delegation;
    if (given?.state !== 'working') {
        return undefined;
    }
    const { delegationId, from, to, group, text, state, deadline } = latestOf(messages, given);
    return { delegationId, from, to, ...present('group', group), text, state, ...present('deadline', deadline) };
}
/** The task as the last line of the lane about it has it. */
function latestOf(messages: readonly GroupMessage[], given: Delegation): Delegation {
    const last = [...messages].reverse().find((line) => line.delegation?.delegationId === given.delegationId);
    return last?.delegation ?? given;
}
/** How the task a line tells the outcome of ended; none for any other line. */
function outcomeOf(message: GroupMessage): DelegationState | undefined {
    const state = message.delegation?.state;
    return state === 'working' ? undefined : state;
}
/** The one group of every agent of the fleet, made with one click when there is none (docs/groups.md, open question 2): named Everyone in every language, as the file is. */
function everyoneGroup(agents: readonly AgentSummary[]): GroupConfig {
    return { id: 'everyone', name: 'Everyone', members: agents.map((agent) => agent.id) };
}
/**
 * Where the page goes once a group is deleted from its tab (#175): the next
 * group of the Groups section, the one before it when it was the last, and
 * nothing when it was the only one — the section is empty then.
 */
function groupAfter(groups: readonly Pick<GroupSummary, 'id'>[], deleted: string): string | undefined {
    const at = groups.findIndex((group) => group.id === deleted);
    const rest = groups.filter((group) => group.id !== deleted);
    if (rest.length === 0) {
        return undefined;
    }
    return (at < 0 ? rest[0] : rest[Math.min(at, rest.length - 1)])?.id;
}
export { EMPTY_GROUP_FEED, everyoneGroup, groupAfter, groupMessageKey, groupOf, inFleet, laneItem, outcomeOf, quotedInLane, taskOf, textOf, tookNames, withGroupMessage };
export type { GroupFeed, Took };
