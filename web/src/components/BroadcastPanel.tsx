import { useState } from 'react';
import type { AgentSummary, Delivery } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import { Composer } from './Composer.js';
import { StatusBadge } from './StatusBadge.js';
type BroadcastPanelProps = {
    readonly agents: readonly AgentSummary[];
    /** Late outcomes of queued messages, from the socket. */
    readonly deliveries: readonly Delivery[];
    readonly empty: boolean;
    /** Opens the settings, where agents are added. */
    readonly onSettings: () => void;
};
const RESULT_TEXT: Readonly<Record<Delivery['result'], string>> = {
    taken: 'delivered',
    queued: 'queued: the agent is busy',
    failed: 'failed'
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
    return (
        <ul className="deliveries" aria-label="Delivery">
            {sent.map((first) => {
                const delivery = first.result === 'queued' ? late.findLast((next) => next.agentId === first.agentId) ?? first : first;
                const name = agents.find((agent) => agent.id === delivery.agentId)?.name ?? delivery.agentId;
                return (
                    <li key={delivery.agentId} className={`delivery delivery-${delivery.result}`} data-agent={delivery.agentId}>
                        <span className="delivery-name">{name}</span>
                        <span className="delivery-result">{RESULT_TEXT[delivery.result]}{delivery.error === undefined ? '' : `: ${delivery.error}`}</span>
                    </li>
                );
            })}
        </ul>
    );
}
type Sent = { readonly deliveries: readonly Delivery[]; readonly after: number };
function NoAgents({ onSettings }: { readonly onSettings: () => void }) {
    return (
        <section className="broadcast">
            <h1>No agents yet</h1>
            <p className="muted">Add the first one in the settings.</p>
            <div className="actions"><button type="button" className="primary" onClick={onSettings}>Open settings</button></div>
        </section>
    );
}
function Targets({ agents, excluded, toggle }: { readonly agents: readonly AgentSummary[]; readonly excluded: ReadonlySet<string>; readonly toggle: (id: string) => void }) {
    return (
        <fieldset className="targets">
            <legend>Send to</legend>
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
    return (
        <Composer
            label="Message to all agents"
            placeholder="Message the fleet…"
            submitLabel={`Send to ${targets.length} agent${targets.length === 1 ? '' : 's'}`}
            disabled={targets.length === 0}
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
    const targets = agents.filter((agent) => !excluded.has(agent.id));
    if (empty) {
        return <NoAgents onSettings={onSettings} />;
    }
    return (
        <section className="broadcast" aria-label="Broadcast">
            <h1>Message all agents</h1>
            <p className="muted">Each agent gets the message on its own; the answers come in its tab.</p>
            <Targets agents={agents} excluded={excluded} toggle={toggle} />
            <BroadcastComposer targets={targets} deliveries={deliveries} onSent={setSent} />
            {sent === undefined ? null : <Results sent={sent.deliveries} late={deliveries.slice(sent.after)} agents={agents} />}
        </section>
    );
}
export { BroadcastPanel };
