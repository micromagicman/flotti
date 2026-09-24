import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { FeedItem } from '../feed.js';
import { LinkedText } from './LinkedText.js';
type DelegationItem = FeedItem & { kind: 'delegation' };
type DelegationCardProps = {
    readonly item: DelegationItem;
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
};
function nameOf(agents: readonly AgentSummary[], id: string): string {
    return agents.find((agent) => agent.id === id)?.name ?? id;
}
/** What the line above the result says, by how the task ended. */
const OUTCOME: Record<DelegationItem['state'], string> = {
    working: 'Working',
    completed: 'Result',
    failed: 'Why it failed',
    canceled: 'Why it was canceled'
};
/** A deadline in the local time of the reader; as written when it is not a time. */
function dueText(deadline: string): string {
    const time = new Date(deadline);
    return Number.isNaN(time.getTime()) ? deadline : time.toLocaleString();
}
/** The task, its deadline, and the result or the reason once it is over. */
function DelegationBody({ item }: { readonly item: DelegationItem }) {
    return (
        <div className="envelope-body">
            <div className="text"><LinkedText text={item.text} /></div>
            {item.deadline === undefined ? null : <div className="delegation-due">due by {dueText(item.deadline)}</div>}
            {item.result === undefined
                ? null
                : (
                    <div className="delegation-result">
                        <div className="item-label">{OUTCOME[item.state]}</div>
                        <div className="text"><LinkedText text={item.result} /></div>
                    </div>
                )}
        </div>
    );
}
/**
 * A task one agent gave another, in the tabs of both: an envelope in the
 * colour of the agent that gave it, saying who gave it to whom and where it
 * stands, with the result or the reason once it is over (#51).
 */
function DelegationCard({ item, agents, colors }: DelegationCardProps) {
    const from = nameOf(agents, item.from);
    const to = nameOf(agents, item.to);
    return (
        <div
            className={`item message delegation delegation-${item.state} agent-color-${colors[item.from] ?? 0}`}
            role="group"
            aria-label={`Task from ${from} to ${to}: ${item.state}`}
        >
            <div className="envelope-bar delegation-bar">
                <span aria-hidden="true">task · {from} → {to}</span>
                <span className="delegation-state">{item.state}</span>
            </div>
            <DelegationBody item={item} />
        </div>
    );
}
export { DelegationCard };
