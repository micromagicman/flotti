import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UIEvent } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { AgentFeed } from '../feed.js';
import { FLEET_FEED_SIZE, fleetMessages, messagesOf } from '../fleet-feed.js';
import type { FleetMessage } from '../fleet-feed.js';
import type { Messages } from '../i18n/en.js';
import { AgentMark, nameOf } from './AgentMark.js';
import { useT } from '../i18n/I18n.js';
type Fleet = {
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
};
type FleetFeedPanelProps = Fleet & {
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** Opens the message where it lives: the tab of its agent, or the conversation of the two. */
    readonly onOpen: (message: FleetMessage) => void;
};
type RowProps = Fleet & { readonly message: FleetMessage; readonly onOpen: (message: FleetMessage) => void };
/** Who wrote or got a message, as a row names them: an agent by its name, a person as You. */
function nameIn(agents: readonly AgentSummary[], id: string | undefined, t: Messages): string {
    return id === undefined ? t.common.you : nameOf(agents, id);
}
/** Where a click on the message leads, in words. */
function placeName({ agents, message }: Pick<RowProps, 'agents' | 'message'>, t: Messages): string {
    const { from, to, agentId } = message;
    return from === undefined || to === undefined
        ? t.fleetFeed.tabOf(nameOf(agents, agentId))
        : t.fleetFeed.pairOf(nameOf(agents, from), nameOf(agents, to));
}
function isToday(time: Date): boolean {
    return time.toDateString() === new Date().toDateString();
}
function Who({ id, agents, colors }: Fleet & { readonly id: string | undefined }) {
    const t = useT();
    return (
        <span className="fleet-who">
            {id === undefined ? <span className="agent-mark author-person" aria-hidden="true" /> : <AgentMark color={colors[id]} />}
            {nameIn(agents, id, t)}
        </span>
    );
}
function KindTag({ message }: { readonly message: FleetMessage }) {
    const t = useT();
    return message.kind === 'message' ? null : <span className="fleet-kind">{t.fleetFeed.kind[message.kind]}</span>;
}
/** The top line of a row: who wrote to whom, what sort of message, where it opens, when. */
function RowTop({ message, ...fleet }: Omit<RowProps, 'onOpen'>) {
    const t = useT();
    const time = new Date(message.time);
    return (
        <span className="fleet-top">
            <span className="fleet-route">
                <Who id={message.from} {...fleet} /><span className="fleet-arrow">→</span><Who id={message.to} {...fleet} />
                <KindTag message={message} />
            </span>
            <span className="fleet-open"><span className="fleet-open-text">{t.fleetFeed.openIn(placeName({ agents: fleet.agents, message }, t))} </span>›</span>
            <span className="fleet-when" title={t.fleetFeed.whenFull(time)}>{t.fleetFeed.when(time, isToday(time))}</span>
        </span>
    );
}
/** One message: two lines, like a list of mail (#114). The whole row opens it; Enter too, it is a button. */
function Row({ message, onOpen, ...fleet }: RowProps) {
    const t = useT();
    const place = placeName({ agents: fleet.agents, message }, t);
    const when = t.fleetFeed.whenFull(new Date(message.time));
    return (
        <button type="button" className="fleet-row" data-key={message.key} onClick={() => onOpen(message)}
            aria-label={t.fleetFeed.row(nameIn(fleet.agents, message.from, t), nameIn(fleet.agents, message.to, t), when, place)}>
            <RowTop message={message} {...fleet} />
            <span className="fleet-text">{message.text}</span>
        </button>
    );
}
function scrollDown(element: HTMLElement | null): void {
    element?.scrollTo({ top: element.scrollHeight });
}
function atBottom(element: HTMLElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 40;
}
/** How many messages came after the one last seen at the bottom. */
function unseenAfter(messages: readonly FleetMessage[], seen: string | undefined): number {
    const index = messages.findIndex((message) => message.key === seen);
    return index < 0 ? 0 : messages.length - 1 - index;
}
/**
 * At the bottom the feed follows new messages; scrolled up, it stays where the
 * reader is and counts what came since.
 */
