import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { FeedItem } from '../feed.js';
import { LinkedText } from './LinkedText.js';
import { useI18n } from '../i18n/I18n.js';
import type { Format } from '../i18n/format.js';
type DelegationItem = FeedItem & { kind: 'delegation' };
type DelegationCardProps = {
    readonly item: DelegationItem;
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
};
function nameOf(agents: readonly AgentSummary[], id: string): string {
    return agents.find((agent) => agent.id === id)?.name ?? id;
}
/** A deadline in the local time of the reader, written the way the language of the page writes it; as written when it is not a time. */
function dueText(deadline: string, format: Format): string {
    const time = new Date(deadline);
    return Number.isNaN(time.getTime()) ? deadline : format.dateTime(time);
}
/** The task, its deadline, and the result or the reason once it is over. */
function DelegationBody({ item }: { readonly item: DelegationItem }) {
    const { messages: t, format } = useI18n();
    return (
        <div className="envelope-body">
            <div className="text"><LinkedText text={item.text} /></div>
            {item.deadline === undefined ? null : <div className="delegation-due">{t.delegation.due(dueText(item.deadline, format))}</div>}
            {item.result === undefined
                ? null
                : (
                    <div className="delegation-result">
                        <div className="item-label">{t.delegation.outcome[item.state]}</div>
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
    const t = useI18n().messages;
    const state = t.delegation.state[item.state];
    return (
        <div
            className={`item message delegation delegation-${item.state} agent-color-${colors[item.from] ?? 0}`}
            role="group"
            aria-label={t.delegation.label(from, to, state)}
        >
            <div className="envelope-bar delegation-bar">
                <span aria-hidden="true">{t.delegation.task} · {from} → {to}</span>
                <span className="delegation-state">{state}</span>
            </div>
            <DelegationBody item={item} />
        </div>
    );
}
export { DelegationCard };
