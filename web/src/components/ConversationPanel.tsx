import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Quote } from '../../../src/agent-events.js';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { Conversation, LaneMessage } from '../conversations.js';
import { quotedMessage } from '../feed.js';
import type { AgentFeed } from '../feed.js';
import { AgentMark, PairMarks, nameOf } from './AgentMark.js';
import { usePinnedScroll } from './Feed.js';
import { MessageBody } from './Message.js';
import type { QuoteActions } from './Message.js';
type Fleet = {
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
};
type ConversationPanelProps = Fleet & {
    /** The two agents of the lane, the one that wrote first first. */
    readonly pair: readonly [string, string];
    /** Undefined while the two have not written to each other. */
    readonly conversation: Conversation | undefined;
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** Where a quote leads when the quoted message is not in the lane: the tab of an agent. */
    readonly quotes: QuoteActions;
    readonly onOpen: (tab: string) => void;
    readonly conversationsId: string;
};
/** A message to bring into view in the lane; `n` tells one ask from the next. */
type Found = { readonly key: string; readonly n: number };
function messagesText(count: number): string {
    return `${count} message${count === 1 ? '' : 's'}`;
}
/** A quote leads to its message in the lane when the lane has it, else to the tab it is in. */
function useLaneQuotes(conversation: Conversation | undefined, feeds: ConversationPanelProps['feeds'], quotes: QuoteActions) {
    const [found, setFound] = useState<Found>();
    const actions: QuoteActions = {
        hasQuoted: quotes.hasQuoted,
        onOpenQuote: (quote: Quote) => {
            const target = quotedMessage(feeds[quote.agentId], quote);
            const key = target === undefined ? undefined : `${quote.agentId}:${target.seq}`;
            if (key !== undefined && conversation?.messages.some((message) => message.key === key) === true) {
                setFound((last) => ({ key, n: (last?.n ?? 0) + 1 }));
            } else {
                quotes.onOpenQuote(quote);
            }
        }
    };
    return { actions, found };
}
/** Brings the quoted message into view and flashes it, as a quote does in the tab of an agent. */
function useFound(list: RefObject<HTMLDivElement | null>, found: Found | undefined) {
    useEffect(() => {
        const target = found === undefined ? null : list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(found.key)}"]`) ?? null;
        if (target === null) {
            return;
        }
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
        target.classList.remove('message-found');
        void target.offsetWidth;
        target.classList.add('message-found');
    }, [list, found]);
}
type LaneRowProps = Fleet & { readonly message: LaneMessage; readonly side: 'first' | 'second'; readonly actions: QuoteActions };
/** One message of the lane: the envelope of #23, on the side of whoever wrote it. */
function LaneRow({ message, side, actions, agents, colors }: LaneRowProps) {
    const from = nameOf(agents, message.from);
    const to = nameOf(agents, message.to);
    return (
        <div className={`message-row lane-row lane-${side}`} data-key={message.key}>
            <div className={`item message message-sent agent-color-${colors[message.from] ?? 0}`}>
                <div className="envelope-bar">
                    <span aria-hidden="true">{from} → {to}</span>
                    <span className="visually-hidden">From {from} to {to}</span>
                </div>
                <div className="envelope-body"><MessageBody item={message.item} agents={agents} colors={colors} actions={actions} /></div>
            </div>
        </div>
    );
}
function Lane({ pair, conversation, actions, found, ...fleet }: Fleet & Pick<ConversationPanelProps, 'pair' | 'conversation'> & { readonly actions: QuoteActions; readonly found: Found | undefined }) {
    const messages = conversation?.messages ?? [];
    const { list, onScroll } = usePinnedScroll(messages);
    useFound(list, found);
    const [first, second] = pair;
    const names = `${nameOf(fleet.agents, first)} and ${nameOf(fleet.agents, second)}`;
    return (
        <div className="feed lane" role="log" aria-label={`Conversation of ${names}`} ref={list} onScroll={onScroll}>
            {messages.length === 0 ? <p className="muted empty">{names} have not written to each other yet.</p> : null}
            {messages.map((message) => <LaneRow key={message.key} message={message} side={message.from === first ? 'first' : 'second'} actions={actions} {...fleet} />)}
        </div>
    );
}
function LaneHeader({ pair, conversation, conversationsId, onOpen, agents, colors }: Omit<ConversationPanelProps, 'feeds' | 'quotes'>) {
    return (
        <header className="agent-header lane-header">
            <h1 className="lane-title">
                {pair.map((id, index) => (
                    <span key={id} className="lane-agent">
                        {index === 0 ? null : <span className="lane-arrow" aria-label="and">↔</span>}
                        <AgentMark color={colors[id]} />
                        {nameOf(agents, id)}
                    </span>
                ))}
            </h1>
            <span className="muted">{messagesText(conversation?.messages.length ?? 0)}</span>
            <button type="button" className="btn btn-sm lane-all" onClick={() => onOpen(conversationsId)}>All conversations</button>
        </header>
    );
}
/** The person reads the lane and writes to either agent in its own tab. */
function LaneFoot({ pair, agents, colors, onOpen }: Fleet & Pick<ConversationPanelProps, 'pair' | 'onOpen'>) {
    return (
        <div className="lane-foot">
            <span>Only the two agents write here.</span>
            {pair.map((id) => (
                <button key={id} type="button" className={`btn btn-sm lane-write agent-color-${colors[id] ?? 0}`} onClick={() => onOpen(id)}>Write to {nameOf(agents, id)}</button>
            ))}
        </div>
    );
}
/** The conversation of two agents in one lane, read-only: every message either sent the other, oldest first (#50). */
function ConversationPanel(props: ConversationPanelProps) {
    const { pair, conversation, feeds, quotes, agents, colors, onOpen } = props;
    const { actions, found } = useLaneQuotes(conversation, feeds, quotes);
    const names = `${nameOf(agents, pair[0])} and ${nameOf(agents, pair[1])}`;
    return (
        <section className="agent-panel conversation-panel" aria-label={`Conversation of ${names}`}>
            <LaneHeader {...props} />
            <Lane pair={pair} conversation={conversation} actions={actions} found={found} agents={agents} colors={colors} />
            <LaneFoot pair={pair} agents={agents} colors={colors} onOpen={onOpen} />
        </section>
    );
}
type ConversationsPanelProps = Fleet & {
    readonly conversations: readonly Conversation[];
    readonly onOpen: (tab: string) => void;
};
function ConversationCard({ conversation, agents, colors, onOpen }: Fleet & { readonly conversation: Conversation; readonly onOpen: (tab: string) => void }) {
    const { id, first, second, messages } = conversation;
    const last = messages.at(-1);
    return (
        <li>
            <button type="button" className="conversation-card" data-pair={id} onClick={() => onOpen(id)}>
                <span className="conversation-card-top">
                    <PairMarks first={colors[first]} second={colors[second]} />
                    <span className="conversation-card-names">{nameOf(agents, first)} ↔ {nameOf(agents, second)}</span>
                    <span className="muted">{messagesText(messages.length)}</span>
                </span>
                {last === undefined ? null : <span className="conversation-card-last">{nameOf(agents, last.from)}: {last.item.text || last.item.forwarded?.text}</span>}
            </button>
        </li>
    );
}
/** Every conversation of the fleet, the newest first: the way to those the sidebar has no room for. */
function ConversationsPanel({ conversations, onOpen, ...fleet }: ConversationsPanelProps) {
    return (
        <section className="conversations" aria-label="Conversations">
            <h1>Conversations</h1>
            <p className="muted">What the agents of the fleet write to each other, one lane for every two of them.</p>
            {conversations.length === 0 ? <p className="muted">No agent has written to another yet.</p> : null}
            <ul className="conversation-list">
                {conversations.map((conversation) => <ConversationCard key={conversation.id} conversation={conversation} onOpen={onOpen} {...fleet} />)}
            </ul>
        </section>
    );
}
export { ConversationPanel, ConversationsPanel };
