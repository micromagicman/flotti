import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentFeed } from '../feed.js';
import { StatusBadge } from './StatusBadge.js';
type SidebarProps = {
    readonly agents: readonly AgentSummary[];
    readonly feeds: Readonly<Record<string, AgentFeed>>;
    /** Last event seen of each agent, to mark tabs with something new. */
    readonly seenSeq: Readonly<Record<string, number>>;
    readonly selected: string;
    readonly broadcastId: string;
    readonly onSelect: (tab: string) => void;
};
function Sidebar({ agents, feeds, seenSeq, selected, broadcastId, onSelect }: SidebarProps) {
    return (
        <nav className="sidebar" role="tablist" aria-label="Agents" aria-orientation="vertical">
            <button
                type="button"
                role="tab"
                className="tab tab-broadcast"
                aria-selected={selected === broadcastId}
                onClick={() => onSelect(broadcastId)}
            >
                <span className="tab-name">All agents</span>
                <span className="tab-hint">Broadcast</span>
            </button>
            {agents.map((agent) => {
                const feed = feeds[agent.id];
                const status = feed?.status ?? agent.status;
                const unread = agent.id !== selected && (feed?.lastSeq ?? 0) > (seenSeq[agent.id] ?? 0);
                return (
                    <button
                        key={agent.id}
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
                        <StatusBadge status={status} />
                    </button>
                );
            })}
        </nav>
    );
}
export { Sidebar };
