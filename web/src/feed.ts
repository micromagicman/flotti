/**
 * Turns the events of one agent into what its tab shows: pieces of a message
 * glued into one message, updates of a tool call folded into one card. Pure
 * functions, no React: the reducer of the page and the tests share them.
 */
import type { AgentEvent, AgentStatus, Forwarded, PermissionOption, Quote, ToolCallStatus } from '../../src/agent-events.js';
type FeedItem =
    | {
        readonly kind: 'message';
        readonly key: string;
        readonly role: 'user' | 'agent';
        readonly messageId: string;
        /** The `seq` of the event that began it: unique in the tab, unlike the message id. */
        readonly seq: number;
        readonly text: string;
        /** Id of the agent that sent it, when not a person: shown on the person's side, marked with the sender. */
        readonly from?: string;
        /** Id of the agent this message of the agent went to, when it went to another agent and not to a person. */
        readonly to?: string;
        /** The message this one answers. */
        readonly replyTo?: Quote;
        /** A message sent on as it was; `text` is then what was written above it. */
        readonly forwarded?: Forwarded;
    }
    | { readonly kind: 'thought'; readonly key: string; readonly text: string }
    | { readonly kind: 'progress'; readonly key: string; readonly text: string }
    | {
        readonly kind: 'tool';
        readonly key: string;
        readonly toolCallId: string;
        readonly title: string;
        readonly status: ToolCallStatus | undefined;
    }
    | {
        readonly kind: 'permission';
        readonly key: string;
        readonly requestId: string;
        readonly title: string;
        readonly options: readonly PermissionOption[];
        /** Answered — here or anywhere else; the buttons go away. */
        readonly settled: boolean;
    }
    | { readonly kind: 'turn-end'; readonly key: string; readonly reason: string }
    | { readonly kind: 'status'; readonly key: string; readonly status: AgentStatus; readonly reason: string | undefined }
    | { readonly kind: 'log'; readonly key: string; readonly source: 'agent' | 'flotti'; readonly text: string }
    | { readonly kind: 'raw'; readonly key: string; readonly protocol: 'acp' | 'a2a'; readonly payload: unknown };
/** Everything one tab knows about its agent. */
type AgentFeed = {
    readonly items: readonly FeedItem[];
    /** Last event taken in; a reconnecting page asks for what came after it. */
    readonly lastSeq: number;
    readonly status: AgentStatus;
    readonly reason: string | undefined;
};
function emptyFeed(status: AgentStatus): AgentFeed {
    return { items: [], lastSeq: 0, status, reason: undefined };
}
/** Statuses worth a line in the feed; `working` and `idle` come and go with every message. */
function isNoteworthy(status: AgentStatus, reason: string | undefined): boolean {
    return status === 'starting' || status === 'error' || status === 'stopped' || (status === 'idle' && reason !== undefined && reason !== 'ready');
}
function lastIndex(items: readonly FeedItem[], test: (item: FeedItem) => boolean): number {
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item !== undefined && test(item)) {
            return index;
        }
    }
    return -1;
}
function replaced(items: readonly FeedItem[], index: number, item: FeedItem): FeedItem[] {
    const copy = [...items];
    copy[index] = item;
    return copy;
}
function settlePermissions(items: readonly FeedItem[]): readonly FeedItem[] {
    if (!items.some((item) => item.kind === 'permission' && !item.settled)) {
        return items;
    }
    return items.map((item) => (item.kind === 'permission' && !item.settled ? { ...item, settled: true } : item));
}
/**
 * A message goes on within its turn only: an agent that uses one id for the
 * answer of every turn — the protocols allow it — still gets a new message
 * each time.
 */
