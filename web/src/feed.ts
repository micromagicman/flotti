/**
 * Turns the events of one agent into what its tab shows: pieces of a message
 * glued into one message, updates of a tool call folded into one card. Pure
 * functions, no React: the reducer of the page and the tests share them.
 */
import type {
    AdminAction,
    AdminActionState,
    AgentEvent,
    AgentStatus,
    Delegation,
    Forwarded,
    PermissionOption,
    Quote,
    ToolCallStatus
} from '../../src/agent-events.js';
type FeedItem =
    | {
        readonly kind: 'message';
        readonly key: string;
        readonly role: 'user' | 'agent';
        readonly messageId: string;
        /** The `seq` of the event that began it: unique in the tab, unlike the message id. */
        readonly seq: number;
        /** ISO 8601 time of the event that began it: puts messages of two tabs in one order. */
        readonly time: string;
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
    /** A task one agent gave another, where it was given, as it stands now. */
    | ({ readonly kind: 'delegation'; readonly key: string } & Delegation)
    | {
        /** An action of an administrator of the fleet, in its latest state: one item per action. */
        readonly kind: 'admin-action';
        readonly key: string;
        readonly actionId: string;
        readonly action: AdminAction;
        readonly admin: string;
        readonly target: string;
        readonly state: AdminActionState;
        readonly reason: string | undefined;
        /** Allowed or refused from this page, before the server says so: the buttons go away. */
        readonly settled: boolean;
    }
    | { readonly kind: 'turn-end'; readonly key: string; readonly reason: string }
    | { readonly kind: 'status'; readonly key: string; readonly status: AgentStatus; readonly reason: string | undefined }
    | { readonly kind: 'log'; readonly key: string; readonly source: 'agent' | 'flotti'; readonly text: string }
    | { readonly kind: 'raw'; readonly key: string; readonly protocol: 'acp' | 'a2a'; readonly payload: unknown }
    /**
     * A message that waited in line and was dropped before the agent took it:
     * the agent stopped or restarted, or flotti did. Its text stays, to be sent again.
     */
    | (Omit<QueuedMessage, 'seq'> & {
        readonly kind: 'undelivered';
        readonly key: string;
        readonly reason: string;
        /** Sent again since: a later message says it is sent in its place. */
        readonly resent: boolean;
    });
/** A message that waits in line for the agent: shown after the feed, in the order it will be taken. */
type QueuedMessage = {
    readonly messageId: string;
    /** The `seq` of its `queued` event. */
    readonly seq: number;
    /** ISO 8601 time of its `queued` event. */
    readonly time: string;
    readonly text: string;
    /** Id of the agent that sent it, when not a person. */
    readonly from?: string;
    readonly replyTo?: Quote;
    readonly forwarded?: Forwarded;
};
/** Everything one tab knows about its agent. */
type AgentFeed = {
    readonly items: readonly FeedItem[];
    /** Messages waiting in line, first to be taken first. */
    readonly queue: readonly QueuedMessage[];
    /** Last event taken in; a reconnecting page asks for what came after it. */
    readonly lastSeq: number;
    readonly status: AgentStatus;
    readonly reason: string | undefined;
};
function emptyFeed(status: AgentStatus): AgentFeed {
    return { items: [], queue: [], lastSeq: 0, status, reason: undefined };
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
/** The first piece of a message, as a message of its own. */
function newMessage(event: AgentEvent & { type: 'message' }): FeedItem {
    return {
        kind: 'message',
        key: `m${event.seq}`,
        seq: event.seq,
        time: event.time,
        role: event.role,
        messageId: event.messageId,
        text: event.text,
        ...(event.from === undefined ? {} : { from: event.from }),
        ...(event.to === undefined ? {} : { to: event.to }),
        ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
        ...(event.forwarded === undefined ? {} : { forwarded: event.forwarded })
    };
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
        return [...items, newMessage(event)];
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
/** A task shows once, where it was given; what becomes of it changes that one card. */
function withDelegation(items: readonly FeedItem[], event: AgentEvent & { type: 'delegation' }): readonly FeedItem[] {
    const { delegationId, from, to, text, state, deadline, result, seq } = event;
    const delegation: Delegation = {
        delegationId,
        from,
        to,
        text,
        state,
        ...(deadline === undefined ? {} : { deadline }),
        ...(result === undefined ? {} : { result })
    };
    const index = lastIndex(items, (item) => item.kind === 'delegation' && item.delegationId === event.delegationId);
    const found = items[index];
    if (found?.kind !== 'delegation') {
        return [...items, { kind: 'delegation', key: `d${seq}`, ...delegation }];
    }
    return replaced(items, index, { kind: 'delegation', key: found.key, ...delegation });
}
function withStatus(items: readonly FeedItem[], event: AgentEvent & { type: 'status' }): readonly FeedItem[] {
    const settled = event.status === 'waiting' ? items : settlePermissions(items);
    return isNoteworthy(event.status, event.reason)
        ? [...settled, { kind: 'status', key: `e${event.seq}`, status: event.status, reason: event.reason }]
        : settled;
}
/** The first state of an action of an administrator is a new item; the next ones change it. */
function withAdminAction(items: readonly FeedItem[], event: AgentEvent & { type: 'admin-action' }): readonly FeedItem[] {
    const index = lastIndex(items, (item) => item.kind === 'admin-action' && item.actionId === event.actionId);
    const found = items[index];
    const { actionId, action, admin, target, state } = event;
    const changed = { actionId, action, admin, target, state, reason: event.reason };
    if (found?.kind !== 'admin-action') {
        return [...items, { kind: 'admin-action', key: `e${event.seq}`, ...changed, settled: false }];
    }
    return replaced(items, index, { ...found, ...changed });
}
/**
 * The events that each add one item of their own, and those that add none: the
 * line of messages is kept apart from the feed (see withLine), and the card of
 * a task shows what came of it.
 */
function withItem(
    items: readonly FeedItem[],
    event: AgentEvent & { type: 'progress' | 'permission' | 'log' | 'raw' | 'queued' | 'unqueued' | 'cancel-delegation' }
): readonly FeedItem[] {
    const key = `e${event.seq}`;
    switch (event.type) {
        case 'queued':
        case 'unqueued':
        case 'cancel-delegation':
            return items;
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
        case 'delegation':
            return withDelegation(items, event);
        case 'admin-action':
            return withAdminAction(items, event);
        default:
            return withItem(items, event);
    }
}
type InLine = Pick<AgentFeed, 'items' | 'queue'>;
/** The message said to be sent again is not waiting for that any more. */
function markResent(items: readonly FeedItem[], retryOf: string | undefined): readonly FeedItem[] {
    if (retryOf === undefined || !items.some((item) => item.kind === 'undelivered' && item.messageId === retryOf && !item.resent)) {
        return items;
    }
    return items.map((item) => (item.kind === 'undelivered' && item.messageId === retryOf ? { ...item, resent: true } : item));
}
function withQueued({ items, queue }: InLine, event: AgentEvent & { type: 'queued' }): InLine {
    const queued: QueuedMessage = {
        messageId: event.messageId,
        seq: event.seq,
        time: event.time,
        text: event.text,
        ...(event.from === undefined ? {} : { from: event.from }),
        ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
        ...(event.forwarded === undefined ? {} : { forwarded: event.forwarded })
    };
    return { items: markResent(items, event.retryOf), queue: [...queue.filter((other) => other.messageId !== event.messageId), queued] };
}
/** A message out of the line unsent: a dropped one stays in the feed, where it can be sent again. */
function withUnqueued({ items, queue }: InLine, event: AgentEvent & { type: 'unqueued' }): InLine {
    const found = queue.find((queued) => queued.messageId === event.messageId);
    const rest = queue.filter((queued) => queued !== found);
    if (found === undefined || event.outcome === 'withdrawn') {
        return { items, queue: rest };
    }
    const { seq, ...message } = found;
    const undelivered: FeedItem = { kind: 'undelivered', key: `u${seq}`, ...message, reason: event.reason ?? 'dropped', resent: false };
    return { items: [...items, undelivered], queue: rest };
}
/** The line of messages as the event changes it; the rest of the feed goes on as it was. */
function withLine(line: InLine, event: AgentEvent): InLine {
    switch (event.type) {
        case 'queued':
            return withQueued(line, event);
        case 'unqueued':
            return withUnqueued(line, event);
        case 'message': {
            const items = withEvent(line.items, event);
            if (event.role !== 'user') {
                return { items, queue: line.queue };
            }
            // Taken: it leaves the line and goes on as a message of the feed.
            const queue = line.queue.some((queued) => queued.messageId === event.messageId)
                ? line.queue.filter((queued) => queued.messageId !== event.messageId)
                : line.queue;
            return { items: markResent(items, event.retryOf), queue };
        }
        default:
            return { items: withEvent(line.items, event), queue: line.queue };
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
    return { ...withLine(feed, event), lastSeq: event.seq, ...status };
}
/** Marks a permission request answered from this page, before the agent says so. */
function settlePermission(feed: AgentFeed, requestId: string): AgentFeed {
    const items = feed.items.map((item) =>
        (item.kind === 'permission' && item.requestId === requestId ? { ...item, settled: true } : item));
    return { ...feed, items };
}
/** Marks an action of an administrator allowed or refused from this page, before the server says so. */
function settleAdminAction(feed: AgentFeed, actionId: string): AgentFeed {
    if (!feed.items.some((item) => item.kind === 'admin-action' && item.actionId === actionId)) {
        return feed;
    }
    const items = feed.items.map((item) =>
        (item.kind === 'admin-action' && item.actionId === actionId ? { ...item, settled: true } : item));
    return { ...feed, items };
}
/** Whether the feed has an action of the administrator `agentId` waiting for a person. */
function awaitsAllowance(feed: AgentFeed | undefined, agentId: string): boolean {
    return (feed?.items ?? []).some((item) => item.kind === 'admin-action' && item.admin === agentId && item.state === 'pending' && !item.settled);
}
type AdminActionItem = FeedItem & { kind: 'admin-action' };
/** What the action does, in words, with the names of the agents. */
function adminDoing(item: AdminActionItem, name: (agentId: string) => string): string {
    if (item.admin === item.target) {
        return item.action === 'restart' ? 'restart itself' : 'clear its own context';
    }
    return item.action === 'restart' ? `restart ${name(item.target)}` : `clear the context of ${name(item.target)}`;
}
/** The line a tab shows for an action of an administrator, in its latest state. */
function adminActionText(item: AdminActionItem, name: (agentId: string) => string): string {
    const admin = name(item.admin);
    const doing = adminDoing(item, name);
    switch (item.state) {
        case 'pending':
            return `${admin} asks to ${doing}`;
        case 'scheduled':
            return `${admin} will ${doing} once its turn is over`;
        case 'done':
            return `${admin} ${doing.replace(/^restart/, 'restarted').replace(/^clear/, 'cleared')}`;
        case 'refused':
            return `${admin} may not ${doing}: ${item.reason ?? 'refused'}`;
        case 'failed':
            return `${admin} could not ${doing}: ${item.reason ?? 'no reason given'}`;
    }
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
export {
    adminActionText,
    applyEvent,
    awaitsAllowance,
    emptyFeed,
    forwardOf,
    quoteOf,
    quotedMessage,
    settleAdminAction,
    settlePermission
};
export type { AdminActionItem, AgentFeed, FeedItem, MessageItem, QueuedMessage };
