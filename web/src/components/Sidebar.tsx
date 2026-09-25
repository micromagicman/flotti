import type { AgentStatus } from '../../../src/agent-events.js';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { shownInSidebar } from '../conversations.js';
import type { Conversation } from '../conversations.js';
import type { AgentFeed } from '../feed.js';
import { AgentMark, PairMarks, nameOf } from './AgentMark.js';
import { PoorConnectionMark } from './ConnectionHealth.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../i18n/I18n.js';
/** How many conversations the sidebar lists by name; the rest are in the list of them all. */
const CONVERSATIONS_SHOWN = 4;
type SidebarProps = {
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    readonly colors: AgentColors;
    readonly conversations: readonly Conversation[];
    /** Last event seen of each agent, and how many messages of each conversation: to mark tabs with something new. */
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
    readonly broadcastId: string;
    /** Where the settings stood: the settings opened at the agents, to add one (#116). */
    readonly addAgentId: string;
    readonly conversationsId: string;
    readonly onSelect: (tab: string) => void;
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
function AgentTab({ agent, feed, color, unread, selected, onSelect }: AgentTabProps) {
    const status = feed?.status ?? agent.status;
    const t = useT();
    return (
        <button type="button" role="tab" className={`tab tab-${status}`} aria-selected={selected} data-agent={agent.id} onClick={() => onSelect(agent.id)}>
            <span className="tab-name">
                <AgentMark color={color} />
                <span className="tab-label">{agent.name}</span>
                {unread ? <span className="unread" aria-label={t.sidebar.newOutput} /> : null}
            </span>
            <TabStatus status={status} inLine={feed?.queue.length ?? 0} /><PoorConnectionMark health={agent.health} />
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
type ConversationTabsProps = Pick<SidebarProps, 'agents' | 'colors' | 'conversations' | 'seenSeq' | 'selected' | 'conversationsId' | 'onSelect'>;
/**
 * The newest conversations by name, then the list of them all when there are
 * more. On a narrow screen the list alone stays: a row of pairs would run off it.
 */
function ConversationTabs({ agents, colors, conversations, seenSeq, selected, conversationsId, onSelect }: ConversationTabsProps) {
    const shown = shownInSidebar(conversations, CONVERSATIONS_SHOWN, selected);
    const rest = conversations.length - shown.length;
    const holdsOpen = selected === conversationsId || conversations.some((conversation) => conversation.id === selected);
    const t = useT();
    return (
        <>
            <div className="side-head" aria-hidden="true">{t.sidebar.conversations}</div>
            {shown.map((conversation) => (
                <PairTab key={conversation.id} conversation={conversation} agents={agents} colors={colors} selected={conversation.id === selected}
                    unread={conversation.id !== selected && conversation.messages.length > (seenSeq[conversation.id] ?? 0)} onSelect={onSelect} />
            ))}
            <SideTab className={`tab tab-conversations${rest > 0 ? '' : ' tab-narrow-only'}${holdsOpen ? ' tab-holds-open' : ''}`} selected={selected === conversationsId}
                onClick={() => onSelect(conversationsId)} name={rest > 0 ? t.sidebar.allConversations : t.sidebar.conversations} hint={t.sidebar.pairs(conversations.length)} />
        </>
    );
}
function Sidebar({ agents, feeds, colors, conversations, seenSeq, selected, broadcastId, addAgentId, conversationsId, onSelect }: SidebarProps) {
    const t = useT();
    return (
        <nav className="sidebar" role="tablist" aria-label={t.sidebar.label} aria-orientation="vertical">
            <SideTab className="tab tab-broadcast" selected={selected === broadcastId} onClick={() => onSelect(broadcastId)} name={t.sidebar.allAgents} hint={t.sidebar.broadcast} />
            {agents.map((agent) => (
                <AgentTab key={agent.id} agent={agent} feed={feeds[agent.id]} color={colors[agent.id]} selected={agent.id === selected} onSelect={onSelect}
                    unread={agent.id !== selected && (feeds[agent.id]?.lastSeq ?? 0) > (seenSeq[agent.id] ?? 0)} />
            ))}
            {conversations.length === 0
                ? null
                : <ConversationTabs agents={agents} colors={colors} conversations={conversations} seenSeq={seenSeq} selected={selected} conversationsId={conversationsId} onSelect={onSelect} />}
            <SideTab className="tab tab-add-agent" selected={selected === addAgentId} onClick={() => onSelect(addAgentId)} name={t.sidebar.addAgent} hint={t.sidebar.addAgentHint} />
        </nav>
    );
}
export { Sidebar };
