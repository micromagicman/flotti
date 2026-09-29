import { useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type { AgentStatus } from '../../../src/agent-events.js';
import type { AgentSummary, GroupSummary } from '../../../src/dashboard-protocol.js';
import { groupTabId } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { shownInSidebar } from '../conversations.js';
import type { Conversation } from '../conversations.js';
import type { AgentFeed } from '../feed.js';
import { FLEET_FEED_SIZE } from '../fleet-feed.js';
import type { GroupFeed } from '../groups.js';
import { AgentMark, GroupMarks, PairMarks, nameOf } from './AgentMark.js';
import { PoorConnectionMark } from './ConnectionHealth.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import { SECTIONS, groupLastSeq, hasUnread, markerDot, markerOf, sectionForKey, statusOf } from '../sidebar-sections.js';
import type { Marker, Section } from '../sidebar-sections.js';
/** How many conversations the sidebar lists by name; the rest are in the list of them all. */
const CONVERSATIONS_SHOWN = 4;
type SidebarProps = {
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    readonly colors: AgentColors;
    readonly conversations: readonly Conversation[];
    /** The groups of the fleet (docs/groups.md, #152) and the history of each, by its id. */
    readonly groups: readonly GroupSummary[];
    readonly groupFeeds: Readonly<Record<string, GroupFeed>>;
    /** Puts every agent of the fleet in one group, when there is none; rejects saying why it did not. */
    readonly onEveryone: () => Promise<void>;
    /** Last event seen of each agent, of each group, and how many messages of each conversation: to mark tabs with something new. */
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
    readonly broadcastId: string;
    /** The feed of every message of the fleet (#114). */
    readonly feedId: string;
    /** Where the settings stood: the settings opened at the agents, to add one (#116). */
    readonly addAgentId: string;
    readonly conversationsId: string;
    readonly onSelect: (tab: string) => void;
    /** The section in sight (#136), and how to open another. */
    readonly section: Section;
    readonly onSection: (section: Section) => void;
};
type SideTabProps = {
    readonly className: string;
    readonly selected: boolean;
    readonly onClick: () => void;
    readonly name: string;
    readonly hint: string;
};
/** A tab that is not an agent's: the broadcast one, Add agent, the list of conversations. */
function SideTab({ className, selected, onClick, name, hint }: SideTabProps) {
    return (
        <button
            type="button"
            role="tab"
            className={className}
            aria-selected={selected}
            onClick={onClick}
        >
            <span className="tab-name">{name}</span>
            <span className="tab-hint">{hint}</span>
        </button>
    );
}
type AgentTabProps = {
    readonly agent: AgentSummary;
    readonly feed: AgentFeed | undefined;
    readonly color: number | undefined;
    readonly unread: boolean;
    readonly selected: boolean;
    readonly onSelect: (tab: string) => void;
};
/** The status of the agent, and how many messages wait for it when any do. */
function TabStatus({ status, inLine }: { readonly status: AgentStatus; readonly inLine: number }) {
    const t = useT();
    return (
        <span className="tab-status">
            <StatusBadge status={status} />
            {inLine > 0 ? <span className="tab-in-line">· {t.common.inLine(inLine)}</span> : null}
        </span>
    );
}
function inLineOf(feed: AgentFeed | undefined): number {
    return feed?.queue.length ?? 0;
}
function AgentTab({ agent, feed, color, unread, selected, onSelect }: AgentTabProps) {
    const status = statusOf(agent, feed);
    const t = useT();
    return (
        <button type="button" role="tab" className={`tab tab-${status}`} aria-selected={selected} data-agent={agent.id} onClick={() => onSelect(agent.id)}>
            <span className="tab-name">
                <AgentMark color={color} />
                <span className="tab-label">{agent.name}</span>
                {unread ? <span className="unread" aria-label={t.sidebar.newOutput} /> : null}
            </span>
            <TabStatus status={status} inLine={inLineOf(feed)} /><PoorConnectionMark health={agent.health} />
        </button>
    );
}
type PairTabProps = {
    readonly conversation: Conversation;
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly unread: boolean;
    readonly selected: boolean;
    readonly onSelect: (tab: string) => void;
};
/** The tab of the conversation of two agents: both colours, both names, how many messages. */
function PairTab({ conversation, agents, colors, unread, selected, onSelect }: PairTabProps) {
    const { id, first, second, messages } = conversation;
    const title = `${nameOf(agents, first)} ↔ ${nameOf(agents, second)}`;
    const t = useT();
    return (
        <button type="button" role="tab" className="tab tab-pair" aria-selected={selected} data-pair={id} title={title}
            aria-label={t.sidebar.conversationOf(t.common.and(nameOf(agents, first), nameOf(agents, second)), messages.length)} onClick={() => onSelect(id)}>
            <span className="tab-name">
                <PairMarks first={colors[first]} second={colors[second]} />
                <span className="tab-label">{title}</span>
                {unread ? <span className="unread" aria-label={t.sidebar.newMessages} /> : null}
            </span>
            <span className="tab-hint">{t.common.messages(messages.length)}</span>
        </button>
    );
}
function lastSeqOf(feed: AgentFeed | undefined): number {
    return feed?.lastSeq ?? 0;
}
type GroupTabProps = Pick<SidebarProps, 'agents' | 'colors'> & {
    readonly group: GroupSummary;
    readonly messages: number;
    readonly unread: boolean;
    readonly selected: boolean;
    readonly onSelect: (tab: string) => void;
};
/** The tab of a group (#152): the marks of its members in a row, its name, how many members and messages. */
function GroupTab({ group, messages, unread, selected, onSelect, agents, colors }: GroupTabProps) {
    const t = useT();
    const id = groupTabId(group.id);
    return (
        <button type="button" role="tab" className="tab tab-group" aria-selected={selected} data-group={group.id} title={group.name}
            aria-label={t.sidebar.groupTab(group.name, group.members.length, messages)} onClick={() => onSelect(id)}>
            <span className="tab-name">
                <GroupMarks members={group.members} agents={agents} colors={colors} />
                <span className="tab-label">{group.name}</span>
                {unread ? <span className="unread" aria-label={t.sidebar.newMessages} /> : null}
            </span>
            <span className="tab-hint">{t.sidebar.groupHint(group.members.length, messages)}</span>
        </button>
    );
}
/** The one click that makes the group: what it is doing, or why it could not. */
function useEveryone(onEveryone: () => Promise<void>) {
    const [making, setMaking] = useState(false);
    const [error, setError] = useState<string>();
    const t = useT();
    const make = (): void => {
        setMaking(true);
        setError(undefined);
        onEveryone().catch((reason: unknown) => setError(errorText(reason, t))).finally(() => setMaking(false));
    };
    return { making, error, make };
}
/**
 * A fleet with agents but no group (docs/groups.md, open question 2): the
 * section says the agents do not see each other, and one click puts every
 * one of them in one group «Everyone». Gone as soon as a group exists.
 */
function EveryoneOffer({ onEveryone }: Pick<SidebarProps, 'onEveryone'>) {
    const { making, error, make } = useEveryone(onEveryone);
    const t = useT();
    return (
        <div className="side-empty" role="note">
            <p><b>{t.sidebar.noGroups}</b></p>
            <p className="muted">{t.sidebar.noGroupsWhy}</p>
            <button type="button" className="btn btn-sm btn-primary" disabled={making} onClick={make}>{making ? t.sidebar.makingEveryone : t.sidebar.everyone}</button>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </div>
    );
}
type GroupTabsProps = Pick<SidebarProps, 'agents' | 'colors' | 'groups' | 'groupFeeds' | 'seenSeq' | 'selected' | 'onSelect' | 'onEveryone'>;
/** Every group of the fleet; a fleet with agents but no group gets the offer instead. */
function GroupTabs({ agents, colors, groups, groupFeeds, seenSeq, selected, onSelect, onEveryone }: GroupTabsProps) {
    if (groups.length === 0 && agents.length > 0) {
        return <EveryoneOffer onEveryone={onEveryone} />;
    }
    return (
        <>
            {groups.map((group) => (
                <GroupTab key={group.id} group={group} messages={groupFeeds[group.id]?.messages.length ?? 0} agents={agents} colors={colors}
                    selected={groupTabId(group.id) === selected} onSelect={onSelect}
                    unread={hasUnread(groupTabId(group.id), selected, groupLastSeq(groupFeeds, group), seenSeq)} />
            ))}
        </>
    );
}
type ConversationTabsProps = Pick<SidebarProps, 'agents' | 'colors' | 'conversations' | 'seenSeq' | 'selected' | 'conversationsId' | 'onSelect'>;
/**
 * The newest conversations by name, then the list of them all when there are
 * more, or when there is none yet: the section is never empty.
 */
function ConversationTabs({ agents, colors, conversations, seenSeq, selected, conversationsId, onSelect }: ConversationTabsProps) {
    const shown = shownInSidebar(conversations, CONVERSATIONS_SHOWN, selected);
    const rest = conversations.length - shown.length;
    const t = useT();
    return (
        <>
            {shown.map((conversation) => (
                <PairTab key={conversation.id} conversation={conversation} agents={agents} colors={colors} selected={conversation.id === selected}
                    unread={hasUnread(conversation.id, selected, conversation.messages.length, seenSeq)} onSelect={onSelect} />
            ))}
            {rest > 0 || conversations.length === 0
                ? <SideTab className="tab tab-conversations" selected={selected === conversationsId} onClick={() => onSelect(conversationsId)}
                    name={rest > 0 ? t.sidebar.allConversations : t.sidebar.conversations} hint={t.sidebar.pairs(conversations.length)} />
                : null}
        </>
    );
}
type FleetTabsProps = Pick<SidebarProps, 'selected' | 'broadcastId' | 'feedId' | 'onSelect'>;
/** The two tabs of the whole fleet (#114): the broadcast and the feed of every message. */
function FleetTabs({ selected, broadcastId, feedId, onSelect }: FleetTabsProps) {
    const t = useT();
    return (
        <>
            <SideTab className="tab tab-broadcast tab-fleet" selected={selected === broadcastId} onClick={() => onSelect(broadcastId)} name={t.sidebar.allAgents} hint={t.sidebar.broadcast} />
            <SideTab className="tab tab-feed tab-fleet" selected={selected === feedId} onClick={() => onSelect(feedId)} name={t.sidebar.allMessages} hint={t.sidebar.allMessagesHint(FLEET_FEED_SIZE)} />
        </>
    );
}
function AgentTabs({ agents, feeds, colors, seenSeq, selected, onSelect }: Pick<SidebarProps, 'agents' | 'feeds' | 'colors' | 'seenSeq' | 'selected' | 'onSelect'>) {
    return (
        <>
            {agents.map((agent) => (
                <AgentTab key={agent.id} agent={agent} feed={feeds[agent.id]} color={colors[agent.id]} selected={agent.id === selected} onSelect={onSelect}
                    unread={hasUnread(agent.id, selected, lastSeqOf(feeds[agent.id]), seenSeq)} />
            ))}
        </>
    );
}
/** Line icons of the switch, 24 units drawn at 20 px (16 px on a phone). */
const ICONS: Readonly<Record<Section, JSX.Element>> = {
    fleet: <><path d="M3 17V11Q6.5 13 7 17Z" /><path d="M9 17V7.5Q13.5 10.5 14 17Z" /><path d="M16 17V3.5Q21 8 21.5 17Z" /><path d="M3 20.5H21.5" /></>,
    agents: <><circle cx="12" cy="8" r="4" /><path d="M4 20.5c0-4.2 3.6-6.5 8-6.5s8 2.3 8 6.5" /></>,
    groups: <><circle cx="9" cy="8" r="3.4" /><path d="M2.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6" /><circle cx="16.5" cy="9" r="2.7" /><path d="M15.8 14.4c3.3.2 5.7 2.1 5.7 5.3" /></>,
    conversations: <><path d="M3 4.5h12v8.5H8l-5 3.5z" /><path d="M11 16h6.5l3.5 3v-10h-3" /></>
};
function useSectionLabel(): (section: Section) => string {
    const t = useT();
    return (section) => ({ fleet: t.sidebar.fleet, agents: t.sidebar.agents, groups: t.sidebar.groups, conversations: t.sidebar.conversations })[section];
}
/** In words, what the dot of a closed section says. */
function markerWords(sidebar: ReturnType<typeof useT>['sidebar'], marker: Marker | undefined): string[] {
    if (marker === undefined) {
        return [];
    }
    return [
        ...(marker.waiting.length > 0 ? [sidebar.waitsForYou(marker.waiting.join(', '), marker.waiting.length)] : []),
        ...(marker.unread > 0 ? [sidebar.withNew(marker.unread)] : [])
    ];
}
function MarkerDot({ marker }: { readonly marker: Marker | undefined }) {
    const dot = markerDot(marker);
    if (dot === undefined) {
        return null;
    }
    return <span className="rail-mark" aria-hidden="true"><span className={dot === 'waiting' ? 'rail-wait' : 'unread'} /></span>;
}
type RailTabProps = {
    readonly section: Section;
    readonly open: boolean;
    readonly marker: Marker | undefined;
    readonly onSection: (section: Section) => void;
    readonly tabRef: (element: HTMLButtonElement | null) => void;
};
/** A tab of the switch: the icon over the name, the dot on the corner of the icon, the dot in words for a screen reader. */
function RailTab({ section, open, marker, onSection, tabRef }: RailTabProps) {
    const t = useT();
    const label = useSectionLabel()(section);
    return (
        <button type="button" role="tab" className="rail-tab" id={`side-tab-${section}`} data-section={section} aria-selected={open}
            aria-controls={`side-panel-${section}`} tabIndex={open ? 0 : -1} aria-label={[label, ...markerWords(t.sidebar, marker)].join(', ')}
            ref={tabRef} onClick={() => onSection(section)}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[section]}</svg>
            <span className="rail-label">{label}</span>
            <MarkerDot marker={marker} />
        </button>
    );
}
type RailProps = Pick<SidebarProps, 'section' | 'onSection' | 'agents' | 'feeds' | 'conversations' | 'groups' | 'groupFeeds' | 'seenSeq' | 'selected'>;
/**
 * The switch of the sections (#136): a rail of icons at the left edge of the
 * sidebar, a row on a phone. One stop of Tab; the arrows, Home and End move
 * along it and open the section they reach (WAI-ARIA tabs).
 */
