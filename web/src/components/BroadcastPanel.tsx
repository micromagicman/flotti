import { useState } from 'react';
import type { AgentSummary, Delivery } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import { Composer } from './Composer.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../i18n/I18n.js';
type BroadcastPanelProps = {
    readonly agents: readonly AgentSummary[];
    /** Late outcomes of queued messages, from the socket. */
    readonly deliveries: readonly Delivery[];
    readonly empty: boolean;
    /** Opens the settings, where agents are added. */
    readonly onSettings: () => void;
};
/** Agents taken out of the broadcast; everyone else gets it. */
function useExcluded(): [ReadonlySet<string>, (id: string) => void] {
    const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
    return [excluded, (id) => setExcluded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) {
            next.add(id);
        }
        return next;
    })];
}
function Results({ sent, late, agents }: { readonly sent: readonly Delivery[]; readonly late: readonly Delivery[]; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    return (
        <ul className="deliveries" aria-label={t.broadcast.delivery}>
            {sent.map((first) => <DeliveryLine key={first.agentId} delivery={latest(first, late)} agents={agents} />)}
        </ul>
    );
}
/** How a delivery ended: one that went into line ends with what became of it later. */
function latest(first: Delivery, late: readonly Delivery[]): Delivery {
    return first.result === 'queued' ? late.findLast((next) => next.agentId === first.agentId) ?? first : first;
}
function DeliveryLine({ delivery, agents }: { readonly delivery: Delivery; readonly agents: readonly AgentSummary[] }) {
    const t = useT();
    const name = agents.find((agent) => agent.id === delivery.agentId)?.name ?? delivery.agentId;
    return (
        <li className={`delivery delivery-${delivery.result}`} data-agent={delivery.agentId}>
            <span className="delivery-name">{name}</span>
            <span className="delivery-result">{t.broadcast.result[delivery.result]}{delivery.error === undefined ? '' : `: ${delivery.error}`}</span>
        </li>
    );
}
type Sent = { readonly deliveries: readonly Delivery[]; readonly after: number };
function NoAgents({ onSettings }: { readonly onSettings: () => void }) {
    const t = useT();
    return (
        <section className="broadcast">
            <h1>{t.broadcast.noAgents}</h1>
            <p className="muted">{t.broadcast.addFirst}</p>
            <div className="actions"><button type="button" className="btn btn-primary" onClick={onSettings}>{t.broadcast.openSettings}</button></div>
        </section>
    );
}
function Targets({ agents, excluded, toggle }: { readonly agents: readonly AgentSummary[]; readonly excluded: ReadonlySet<string>; readonly toggle: (id: string) => void }) {
    const t = useT();
    return (
        <fieldset className="targets">
            <legend>{t.broadcast.sendTo}</legend>
            {agents.map((agent) => (
                <label key={agent.id} className="target">
                    <input type="checkbox" checked={!excluded.has(agent.id)} onChange={() => toggle(agent.id)} />
                    <span>{agent.name}</span>
                    <StatusBadge status={agent.status} />
                </label>
            ))}
        </fieldset>
    );
}
function BroadcastComposer({ targets, deliveries, onSent }: { readonly targets: readonly AgentSummary[]; readonly deliveries: readonly Delivery[]; readonly onSent: (sent: Sent) => void }) {
    const t = useT();
    return (
        <Composer
            label={t.broadcast.fieldLabel}
            placeholder={t.broadcast.placeholder}
            submitLabel={t.common.send}
            disabled={targets.length === 0}
            state={<span className="badge composer-count">{t.broadcast.selected(targets.length)}</span>}
            onSend={async (text) => {
                const after = deliveries.length;
                const answer = await api.broadcast(text, targets.map((agent) => agent.id));
                onSent({ deliveries: answer.deliveries, after });
                return undefined;
            }}
        />
    );
}
/** One message to many agents at once; the answers come in each agent's own tab. */
function BroadcastPanel({ agents, deliveries, empty, onSettings }: BroadcastPanelProps) {
    const [excluded, toggle] = useExcluded();
    const [sent, setSent] = useState<Sent>();
    const t = useT();
    const targets = agents.filter((agent) => !excluded.has(agent.id));
    if (empty) {
        return <NoAgents onSettings={onSettings} />;
    }
    return (
        <section className="broadcast" aria-label={t.broadcast.label}>
            <h1>{t.broadcast.title}</h1>
            <p className="muted">{t.broadcast.lead}</p>
            <Targets agents={agents} excluded={excluded} toggle={toggle} />
            <BroadcastComposer targets={targets} deliveries={deliveries} onSent={setSent} />
            {sent === undefined ? null : <Results sent={sent.deliveries} late={deliveries.slice(sent.after)} agents={agents} />}
        </section>
    );
}
export { BroadcastPanel };