function withMessage(items: readonly FeedItem[], event: AgentEvent & { type: 'message' }): readonly FeedItem[] {
    const turnStart = lastIndex(items, (item) => item.kind === 'turn-end');
    const index = lastIndex(items, (item) => item.kind === 'message' && item.messageId === event.messageId);
    const found = index > turnStart ? items[index] : undefined;
    if (found?.kind !== 'message') {
        return [...items, {
            kind: 'message',
            key: `m${event.seq}`,
            seq: event.seq,
            role: event.role,
            messageId: event.messageId,
            text: event.text,
            ...(event.from === undefined ? {} : { from: event.from }),
            ...(event.to === undefined ? {} : { to: event.to }),
            ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
            ...(event.forwarded === undefined ? {} : { forwarded: event.forwarded })
        }];
    }
    return replaced(items, index, { ...found, text: event.append ? found.text + event.text : event.text });
}
function withThought(items: readonly FeedItem[], event: AgentEvent & { type: 'thought' }): readonly FeedItem[] {
    const last = items.at(-1);
    if (last?.kind === 'thought') {
        return replaced(items, items.length - 1, { ...last, text: last.text + event.text });
    }
    return [...items, { kind: 'thought', key: `t${event.seq}`, text: event.text }];
}
function withToolCall(items: readonly FeedItem[], event: AgentEvent & { type: 'tool-call' }): readonly FeedItem[] {
    const index = lastIndex(items, (item) => item.kind === 'tool' && item.toolCallId === event.toolCallId);
    const found = items[index];
    if (found?.kind !== 'tool') {
        const title = event.title ?? event.toolCallId;
        return [...items, { kind: 'tool', key: `c${event.seq}`, toolCallId: event.toolCallId, title, status: event.status }];
    }
    return replaced(items, index, { ...found, title: event.title ?? found.title, status: event.status ?? found.status });
}
function withStatus(items: readonly FeedItem[], event: AgentEvent & { type: 'status' }): readonly FeedItem[] {
    const settled = event.status === 'waiting' ? items : settlePermissions(items);
    return isNoteworthy(event.status, event.reason)
        ? [...settled, { kind: 'status', key: `e${event.seq}`, status: event.status, reason: event.reason }]
        : settled;
}
/** The events that each add one item of their own. */
function withItem(items: readonly FeedItem[], event: AgentEvent & { type: 'progress' | 'permission' | 'log' | 'raw' }): readonly FeedItem[] {
    const key = `e${event.seq}`;
    switch (event.type) {
        case 'progress':
            return [...items, { kind: 'progress', key, text: event.text }];
        case 'permission':
            return [...items, { kind: 'permission', key, requestId: event.requestId, title: event.title, options: event.options, settled: false }];
        case 'log':
            return [...items, { kind: 'log', key, source: event.source, text: event.text }];
        case 'raw':
            return [...items, { kind: 'raw', key, protocol: event.protocol, payload: event.payload }];
    }
}
function withEvent(items: readonly FeedItem[], event: AgentEvent): readonly FeedItem[] {
    switch (event.type) {
        case 'message':
            return withMessage(items, event);
        case 'thought':
            return withThought(items, event);
        case 'tool-call':
            return withToolCall(items, event);
        case 'turn-end':
            return [...settlePermissions(items), { kind: 'turn-end', key: `e${event.seq}`, reason: event.reason }];
        case 'status':
            return withStatus(items, event);
        default:
            return withItem(items, event);
    }
}
/**
 * Takes one event in. An event the feed has already seen — a reconnect may
 * send the tail again — changes nothing.
 */
function applyEvent(feed: AgentFeed, event: AgentEvent): AgentFeed {
    if (event.seq <= feed.lastSeq) {
        return feed;
    }
    const status = event.type === 'status'
        ? { status: event.status, reason: event.reason }
        : { status: feed.status, reason: feed.reason };
    return { items: withEvent(feed.items, event), lastSeq: event.seq, ...status };
}
/** Marks a permission request answered from this page, before the agent says so. */
function settlePermission(feed: AgentFeed, requestId: string): AgentFeed {
    const items = feed.items.map((item) =>
        (item.kind === 'permission' && item.requestId === requestId ? { ...item, settled: true } : item));
    return { ...feed, items };
}
type MessageItem = FeedItem & { kind: 'message' };
/** Who wrote a message of the tab of `agentId`: that agent, another one, or a person (`undefined`). */
function authorOf(item: MessageItem, agentId: string): string | undefined {
    return item.role === 'agent' ? agentId : item.from;
}
/**
 * What a forward of the message sends on: the message as its author wrote
 * it. A forward with nothing written above it goes on as the forward it was,
 * naming who wrote it first.
 */
function forwardOf(item: MessageItem, agentId: string): Forwarded {
    if (item.forwarded !== undefined && item.text.trim() === '') {
        return item.forwarded;
    }
    const author = authorOf(item, agentId);
    return { text: item.text, ...(author === undefined ? {} : { author }) };
}
/** What a reply to the message quotes: where it is, who wrote it and what it says. */
function quoteOf(item: MessageItem, agentId: string): Quote {
    const { text, author } = forwardOf(item, agentId);
    return { agentId, messageId: item.messageId, seq: item.seq, text, ...(author === undefined ? {} : { author }) };
}
/**
 * The message of the feed a quote points at: by its `seq` when the quote has
 * one, else the last one with its id. None once it is gone: history is bounded.
 */
function quotedMessage(feed: AgentFeed | undefined, quote: Pick<Quote, 'messageId' | 'seq'>): MessageItem | undefined {
    const items = feed?.items ?? [];
    const found = items[lastIndex(items, (item) => item.kind === 'message'
        && (quote.seq === undefined ? item.messageId === quote.messageId : item.seq === quote.seq))];
    return found?.kind === 'message' ? found : undefined;
}
export { applyEvent, emptyFeed, forwardOf, quoteOf, quotedMessage, settlePermission };
export type { AgentFeed, FeedItem, MessageItem };
