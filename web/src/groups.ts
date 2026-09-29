/**
 * The groups of the fleet on the page (docs/groups.md, #152): the tab of a
 * group, its history as the socket sends it, and the pure parts of the tab —
 * the message as the lane shows it, how the members took it, the message a
 * quote points at, the one click that puts every agent in one group. Pure,
 * like conversations.ts: the page and the tests share it.
 */
import type { Quote } from '../../src/agent-events.js';
import type { AgentSummary, Delivery, GroupConfig, GroupMessage } from '../../src/dashboard-protocol.js';
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
/** A message goes in once: one with a `seq` the page has — a replay after a reconnect — is not taken again. */
function withGroupMessage(feed: GroupFeed, message: GroupMessage): GroupFeed {
    if (message.seq <= feed.lastSeq) {
        return feed;
    }
    return { messages: [...feed.messages, message], lastSeq: message.seq };
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
/** The one group of every agent of the fleet, made with one click when there is none (docs/groups.md, open question 2): named Everyone in every language, as the file is. */
function everyoneGroup(agents: readonly AgentSummary[]): GroupConfig {
    return { id: 'everyone', name: 'Everyone', members: agents.map((agent) => agent.id) };
}
export { EMPTY_GROUP_FEED, everyoneGroup, groupMessageKey, groupOf, inFleet, laneItem, quotedInLane, textOf, tookNames, withGroupMessage };
export type { GroupFeed, Took };
