import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentFeed } from '../feed.js';
import { PoorConnectionMark } from './ConnectionHealth.js';
import { StatusBadge } from './StatusBadge.js';
type SidebarProps = {
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** Last event seen of each agent, to mark tabs with something new. */
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
    readonly broadcastId: string;
    readonly settingsId: string;
    readonly onSelect: (tab: string) => void;
};
type SideTabProps = {
    readonly className: string;
    readonly selected: boolean;
    readonly onClick: () => void;
    readonly name: string;
    readonly hint: string;
};
/** A tab that is not an agent's: the broadcast one and the settings one. */
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
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
    readonly onSelect: (tab: string) => void;
};
function AgentTab({ agent, feed, seenSeq, selected, onSelect }: AgentTabProps) {
    const status = feed?.status ?? agent.status;
    const unread = agent.id !== selected && (feed?.lastSeq ?? 0) > (seenSeq[agent.id] ?? 0);
    return (
        <button
            type="button"
            role="tab"
            className={`tab tab-${status}`}
            aria-selected={agent.id === selected}
            data-agent={agent.id}
            onClick={() => onSelect(agent.id)}
        >
            <span className="tab-name">
                {agent.name}
                {unread ? <span className="unread" aria-label="new output" /> : null}
            </span>
            <StatusBadge status={status} /><PoorConnectionMark health={agent.health} />
        </button>
    );
}
function Sidebar({ agents, feeds, seenSeq, selected, broadcastId, settingsId, onSelect }: SidebarProps) {
    return (
        <nav className="sidebar" role="tablist" aria-label="Agents" aria-orientation="vertical">
            <SideTab className="tab tab-broadcast" selected={selected === broadcastId} onClick={() => onSelect(broadcastId)} name="All agents" hint="Broadcast" />
            {agents.map((agent) => (
                <AgentTab key={agent.id} agent={agent} feed={feeds[agent.id]} seenSeq={seenSeq} selected={selected} onSelect={onSelect} />
            ))}
            <SideTab className="tab tab-settings" selected={selected === settingsId} onClick={() => onSelect(settingsId)} name="Settings" hint="Fleet and agents" />
        </nav>
    );
}
export { Sidebar };
