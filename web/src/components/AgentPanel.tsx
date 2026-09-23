import { useState } from 'react';
import type { Dispatch } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import { api } from '../api.js';
import type { AgentFeed } from '../feed.js';
import type { FleetAction } from '../fleet-state.js';
import { Composer } from './Composer.js';
import { Feed } from './Feed.js';
import { StatusBadge } from './StatusBadge.js';
type AgentPanelProps = {
    readonly agent: AgentSummary;
    readonly feed: AgentFeed;
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
function AgentHeader({ agent, feed }: { readonly agent: AgentSummary; readonly feed: AgentFeed }) {
    const [error, run] = useAction();
    const busy = feed.status === 'working' || feed.status === 'waiting';
    const stopped = feed.status === 'stopped' || feed.status === 'error';
    return (
        <header className="agent-header">
            <div className="agent-title">
                <h1>{agent.name}</h1>
                <span className="kind">{agent.kind === 'local' ? 'local · ACP' : 'remote · A2A'}</span>
                <StatusBadge status={feed.status} />
                {feed.reason === undefined ? null : <span className="reason">{feed.reason}</span>}
            </div>
            {agent.description === undefined ? null : <p className="description">{agent.description}</p>}
            <div className="actions">
                {busy ? <button type="button" onClick={() => run(() => api.cancel(agent.id))}>Cancel</button> : null}
                {stopped
                    ? <button type="button" onClick={() => run(() => api.start(agent.id))}>Start</button>
                    : <button type="button" onClick={() => run(() => api.stop(agent.id))}>Stop</button>}
                <button type="button" onClick={() => run(() => api.restart(agent.id))}>Restart</button>
            </div>
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </header>
    );
}
function AgentPanel({ agent, feed, dispatch }: AgentPanelProps) {
    const answer = (requestId: string, optionId?: string): void => {
        dispatch({ type: 'permission-answered', agentId: agent.id, requestId });
        void api.answerPermission(agent.id, requestId, optionId).catch(() => undefined);
    };
    return (
        <section className="agent-panel" aria-label={agent.name}>
            <AgentHeader agent={agent} feed={feed} />
            <Feed items={feed.items} agentName={agent.name} onAnswer={answer} />
            <Composer
                label={`Message to ${agent.name}`}
                placeholder={`Message ${agent.name}…`}
                submitLabel="Send"
                onSend={async (text) => {
                    const delivery = await api.send(agent.id, text);
                    if (delivery.result === 'failed') {
                        throw new Error(delivery.error ?? 'The message did not reach the agent.');
                    }
                    return delivery.result === 'queued' ? 'The agent is busy: the message waits in line.' : undefined;
                }}
            />
        </section>
    );
}
export { AgentPanel };