function useFollow(messages: readonly FleetMessage[]) {
    const list = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const last = messages.at(-1)?.key;
    const [seen, setSeen] = useState(last);
    const toBottom = (): void => {
        pinned.current = true;
        scrollDown(list.current);
        setSeen(last);
    };
    useLayoutEffect(() => (pinned.current ? toBottom() : undefined), [last]);
    const onScroll = (event: UIEvent<HTMLDivElement>): void => {
        pinned.current = atBottom(event.currentTarget);
        setSeen((before) => (pinned.current ? last : before));
    };
    return { list, onScroll, toBottom, unseen: unseenAfter(messages, seen) };
}
type ListProps = Omit<RowProps, 'message'> & { readonly messages: readonly FleetMessage[]; readonly empty: string };
function MessageList({ messages, empty, ...rest }: ListProps) {
    const t = useT();
    const { list, onScroll, toBottom, unseen } = useFollow(messages);
    return (
        <div className="fleet-list" role="log" aria-label={t.fleetFeed.log} ref={list} onScroll={onScroll}>
            <p className="fleet-cap">{t.fleetFeed.cap(FLEET_FEED_SIZE)}</p>
            {messages.length === 0 ? <p className="muted fleet-empty">{empty}</p> : null}
            {messages.map((message) => <Row key={message.key} message={message} {...rest} />)}
            {unseen > 0 ? <button type="button" className="btn btn-sm btn-primary fleet-unseen" onClick={toBottom}>{t.fleetFeed.unseen(unseen)}</button> : null}
        </div>
    );
}
type ChipsProps = Fleet & { readonly picked: string | undefined; readonly onPick: (agentId: string | undefined) => void };
/** The one filter: every agent a chip, All to see the whole fleet again. */
function AgentChips({ agents, colors, picked, onPick }: ChipsProps) {
    const t = useT();
    return (
        <div className="fleet-chips" role="group" aria-label={t.fleetFeed.filter}>
            <button type="button" className="view-tab" aria-pressed={picked === undefined} onClick={() => onPick(undefined)}>{t.fleetFeed.all}</button>
            {agents.map((agent) => (
                <button key={agent.id} type="button" className="view-tab" aria-pressed={picked === agent.id} data-agent={agent.id} onClick={() => onPick(agent.id)}>
                    <AgentMark color={colors[agent.id]} />{agent.name}
                </button>
            ))}
        </div>
    );
}
/** The agent picked in the filter, while it is in the fleet. */
function usePicked(agents: readonly AgentSummary[]) {
    const [picked, setPicked] = useState<string>();
    return [agents.some((agent) => agent.id === picked) ? picked : undefined, setPicked] as const;
}
/** Every message of the fleet in one list (#114): the latest, live, filtered by one agent. */
function FleetFeedPanel({ agents, colors, feeds, onOpen }: FleetFeedPanelProps) {
    const t = useT();
    const [picked, setPicked] = usePicked(agents);
    const ids = agents.map((agent) => agent.id).join('\n');
    const all = useMemo(() => fleetMessages(ids === '' ? [] : ids.split('\n'), feeds), [ids, feeds]);
    const shown = messagesOf(all, picked);
    const empty = picked === undefined ? t.fleetFeed.none : t.fleetFeed.noneOf(nameOf(agents, picked));
    return (
        <section className="fleet-feed" aria-label={t.fleetFeed.label}>
            <header className="fleet-head"><h1>{t.fleetFeed.title}</h1><span className="muted">{t.common.messages(shown.length)}</span></header>
            <AgentChips agents={agents} colors={colors} picked={picked} onPick={setPicked} />
            <MessageList key={picked ?? ''} messages={shown} empty={empty} agents={agents} colors={colors} onOpen={onOpen} />
        </section>
    );
}
export { FleetFeedPanel };