function Rail({ section, onSection, ...input }: RailProps) {
    const t = useT();
    const tabs = useRef<Partial<Record<Section, HTMLButtonElement | null>>>({});
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const next = sectionForKey(section, event.key);
        if (next !== undefined) {
            event.preventDefault();
            onSection(next);
            tabs.current[next]?.focus();
        }
    };
    return (
        <div className="side-rail" role="tablist" aria-label={t.sidebar.sections} aria-orientation="vertical" onKeyDown={onKeyDown}>
            {SECTIONS.map((key) => (
                <RailTab key={key} section={key} open={key === section} marker={markerOf(key, section, input)} onSection={onSection}
                    tabRef={(element) => { tabs.current[key] = element; }} />
            ))}
        </div>
    );
}
/** What each section lists. */
const SECTION_TABS: Readonly<Record<Section, (props: SidebarProps) => JSX.Element>> = {
    fleet: FleetTabs, agents: AgentTabs, groups: GroupTabs, conversations: ConversationTabs
};
/** What the open section lists. */
function SectionTabs(props: SidebarProps) {
    const Tabs = SECTION_TABS[props.section];
    return <Tabs {...props} />;
}
/** The open section: its tabs, then Add agent at the foot of every one. */
function SectionList(props: SidebarProps) {
    const { section, selected, addAgentId, onSelect } = props;
    const t = useT();
    return (
        <nav className="sidebar" role="tablist" aria-label={useSectionLabel()(section)} aria-orientation="vertical">
            <SectionTabs {...props} />
            <SideTab className="tab tab-add-agent" selected={selected === addAgentId} onClick={() => onSelect(addAgentId)} name={t.sidebar.addAgent} hint={t.sidebar.addAgentHint} />
        </nav>
    );
}
function Sidebar(props: SidebarProps) {
    return (
        <aside className="side">
            <Rail {...props} />
            {SECTIONS.map((key) => (
                <div key={key} className="side-panel" role="tabpanel" id={`side-panel-${key}`} aria-labelledby={`side-tab-${key}`} hidden={key !== props.section}>
                    {key === props.section ? <SectionList {...props} /> : null}
                </div>
            ))}
        </aside>
    );
}
export { Sidebar };
