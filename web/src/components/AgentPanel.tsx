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
import { MemoryView } from './MemoryView.js';
import { ReplyPreview } from './Message.js';
import type { MessageActions } from './Message.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
import type { Messages } from '../i18n/en.js';
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
/** What the tab of an agent shows: the chat with it, or its memory bank (#73). */
type AgentView = 'chat' | 'memory';
/** Restart and cancel answer at once; what happens next shows in the status. */
function useAction(): [string | undefined, (action: () => Promise<unknown>) => void] {
    const [error, setError] = useState<string>();
    const t = useT();
    return [error, (action) => {
        setError(undefined);
        action().catch((reason: unknown) => setError(errorText(reason, t)));
    }];
}
/**
 * What runs the agent: claude or codex from the adapter of its manifest, or
 * whatever a remote agent names itself, shown as it is. A plain ACP agent and
 * a remote one that says nothing do not tell, and the badge says so too.
 */
function HarnessBadge({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    if (agent.harness !== undefined) {
        return <span className="harness" data-harness={agent.harness} title={t.agent.harness}>{agent.harness}</span>;
    }
    const why = agent.kind === 'remote' ? t.agent.harnessRemote : t.agent.harnessLocal;
    return <span className="harness harness-unknown" data-harness="unknown" title={why}>{t.agent.harnessUnknown}</span>;
}
/**
 * Whether the agent has memory (#101), as flotti delivered it: on with the
 * version of the policy, unsupported, or unavailable — with why in the hint.
 * Nothing before a local agent was started once: flotti does not guess.
 */
function MemoryBadge({ agent }: { readonly agent: AgentSummary }) {
    const t = useT();
    const memory = agent.memory;
    if (memory === undefined) {
        return null;
    }
    if (memory.state === 'on') {
        const skill = memory.skill === 'user' ? t.agent.memorySkillUser : memory.skill === 'missing' ? t.agent.memorySkillMissing : '';
        return (
            <span className="memory-badge" data-memory="on" data-skill={memory.skill} title={`${t.agent.memoryOnHint}${skill === '' ? '' : ` ${skill}`}`}>
                {t.agent.memoryOn(memory.policy)}
            </span>
        );
    }
    const label = memory.state === 'unsupported' ? t.agent.memoryUnsupported : t.agent.memoryUnavailable;
    return <span className="memory-badge memory-badge-off" data-memory={memory.state} title={memory.reason}>{label}</span>;
}
function AgentTitle({ agent, feed, color }: HeaderProps) {
    const t = useT();
    return (
        <div className="agent-title">
            <h1><AgentMark color={color} />{agent.name}</h1>
            <span className="kind">{agent.kind === 'local' ? t.common.localKind : t.common.remoteKind}</span>
            <HarnessBadge agent={agent} />
            <MemoryBadge agent={agent} />
            {agent.admin === true ? <span className="admin-badge" title={t.agent.adminHint}>{t.agent.admin}</span> : null}
            <StatusBadge status={feed.status} />
            {feed.reason === undefined ? null : <span className="reason">{feed.reason}</span>}
        </div>
    );
}
function AgentActions({ agent, feed, run }: { readonly agent: AgentSummary; readonly feed: AgentFeed; readonly run: (action: () => Promise<unknown>) => void }) {
    const busy = feed.status === 'working' || feed.status === 'waiting';
    const stopped = feed.status === 'stopped' || feed.status === 'error';
    const t = useT();
    return (
        <div className="actions">
            {busy ? <button type="button" className="btn btn-sm" onClick={() => run(() => api.cancel(agent.id))}>{t.common.cancel}</button> : null}
            {stopped
                ? <button type="button" className="btn btn-sm" onClick={() => run(() => api.start(agent.id))}>{t.common.start}</button>
                : <button type="button" className="btn btn-sm" onClick={() => run(() => api.stop(agent.id))}>{t.common.stop}</button>}
            <button type="button" className="btn btn-sm" onClick={() => run(() => api.restart(agent.id))}>{t.common.restart}</button>
        </div>
    );
}
/** Chat or Memory: two capsules under the title, the one in sight pressed. */
function ViewSwitch({ view, onView }: { readonly view: AgentView; readonly onView: (view: AgentView) => void }) {
    const t = useT();
    const button = (value: AgentView, label: string) => (
        <button type="button" className="view-tab" aria-pressed={view === value} onClick={() => onView(value)}>{label}</button>
    );
    return <div className="views" role="group" aria-label={t.agent.view}>{button('chat', t.agent.chat)}{button('memory', t.agent.memory)}</div>;
}
/** The header of the tab, with a stripe in the colour of the agent over it: the colour of its envelopes. */
function AgentHeader({ agent, feed, color, view, onView }: HeaderProps & { readonly view: AgentView; readonly onView: (view: AgentView) => void }) {
    const [error, run] = useAction();
    return (
        <header className={`agent-header agent-header-colored agent-color-${color ?? 0}`}>
            <AgentTitle agent={agent} feed={feed} color={color} />
            {agent.description === undefined ? null : <p className="description">{agent.description}</p>}
            {agent.health === undefined ? null : <ConnectionHealthView health={agent.health} />}
            <AgentActions agent={agent} feed={feed} run={run} />
            {error === undefined ? null : <p className="error" role="alert">{error}</p>}
            <ViewSwitch view={view} onView={onView} />
        </header>
    );
}
/**
 * Sends the message, a reply or a forward; a failed one throws. A queued one
 * says nothing under the field: it shows at the end of the feed, in line.
 */
async function sendMessage(t: Messages, agentId: string, text: string, extras: Omit<SendRequest, 'text' | 'agents'> = {}): Promise<undefined> {
    const delivery = await api.send(agentId, text, extras);
    if (delivery.result === 'failed') {
        throw new Error(delivery.error ?? t.errors.notDelivered);
    }
    return undefined;
}
/** What the messages of the line do: a queued one is taken back, a dropped one sent again as it was. */
function lineActions(agentId: string, t: Messages): LineActions {
    return {
        onWithdraw: async (messageId) => {
            await api.withdraw(agentId, messageId);
        },
        onSendAgain: async (item) => {
            await sendMessage(t, agentId, item.text, {
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
    const t = useT();
    const actions: MessageActions = {
        ...quotes,
        onReply: setReply,
        onForward: async (to, forwarded) => {
            await sendMessage(t, to, '', { forwarded });
        }
    };
    const send = (text: string): Promise<string | undefined> =>
        sendMessage(t, agentId, text, reply === undefined ? {} : { replyTo: reply }).then((note) => {
            setReply(undefined);
            return note;
        });
    return { reply, setReply, actions, send };
}
function AgentComposer({ agent, feed, agents, colors, messaging }: Pick<AgentPanelProps, 'agent' | 'feed' | 'agents' | 'colors'> & {
    readonly messaging: ReturnType<typeof useMessaging>;
}) {
    const { reply, setReply, send } = messaging;
    const cancel = (): void => setReply(undefined);
    const t = useT();
    return (
        <Composer
            label={reply === undefined ? t.agent.messageTo(agent.name) : t.agent.replyTo(agent.name)}
            placeholder={reply === undefined ? t.agent.messagePlaceholder(agent.name) : t.agent.replyPlaceholder}
            submitLabel={reply === undefined ? t.common.send : t.agent.reply}
            onSend={send}
            above={reply === undefined ? undefined : { key: `${reply.agentId}/${reply.messageId}`, node: <ReplyPreview quote={reply} agents={agents} colors={colors} onCancel={cancel} /> }}
            onEscape={reply === undefined ? undefined : cancel}
            state={<StatusBadge status={feed.status} detail={feed.queue.length === 0 ? undefined : t.common.inLine(feed.queue.length)} />}
        />
    );
}
/** Answers to a permission request of the agent and to an action of an administrator. */
function useAnswers(agentId: string, dispatch: Dispatch<FleetAction>) {
    const answer = (requestId: string, optionId?: string): void => {
        dispatch({ type: 'permission-answered', agentId, requestId });
        void api.answerPermission(agentId, requestId, optionId).catch(() => undefined);
    };
    const answerAdmin = (actionId: string, allow: boolean): void => {
        dispatch({ type: 'admin-answered', actionId });
        void api.answerAdminAction(actionId, allow).catch(() => undefined);
    };
    return { answer, answerAdmin };
}
function AgentPanel({ agent, feed, agents, colors, dispatch, quotes, jump }: AgentPanelProps) {
    const messaging = useMessaging(agent.id, quotes);
    const [view, setView] = useState<AgentView>('chat');
    const { answer, answerAdmin } = useAnswers(agent.id, dispatch);
    const t = useT();
    return (
        <section className="agent-panel" aria-label={agent.name}>
            <AgentHeader agent={agent} feed={feed} color={colors[agent.id]} view={view} onView={setView} />
            <div className="chat-view" hidden={view !== 'chat'}>
                <Feed items={feed.items} queue={feed.queue} status={feed.status} line={lineActions(agent.id, t)} agentId={agent.id} agentName={agent.name} agents={agents} colors={colors} onAnswer={answer} onAdminAnswer={answerAdmin} actions={messaging.actions} jump={jump} />
                <AgentComposer agent={agent} feed={feed} agents={agents} colors={colors} messaging={messaging} />
            </div>
            {view === 'memory' ? <MemoryView agentId={agent.id} /> : null}
        </section>
    );
}
export { AgentPanel };
