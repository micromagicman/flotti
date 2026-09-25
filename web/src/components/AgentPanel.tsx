import { useState } from 'react';
import type { Dispatch } from 'react';
import type { Quote } from '../../../src/agent-events.js';
import type { AgentSummary, SendRequest } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { api } from '../api.js';
import type { AgentFeed } from '../feed.js';
import type { FleetAction } from '../fleet-state.js';
import { ActionsMenu, AgentActions } from './ActionsMenu.js';
import type { AgentAction } from './ActionsMenu.js';
import { AgentDetails, useDetails } from './AgentDetails.js';
import { AgentMark } from './AgentMark.js';
import { Composer } from './Composer.js';
import { ConnectionAlarm } from './ConnectionHealth.js';
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
function InfoIcon() {
    return (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7.2v4M8 4.6v.3" strokeLinecap="round" />
        </svg>
    );
}
/** What can be done to the agent now: cancel the turn, stop or start it, restart it. */
function actionsOf(agent: AgentSummary, feed: AgentFeed, t: Messages): AgentAction[] {
    const busy = feed.status === 'working' || feed.status === 'waiting';
    const stopped = feed.status === 'stopped' || feed.status === 'error';
    return [
        ...(busy ? [{ key: 'cancel', label: t.common.cancel, act: () => api.cancel(agent.id) }] : []),
        stopped
            ? { key: 'start', label: t.common.start, act: () => api.start(agent.id) }
            : { key: 'stop', label: t.common.stop, act: () => api.stop(agent.id) },
        { key: 'restart', label: t.common.restart, act: () => api.restart(agent.id) }
    ];
}
/** Chat or Memory: two capsules in the line of the header, the one in sight pressed. */
function ViewSwitch({ view, onView }: { readonly view: AgentView; readonly onView: (view: AgentView) => void }) {
    const t = useT();
    const button = (value: AgentView, label: string) => (
        <button type="button" className="view-tab" aria-pressed={view === value} onClick={() => onView(value)}>{label}</button>
    );
    return <div className="views" role="group" aria-label={t.agent.view}>{button('chat', t.agent.chat)}{button('memory', t.agent.memory)}</div>;
}
type DetailsToggle = { readonly details: boolean; readonly onDetails: () => void; readonly detailsId: string };
type AgentHeaderProps = HeaderProps & DetailsToggle & { readonly view: AgentView; readonly onView: (view: AgentView) => void };
/** The name and the state: all of the header a talk with the agent needs to see. */
function AgentTitle({ agent, feed, color }: HeaderProps) {
    return (
        <div className="agent-title">
            <h1><AgentMark color={color} /><span className="agent-name">{agent.name}</span></h1>
            <StatusBadge status={feed.status} />
            {feed.reason === undefined ? null : <span className="reason" title={feed.reason}>{feed.reason}</span>}
        </div>
    );
}
/** The actions — buttons on a wide screen, «⋯» on a phone — and «i» for the details. */
function HeaderActions({ agent, feed, run, details, onDetails, detailsId }: Omit<HeaderProps, 'color'> & DetailsToggle & { readonly run: (action: () => Promise<unknown>) => void }) {
    const t = useT();
    const actions = actionsOf(agent, feed, t);
    return (
        <div className="header-actions">
            <AgentActions actions={actions} run={run} />
            <ActionsMenu actions={actions} run={run} />
            <button type="button" className="btn btn-sm btn-ghost icon-btn details-toggle" aria-expanded={details} aria-controls={detailsId} aria-label={t.agent.detailsOf(agent.name)} title={t.agent.details} onClick={onDetails}>
                <InfoIcon />
            </button>
        </div>
    );
}
/**
 * The header of the tab in one line (#102): the name, the state, Chat and
 * Memory, the actions, and «i» for the details. A stripe in the colour of the
 * agent over it: the colour of its envelopes.
 */
function AgentHeader({ agent, feed, color, view, onView, ...toggle }: AgentHeaderProps) {
    const [error, run] = useAction();
    return (
        <>
            <header className={`agent-header agent-header-colored agent-color-${color ?? 0}`}>
                <AgentTitle agent={agent} feed={feed} color={color} />
                <ViewSwitch view={view} onView={onView} />
                <HeaderActions agent={agent} feed={feed} run={run} {...toggle} />
            </header>
            {error === undefined ? null : <p className="error header-error" role="alert">{error}</p>}
        </>
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
/** The chat with the agent, or its memory bank. */
function AgentBody({ agent, feed, agents, colors, dispatch, quotes, jump, view }: AgentPanelProps & { readonly view: AgentView }) {
    const messaging = useMessaging(agent.id, quotes);
    const { answer, answerAdmin } = useAnswers(agent.id, dispatch);
    const t = useT();
    return (
        <>
            <div className="chat-view" hidden={view !== 'chat'}>
                <Feed items={feed.items} queue={feed.queue} status={feed.status} line={lineActions(agent.id, t)} agentId={agent.id} agentName={agent.name} agents={agents} colors={colors} onAnswer={answer} onAdminAnswer={answerAdmin} actions={messaging.actions} jump={jump} />
                <AgentComposer agent={agent} feed={feed} agents={agents} colors={colors} messaging={messaging} />
            </div>
            {view === 'memory' ? <MemoryView agentId={agent.id} /> : null}
        </>
    );
}
function AgentPanel(props: AgentPanelProps) {
    const { agent, feed, colors } = props;
    const [view, setView] = useState<AgentView>('chat');
    const details = useDetails();
    const detailsId = `agent-details-${agent.id}`;
    return (
        <>
            <section className="agent-panel" aria-label={agent.name}>
                <AgentHeader agent={agent} feed={feed} color={colors[agent.id]} view={view} onView={setView}
                    details={details.open} onDetails={details.open ? details.hide : details.show} detailsId={detailsId} />
                <ConnectionAlarm health={agent.health} onDetails={details.show} />
                <AgentBody {...props} view={view} />
            </section>
            {details.open ? <AgentDetails agent={agent} id={detailsId} onClose={details.hide} /> : null}
        </>
    );
}
export { AgentPanel };
