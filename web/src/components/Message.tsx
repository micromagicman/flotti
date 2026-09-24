import { useState } from 'react';
import type { Forwarded, Quote } from '../../../src/agent-events.js';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { forwardOf, quoteOf } from '../feed.js';
import { nameOf } from './AgentMark.js';
import type { MessageItem } from '../feed.js';
import { LinkedText } from './LinkedText.js';
import { useT } from '../i18n/I18n.js';
import type { Messages } from '../i18n/en.js';
import { errorText } from '../i18n/errors.js';
/** What a message can do besides being read: be answered, sent on, and lead to the message it answers. */
type MessageActions = {
    readonly onReply: (quote: Quote) => void;
    /** Resolves once the other agent has it or it waits in line; rejects saying why it did not go. */
    readonly onForward: (to: string, forwarded: Forwarded) => Promise<void>;
    /** Whether the message a quote points at is still in its feed. */
    readonly hasQuoted: (quote: Quote) => boolean;
    readonly onOpenQuote: (quote: Quote) => void;
};
type MessageProps = {
    readonly item: MessageItem;
    readonly agentId: string;
    readonly agentName: string;
    /** The whole fleet: a message between agents names the other one. */
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly actions: MessageActions;
};
type Names = Pick<MessageProps, 'agents' | 'colors'>;
/** What a quote needs: whether the quoted message is still there, and the way to it. */
type QuoteActions = Pick<MessageActions, 'hasQuoted' | 'onOpenQuote'>;
/** The colour class of an author: an agent has its own, a person none. */
function colorOf(colors: AgentColors, author: string | undefined): string {
    return author === undefined ? 'author-person' : `agent-color-${colors[author] ?? 0}`;
}
function authorName(agents: readonly AgentSummary[], author: string | undefined, t: Messages): string {
    return author === undefined ? t.common.youQuoted : nameOf(agents, author);
}
/**
 * The message a reply answers, above the reply: a link to it while it is in
 * its feed — in this tab or another — and a note once it is gone. The jump is
 * a button laid over the whole quote, not around it: links of the quoted text
 * cannot sit inside a button, so they sit above it.
 */
function QuoteLink({ quote, agents, colors, actions }: { readonly quote: Quote; readonly actions: QuoteActions } & Names) {
    const t = useT();
    const who = authorName(agents, quote.author, t);
    const className = `quote ${quote.author === undefined ? '' : 'quote-agent'} ${colorOf(colors, quote.author)}`;
    if (!actions.hasQuoted(quote)) {
        return (
            <div className={`${className} quote-gone`}>
                <span className="quote-who">&gt; {who}</span>
                <span className="quote-text">{t.message.gone}</span>
            </div>
        );
    }
    return (
        <div className={`${className} quote-link`}>
            <button type="button" className="quote-jump" onClick={() => actions.onOpenQuote(quote)} aria-label={t.message.jump(who)} />
            <span className="quote-who">&gt; {who}</span>
            <span className="quote-text"><LinkedText text={quote.text} /></span>
        </div>
    );
}
/** The message a reply being written answers, above the field; Cancel drops the reply, not the words. */
function ReplyPreview({ quote, agents, colors, onCancel }: { readonly quote: Quote; readonly onCancel: () => void } & Names) {
    const t = useT();
    const who = authorName(agents, quote.author, t);
    return (
        <div className="composer-reply">
            <div className={`quote ${quote.author === undefined ? '' : 'quote-agent'} ${colorOf(colors, quote.author)}`}>
                <span className="quote-who">&gt; {who}</span>
                <span className="quote-text"><LinkedText text={quote.text} /></span>
            </div>
            <button type="button" className="btn btn-ghost btn-xs message-action" onClick={onCancel} aria-label={t.message.cancelReply(who)}>{t.common.cancel}</button>
        </div>
    );
}
/** A message sent on as it was, under a bar in the colour of whoever wrote it. */
function ForwardedBlock({ forwarded, agents, colors }: { readonly forwarded: Forwarded } & Names) {
    const t = useT();
    const who = authorName(agents, forwarded.author, t);
    return (
        <div className={`fwd ${colorOf(colors, forwarded.author)}`}>
            <div className="fwd-bar">
                <span aria-hidden="true">{t.message.forwarded} · {who}</span>
                <span className="visually-hidden">{t.message.forwardedFrom(who)}</span>
            </div>
            <div className="text"><LinkedText text={forwarded.text} /></div>
        </div>
    );
}
/** The quote a reply answers, the words of the message, and what it forwards, in that order. */
function MessageBody({ item, agents, colors, actions }: { readonly item: MessageItem; readonly actions: QuoteActions } & Names) {
    return (
        <>
            {item.replyTo === undefined ? null : <QuoteLink quote={item.replyTo} agents={agents} colors={colors} actions={actions} />}
            {item.text === '' && item.forwarded !== undefined ? null : <div className="text"><LinkedText text={item.text} /></div>}
            {item.forwarded === undefined ? null : <ForwardedBlock forwarded={item.forwarded} agents={agents} colors={colors} />}
        </>
    );
}
/**
 * A message one agent sent another, as an envelope: a bar in the colour of
 * the sender says who wrote to whom. In the tab of the receiver it stands on
 * the person's side — it came in as a person's message would — and in the tab
 * of the sender on the agent's.
 */
