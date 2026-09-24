import { useState } from 'react';
import type { Dispatch } from 'react';
import type { Quote } from '../../../src/agent-events.js';
import type { AgentSummary, SendRequest } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { api } from '../api.js';
import type { AgentFeed } from '../feed.js';
import type { FleetAction } from '../fleet-state.js';
import { AgentMark } from './AgentMark.js';
import { Composer } from './Composer.js';
import { ConnectionHealthView } from './ConnectionHealth.js';
import { Feed } from './Feed.js';
import type { Jump } from './Feed.js';
import type { LineActions } from './InLine.js';
import { ReplyPreview } from './Message.js';
import type { MessageActions } from './Message.js';
import { StatusBadge } from './StatusBadge.js';
type AgentPanelProps = {
    readonly agent: AgentSummary;
    readonly feed: AgentFeed;
    /** The whole fleet, and the colour of each agent: for the messages agents send one another. */
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly dispatch: Dispatch<FleetAction>;
    /** Where a quote leads: this tab or another one. */
    readonly quotes: Pick<MessageActions, 'hasQuoted' | 'onOpenQuote'>;
    readonly jump: Jump | undefined;
};
type HeaderProps = { readonly agent: AgentSummary; readonly feed: AgentFeed; readonly color: number | undefined };
/** Restart and cancel answer at once; what happens next shows in the status. */
function useAction(): [string | undefined, (action: () => Promise<unknown>) => void] {
    const [error, setError] = useState<string>();
    return [error, (action) => {
        setError(undefined);
        action().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    }];
}
/**
 * What runs the agent: claude or codex from the adapter of its manifest, or
 * whatever a remote agent names itself, shown as it is. A plain ACP agent and
 * a remote one that says nothing do not tell, and the badge says so too.
 */
function HarnessBadge({ agent }: { readonly agent: AgentSummary }) {
    if (agent.harness !== undefined) {
        return <span className="harness" data-harness={agent.harness} title="Harness">{agent.harness}</span>;
    }
    const why = agent.kind === 'remote'
        ? 'The remote agent does not say which harness runs it.'
        : 'The manifest names no adapter, so the harness is not known.';
    return <span className="harness harness-unknown" data-harness="unknown" title={why}>harness unknown</span>;
}
function AgentTitle({ agent, feed, color }: HeaderProps) {
    return (
        <div className="agent-title">
            <h1><AgentMark color={color} />{agent.name}</h1>
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
/** The header of the tab, with a stripe in the colour of the agent over it: the colour of its envelopes. */
function AgentHeader({ agent, feed, color }: HeaderProps) {
    const [error, run] = useAction();
    return (
        <header className={`agent-header agent-header-colored agent-color-${color ?? 0}`}>
            <AgentTitle agent={agent} feed={feed} color={color} />
            {agent.description === undefined ? null : <p className="description">{agent.description}</p>}
            {agent.health === undefined ? null : <ConnectionHealthView health={agent.health} />}
            <AgentActions agent={agent} feed={feed} run={run} />
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
        </header>
    );
}
/**
 * Sends the message, a reply or a forward; a failed one throws. A queued one
 * says nothing under the field: it shows at the end of the feed, in line.
 */
async function sendMessage(agentId: string, text: string, extras: Omit<SendRequest, 'text' | 'agents'> = {}): Promise<undefined> {
    const delivery = await api.send(agentId, text, extras);
    if (delivery.result === 'failed') {
        throw new Error(delivery.error ?? 'The message did not reach the agent.');
    }
    return undefined;
}
/** What the messages of the line do: a queued one is taken back, a dropped one sent again as it was. */
function lineActions(agentId: string): LineActions {
    return {
        onWithdraw: async (messageId) => {
            await api.withdraw(agentId, messageId);
        },
        onSendAgain: async (item) => {
            await sendMessage(agentId, item.text, {
                ...(item.replyTo === undefined ? {} : { replyTo: item.replyTo }),
                ...(item.forwarded === undefined ? {} : { forwarded: item.forwarded }),
                retryOf: item.messageId
            });
        }
    };
}
/** The reply being written, if any, and what the messages of the feed can do. */
function useMessaging(agentId: string, quotes: AgentPanelProps['quotes']) {
    const [reply, setReply] = useState<Quote>();
    const actions: MessageActions = {
        ...quotes,
        onReply: setReply,
        onForward: async (to, forwarded) => {
            await sendMessage(to, '', { forwarded });
        }
    };
    const send = (text: string): Promise<string | undefined> =>
        sendMessage(agentId, text, reply === undefined ? {} : { replyTo: reply }).then((note) => {
            setReply(undefined);
            return note;
        });
    return { reply, setReply, actions, send };
}
function AgentComposer({ agent, agents, colors, messaging }: Pick<AgentPanelProps, 'agent' | 'agents' | 'colors'> & {
    readonly messaging: ReturnType<typeof useMessaging>;
}) {
    const { reply, setReply, send } = messaging;
    const cancel = (): void => setReply(undefined);
    return (
        <Composer
            label={reply === undefined ? `Message to ${agent.name}` : `Reply to ${agent.name}`}
            placeholder={reply === undefined ? `Message ${agent.name}…` : 'Write a reply…'}
            submitLabel={reply === undefined ? 'Send' : 'Reply'}
            onSend={send}
            above={reply === undefined ? undefined : { key: `${reply.agentId}/${reply.messageId}`, node: <ReplyPreview quote={reply} agents={agents} colors={colors} onCancel={cancel} /> }}
            onEscape={reply === undefined ? undefined : cancel}
        />
    );
}
function AgentPanel({ agent, feed, agents, colors, dispatch, quotes, jump }: AgentPanelProps) {
    const messaging = useMessaging(agent.id, quotes);
    const answer = (requestId: string, optionId?: string): void => {
        dispatch({ type: 'permission-answered', agentId: agent.id, requestId });
        void api.answerPermission(agent.id, requestId, optionId).catch(() => undefined);
    };
    return (
        <section className="agent-panel" aria-label={agent.name}>
            <AgentHeader agent={agent} feed={feed} color={colors[agent.id]} />
            <Feed items={feed.items} queue={feed.queue} status={feed.status} line={lineActions(agent.id)} agentId={agent.id} agentName={agent.name} agents={agents} colors={colors} onAnswer={answer} actions={messaging.actions} jump={jump} />
            <AgentComposer agent={agent} agents={agents} colors={colors} messaging={messaging} />
        </section>
    );
}
export { AgentPanel };
