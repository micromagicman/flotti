import { useEffect, useState } from 'react';
import type { JSX, RefObject } from 'react';
import type { Quote } from '../../../src/agent-events.js';
import type { AgentSummary, Delivery, GroupMessage, GroupSummary } from '../../../src/dashboard-protocol.js';
import { groupTabId } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { api } from '../api.js';
import { groupMessageKey, laneItem, outcomeOf, quotedInLane, taskOf, tookNames } from '../groups.js';
import type { GroupFeed, Took } from '../groups.js';
import { GroupMarks, Member, nameOf } from './AgentMark.js';
import { Composer } from './Composer.js';
import { DelegationCard } from './DelegationCard.js';
import { GroupEdit } from './GroupEdit.js';
import { usePinnedScroll } from './Feed.js';
import { MessageBody, MessageToolbar, ReplyPreview } from './Message.js';
import type { MessageActions, QuoteActions } from './Message.js';
import { useT } from '../i18n/I18n.js';
import type { Messages } from '../i18n/en.js';
type Fleet = {
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
};
type GroupPanelProps = Fleet & {
    readonly group: GroupSummary;
    /** Undefined until the history of the group has come. */
    readonly feed: GroupFeed | undefined;
    /** Where a quote leads when the quoted message is not in the lane: the tab of an agent. */
    readonly quotes: QuoteActions;
    /** Opens the tab of a mentioned agent (0.7.0, #174). */
    readonly onOpenAgent: (id: string) => void;
    /** The group was deleted from its editor (#175): the page leaves the tab. */
    readonly onDeleted: () => void;
};
/** A message to bring into view in the lane; `n` tells one ask from the next. */
type Found = { readonly key: string; readonly n: number };
/** The lane of a group whose history has not come: one and the same, so the lane does not scroll on every render. */
const NO_MESSAGES: readonly GroupMessage[] = [];
/** The key of the lane message a quote points at; nothing when the lane does not have it. */
function laneKey(messages: readonly GroupMessage[], groupId: string, quote: Quote): string | undefined {
    const found = quotedInLane(messages, groupId, quote);
    return found === undefined ? undefined : groupMessageKey(found);
}
/** A quote leads to its message in the lane when the lane has it, else to the tab it is in. */
function useLaneQuotes(messages: readonly GroupMessage[], groupId: string, quotes: QuoteActions) {
    const [found, setFound] = useState<Found>();
    const actions: QuoteActions = {
        hasQuoted: (quote) => laneKey(messages, groupId, quote) !== undefined || quotes.hasQuoted(quote),
        onOpenQuote: (quote) => {
            const key = laneKey(messages, groupId, quote);
            if (key === undefined) {
                quotes.onOpenQuote(quote);
            } else {
                setFound((last) => ({ key, n: (last?.n ?? 0) + 1 }));
            }
        }
    };
    return { actions, found };
}
/** Brings the message into view and flashes it, as a quote does in the tab of an agent. */
function useFound(list: RefObject<HTMLDivElement | null>, found: Found | undefined) {
    useEffect(() => {
        const target = foundElement(list.current, found);
        if (target !== null) {
            flash(target);
        }
    }, [list, found]);
}
function foundElement(list: HTMLDivElement | null, found: Found | undefined): HTMLElement | null {
    return found === undefined ? null : list?.querySelector<HTMLElement>(`[data-key="${CSS.escape(found.key)}"]`) ?? null;
}
function flash(target: HTMLElement): void {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    target.classList.remove('message-found');
    void target.offsetWidth;
    target.classList.add('message-found');
}
/** The three ways a message was taken, each with its words. */
const TOOK_WORDS: readonly (readonly [keyof Took, (t: Messages) => (names: string) => string])[] = [
    ['taken', (t) => t.group.gotIt], ['queued', (t) => t.group.inLine], ['failed', (t) => t.group.failed]
];
/** In words: who got the message, who has it in line, who never did — «Builder, Reviewer got it · Tester failed». */
function tookWords(deliveries: readonly Delivery[], agents: readonly AgentSummary[], t: Messages): string {
    const took = tookNames(deliveries, (id) => nameOf(agents, id));
    const words = TOOK_WORDS.filter(([result]) => took[result].length > 0).map(([result, say]) => say(t)(took[result].join(', ')));
    return words.length === 0 ? t.group.nobody : words.join(' · ');
}
/** The line under a message: who took it, folded; open, the list of the broadcast page. */
function Took({ deliveries, agents }: { readonly deliveries: readonly Delivery[]; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    return (
        <details className="took">
            <summary>{tookWords(deliveries, agents, t)}</summary>
            <ul className="deliveries" aria-label={t.group.took}>
                {deliveries.map((delivery) => <DeliveryLine key={delivery.agentId} delivery={delivery} agents={agents} />)}
            </ul>
        </details>
    );
}
function DeliveryLine({ delivery, agents }: { readonly delivery: Delivery; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    return (
        <li className={`delivery delivery-${delivery.result}`} data-agent={delivery.agentId}>
            <span className="delivery-name">{nameOf(agents, delivery.agentId)}</span>
            <span className="delivery-result">{t.broadcast.result[delivery.result]}{delivery.error === undefined ? '' : `: ${delivery.error}`}</span>
        </li>
    );
}
type RowProps = Fleet & { readonly message: GroupMessage; readonly messages: readonly GroupMessage[]; readonly group: GroupSummary; readonly actions: MessageActions };
/** What the bar adds after who wrote it: «answer» when flotti posted it for the member, how the task ended on the line of an outcome (#171). */
function barMark(message: GroupMessage, t: Messages): string {
    const outcome = outcomeOf(message);
    if (outcome !== undefined) {
        return ` · ${t.delegation.task} ${t.delegation.state[outcome]}`;
    }
    return message.turnAnswer === true ? ` · ${t.group.answer}` : '';
}
/** The bar of an agent's message: who wrote it → the group, and what kind of message it is. */
function EnvelopeBar({ message, group, agents }: Pick<RowProps, 'message' | 'group' | 'agents'> & { readonly message: GroupMessage & { readonly from: string } }) {
    const t = useT();
    const from = nameOf(agents, message.from);
    const answer = message.turnAnswer === true;
    return (
        <div className="envelope-bar">
            <span aria-hidden="true">{t.group.toGroup(from, group.name)}{barMark(message, t)}</span>
            <span className="visually-hidden">{answer ? t.group.answerFromTo(from, group.name) : t.common.fromTo(from, group.name)}</span>
        </div>
    );
}
/** The message itself: the person's, an agent's envelope, or the card of a task given in the group (#171), as the task stands now. */
function LaneMessage({ message, messages, group, actions, agents, colors }: RowProps) {
    const t = useT();
    const item = laneItem(message);
    const task = taskOf(messages, message);
    const from = message.from;
    if (task !== undefined) {
        return <DelegationCard item={{ kind: 'delegation', key: item.key, ...task }} agents={agents} colors={colors} />;
    }
    return from === undefined
        ? <div className="item message message-user"><div className="item-label">{t.common.you}</div><MessageBody item={item} agents={agents} colors={colors} actions={actions} /></div>
        : <div className={`item message message-agent message-peer agent-color-${colors[from] ?? 0}`}>
            <EnvelopeBar message={{ ...message, from }} group={group} agents={agents} />
            <div className="envelope-body"><MessageBody item={item} agents={agents} colors={colors} actions={actions} /></div>
        </div>;
}
/** One message of the lane (#152): the person's on the right, an agent's as an envelope on the left; under it, how the members took it. */
function LaneRow(props: RowProps) {
    const { message, group, actions, agents, colors } = props;
    const item = laneItem(message);
    const tab = groupTabId(group.id);
    return (
        <div className={`message-row${message.from === undefined ? ' message-row-user' : ''}`} data-key={item.key}>
            <LaneMessage {...props} />
            <MessageToolbar item={item} agentId={tab} agentName={group.name} agents={agents} colors={colors} actions={actions} />
            <Took deliveries={message.deliveries} agents={agents} />
        </div>
    );
}
type LaneProps = Fleet & Pick<GroupPanelProps, 'group'> & { readonly messages: readonly GroupMessage[]; readonly actions: MessageActions; readonly found: Found | undefined };
function Lane({ group, messages, actions, found, ...fleet }: LaneProps) {
    const { list, onScroll } = usePinnedScroll(messages);
    useFound(list, found);
    const t = useT();
    return (
        <div className="feed lane-group" role="log" aria-label={t.group.of(group.name)} ref={list} onScroll={onScroll}>
            {messages.length === 0 ? <p className="muted empty">{t.group.notYet(group.name)}</p> : null}
            {messages.map((message) => <LaneRow key={message.seq} message={message} messages={messages} group={group} actions={actions} {...fleet} />)}
        </div>
    );
}
/**
 * The header of the tab in one line, like the agent's (#102): the marks and
 * the name, the members by mark and name — one not in the fleet in grey —
 * and Edit; the topic on a second line. No stripe: a group has no one colour.
 */
type HeaderProps = Fleet & Pick<GroupPanelProps, 'group'> & { readonly editing: boolean; readonly onEdit: () => void };
function GroupHeader({ group, agents, colors, editing, onEdit }: HeaderProps) {
    const t = useT();
    return (
        <header className="agent-header group-header">
            <div className="agent-title">
                <h1><GroupMarks members={group.members} agents={agents} colors={colors} /><span className="agent-name">{group.name}</span></h1>
            </div>
            <div className="group-members">{group.members.map((id) => <Member key={id} id={id} agents={agents} colors={colors} />)}</div>
            <div className="header-actions">
                <button type="button" className="btn btn-sm" title={t.group.editHint} aria-pressed={editing} disabled={editing} onClick={onEdit}>{t.common.edit}</button>
            </div>
            {group.topic === undefined ? null : <p className="group-topic" title={group.topic}>{group.topic}</p>}
        </header>
    );
}
/** The reply being written, if any, and what the messages of the lane can do: Reply quotes into the composer, Forward sends to an agent. */
function useMessaging(quotes: QuoteActions, onOpenAgent: (id: string) => void, t: Messages) {
    const [reply, setReply] = useState<Quote>();
    const actions: MessageActions = {
        ...quotes,
        onOpenAgent,
        onReply: setReply,
        onForward: async (to, forwarded) => {
            const delivery = await api.send(to, '', { forwarded });
            if (delivery.result === 'failed') {
                throw new Error(delivery.error ?? t.errors.notDelivered);
            }
        }
    };
    return { reply, setReply, actions };
}
type ComposerProps = Fleet & Pick<GroupPanelProps, 'group'> & { readonly messaging: ReturnType<typeof useMessaging> };
/** The words of the composer: a message to the group, or a reply to a message of its lane. */
function composerWords(replying: boolean, name: string, t: Messages): { readonly label: string; readonly placeholder: string; readonly submitLabel: string } {
    return {
        label: replying ? t.agent.replyTo(name) : t.group.messageTo(name),
        placeholder: replying ? t.agent.replyPlaceholder : t.group.messagePlaceholder(name),
        submitLabel: replying ? t.agent.reply : t.common.send
    };
}
/** The reply being written, above the field, with Cancel; nothing when none is. */
function replyAbove({ reply, setReply }: ReturnType<typeof useMessaging>, fleet: Fleet): { readonly key: string; readonly node: JSX.Element } | undefined {
    if (reply === undefined) {
        return undefined;
    }
    return { key: `${reply.agentId}/${reply.messageId}`, node: <ReplyPreview quote={reply} {...fleet} onCancel={() => setReply(undefined)} /> };
}
/** The members of the group, by id and name, as the `@` picker offers them. */
function membersOf(group: GroupSummary, agents: readonly AgentSummary[]): readonly { id: string; name: string }[] {
    return group.members.map((id) => ({ id, name: nameOf(agents, id) }));
}
/** The composer of the agent's tab, with the members in place of the status: Enter sends to the group, Reply quotes, `@` mentions. */
function GroupComposer({ group, agents, colors, messaging }: ComposerProps) {
    const { reply, setReply } = messaging;
    const t = useT();
    const send = async (text: string): Promise<undefined> => {
        await api.sendToGroup(group.id, text, reply === undefined ? {} : { replyTo: reply });
        setReply(undefined);
        return undefined;
    };
    return (
        <Composer
            {...composerWords(reply !== undefined, group.name, t)}
            onSend={send}
            above={replyAbove(messaging, { agents, colors })}
            onEscape={reply === undefined ? undefined : () => setReply(undefined)}
            state={<span className="badge composer-count">{t.group.members(group.members.length)}</span>}
            mentions={membersOf(group, agents)}
            colors={colors}
        />
    );
}
/**
 * The tab of a group (docs/groups.md, #152): the header, one lane of what was
 * said in it — the person's messages, the agents' messages, the answers marked
 * as answers, how the members took each one — and a composer at the foot.
 * Edit in the header puts the editor of the group over the lane (#175).
 */
function GroupPanel({ group, feed, quotes, onOpenAgent, onDeleted, agents, colors }: GroupPanelProps) {
    const t = useT();
    const [editing, setEditing] = useState(false);
    const messages = feed?.messages ?? NO_MESSAGES;
    const messaging = useMessaging(quotes, onOpenAgent, t);
    const { actions, found } = useLaneQuotes(messages, group.id, messaging.actions);
    const fleet = { agents, colors };
    return (
        <section className="agent-panel group-panel" aria-label={t.group.of(group.name)}>
            <GroupHeader group={group} editing={editing} onEdit={() => setEditing(true)} {...fleet} />
            {editing
                ? <GroupEdit group={group} agents={agents} onDone={() => setEditing(false)} onDeleted={onDeleted} />
                : <>
                    <Lane group={group} messages={messages} actions={{ ...messaging.actions, ...actions }} found={found} {...fleet} />
                    <GroupComposer group={group} messaging={messaging} {...fleet} />
                </>}
        </section>
    );
}
export { GroupPanel };
