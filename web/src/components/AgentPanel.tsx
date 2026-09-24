import { useState } from 'react';
import type { Dispatch } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { api } from '../api.js';
import type { AgentFeed } from '../feed.js';
import type { FleetAction } from '../fleet-state.js';
import { Composer } from './Composer.js';
import { Feed } from './Feed.js';
import { StatusBadge } from './StatusBadge.js';
type AgentPanelProps = {
    readonly agent: AgentSummary;
    readonly feed: AgentFeed;
    /** The whole fleet, and the colour of each agent: for the messages agents send one another. */
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly dispatch: Dispatch<FleetAction>;
};
/** Restart and cancel answer at once; what happens next shows in the status. */
function useAction(): [string | undefined, (action: () => Promise<unknown>) => void] {
    const [error, setError] = useState<string>();
    return [error, (action) => {
        setError(undefined);
        action().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    }];
}
/**
 * What runs the agent: claude or codex, from the adapter of its manifest. A
 * plain ACP agent and a remote one do not say, and the badge says so too.
 */
function HarnessBadge({ agent }: { readonly agent: AgentSummary }) {
    if (agent.harness !== undefined) {
        return <span className="harness" data-harness={agent.harness} title="Harness">{agent.harness}</span>;
    }
    const why = agent.kind === 'remote'
        ? 'A remote agent does not tell which harness runs it.'
        : 'The manifest names no adapter, so the harness is not known.';
    return <span className="harness harness-unknown" data-harness="unknown" title={why}>harness unknown</span>;
}
function AgentTitle({ agent, feed }: { readonly agent: AgentSummary; readonly feed: AgentFeed }) {
    return (
        <div className="agent-title">
            <h1>{agent.name}</h1>
            <span className="kind">{agent.kind === 'local' ? 'local · ACP' : 'remote · A2A'}</span>
            <HarnessBadge agent={agent} />
            <StatusBadge status={feed.status} />
            {feed.reason === undefined ? null : <span className="reason">{feed.reason}</span>}
        </div>
    );
}
function AgentActions({ agent, feed, run }: { readonly agent: AgentSummary; readonly feed: AgentFeed; readonly run: (action: () => Promise<unknown>) => void }) {
    const busy = feed.status === 'working' || feed.status === 'waiting';
    const stopped = feed.status === 'stopped' || feed.status === 'error';
    return (
        <div className="actions">
            {busy ? <button type="button" onClick={() => run(() => api.cancel(agent.id))}>Cancel</button> : null}
            {stopped
                ? <button type="button" onClick={() => run(() => api.start(agent.id))}>Start</button>
                : <button type="button" onClick={() => run(() => api.stop(agent.id))}>Stop</button>}
            <button type="button" onClick={() => run(() => api.restart(agent.id))}>Restart</button>
        </div>
    );
}
function AgentHeader({ agent, feed }: { readonly agent: AgentSummary; readonly feed: AgentFeed }) {
    const [error, run] = useAction();
    return (
        <header className="agent-header">
            <AgentTitle agent={agent} feed={feed} />
            {agent.description === undefined ? null : <p className="description">{agent.description}</p>}
            <AgentActions agent={agent} feed={feed} run={run} />
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </header>
    );
}
/** Sends the message; a queued one says so under the field, a failed one throws. */
async function sendMessage(agentId: string, text: string): Promise<string | undefined> {
    const delivery = await api.send(agentId, text);
    if (delivery.result === 'failed') {
        throw new Error(delivery.error ?? 'The message did not reach the agent.');
    }
    return delivery.result === 'queued' ? 'The agent is busy: the message waits in line.' : undefined;
}
function AgentPanel({ agent, feed, agents, colors, dispatch }: AgentPanelProps) {
    const answer = (requestId: string, optionId?: string): void => {
        dispatch({ type: 'permission-answered', agentId: agent.id, requestId });
        void api.answerPermission(agent.id, requestId, optionId).catch(() => undefined);
    };
    return (
        <section className="agent-panel" aria-label={agent.name}>
            <AgentHeader agent={agent} feed={feed} />
            <Feed items={feed.items} agentId={agent.id} agentName={agent.name} agents={agents} colors={colors} onAnswer={answer} />
            <Composer
                label={`Message to ${agent.name}`}
                placeholder={`Message ${agent.name}…`}
                submitLabel="Send"
                onSend={(text) => sendMessage(agent.id, text)}
            />
        </section>
    );
}
export { AgentPanel };