function Envelope({ peer, ...props }: MessageProps & { readonly peer: string }) {
    const { item, agentId, agentName, agents, colors } = props;
    const incoming = item.role === 'user';
    const from = incoming ? nameOf(agents, peer) : agentName;
    const to = incoming ? agentName : nameOf(agents, peer);
    const t = useT();
    return (
        <div className={`item message message-${item.role} ${incoming ? 'message-peer' : 'message-sent'} agent-color-${colors[incoming ? peer : agentId] ?? 0}`}>
            <div className="envelope-bar">
                <span aria-hidden="true">{from} → {to}</span>
                <span className="visually-hidden">{t.common.fromTo(from, to)}</span>
            </div>
            <div className="envelope-body"><MessageBody {...props} /></div>
        </div>
    );
}
function Bubble(props: MessageProps) {
    const { item, agentName } = props;
    const peer = item.role === 'user' ? item.from : item.to;
    const t = useT();
    if (peer !== undefined) {
        return <Envelope peer={peer} {...props} />;
    }
    return (
        <div className={`item message message-${item.role}`}>
            <div className="item-label">{item.role === 'user' ? t.common.you : agentName}</div>
            <MessageBody {...props} />
        </div>
    );
}
type Outcome = { readonly text: string; readonly error: boolean };
/** The agents a message can go on to: all but the one whose tab this is. */
function ForwardPicker({ agentId, agents, colors, onPick, onClose }: Pick<MessageProps, 'agentId' | 'agents' | 'colors'> & {
    readonly onPick: (to: AgentSummary) => void;
    readonly onClose: () => void;
}) {
    const others = agents.filter((agent) => agent.id !== agentId);
    const t = useT();
    return (
        <div className="forward-picker" role="group" aria-label={t.message.forwardTo}>
            <span className="forward-label">{t.message.forwardTo}</span>
            {others.length === 0 ? <span className="muted">{t.message.noOther}</span> : null}
            {others.map((agent) => (
                <button key={agent.id} type="button" className={`btn btn-xs forward-target agent-color-${colors[agent.id] ?? 0}`} onClick={() => onPick(agent)}>
                    {agent.name}
                </button>
            ))}
            <button type="button" className="btn btn-ghost btn-xs message-action" onClick={onClose}>{t.common.cancel}</button>
        </div>
    );
}
function useForward(item: MessageItem, agentId: string, onForward: MessageActions['onForward']) {
    const [picking, setPicking] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>();
    const t = useT();
    const forward = (to: AgentSummary): void => {
        setPicking(false);
        setOutcome(undefined);
        onForward(to.id, forwardOf(item, agentId)).then(
            () => setOutcome({ text: t.message.forwardedTo(to.name), error: false }),
            (error: unknown) => setOutcome({ text: errorText(error, t), error: true })
        );
    };
    return { picking, setPicking, outcome, forward };
}
/**
 * Reply and Forward: a small bar on the corner of the message, shown on hover
 * and on focus, and always on a touch screen. The list of agents to forward to
 * and how the forward went show under the message, and stay.
 */
function MessageToolbar({ item, agentId, agents, colors, actions }: MessageProps) {
    const { picking, setPicking, outcome, forward } = useForward(item, agentId, actions.onForward);
    const t = useT();
    return (
        <>
            <div className="message-actions" role="group" aria-label={t.message.actions}>
                <button type="button" className="btn btn-ghost btn-xs message-action" onClick={() => actions.onReply(quoteOf(item, agentId))}>{t.message.reply}</button>
                <button type="button" className="btn btn-ghost btn-xs message-action" aria-expanded={picking} onClick={() => setPicking(!picking)}>{t.message.forward}</button>
            </div>
            {picking ? <ForwardPicker agentId={agentId} agents={agents} colors={colors} onPick={forward} onClose={() => setPicking(false)} /> : null}
            {outcome === undefined ? null : <span className={`message-outcome ${outcome.error ? 'error' : 'note'}`} role={outcome.error ? 'alert' : 'status'}>{outcome.text}</span>}
        </>
    );
}
/** One message of the feed with what can be done with it. */
function Message(props: MessageProps) {
    const { item } = props;
    return (
        <div className={`message-row message-row-${item.role}`} data-seq={item.seq}>
            <Bubble {...props} />
            <MessageToolbar {...props} />
        </div>
    );
}
export { Message, MessageBody, ReplyPreview };
export type { MessageActions, MessageProps, QuoteActions };
