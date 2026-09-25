import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject, UIEvent } from 'react';
import type { AgentStatus } from '../../../src/agent-events.js';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import { adminActionText } from '../feed.js';
import type { AdminActionItem, FeedItem, QueuedMessage } from '../feed.js';
import { DelegationCard } from './DelegationCard.js';
import { NextUp, Undelivered } from './InLine.js';
import type { LineActions } from './InLine.js';
import { Message } from './Message.js';
import type { MessageActions } from './Message.js';
import { useT } from '../i18n/I18n.js';
/** A message to bring into view: the one a quote points at. `n` tells one ask from the next. */
type Jump = { readonly agentId: string; readonly seq: number; readonly n: number };
type FeedProps = {
    readonly items: readonly FeedItem[];
    readonly agentId: string;
    readonly agentName: string;
    /** The whole fleet: a message between agents names the other one. */
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly onAnswer: (requestId: string, optionId?: string) => void;
    /** A person allows or refuses an action of an administrator. */
    readonly onAdminAnswer: (actionId: string, allow: boolean) => void;
    readonly actions: MessageActions;
    readonly line: LineActions;
    readonly jump?: Jump | undefined;
};
type FeedViewProps = FeedProps & {
    /** Messages waiting for the agent, shown after everything else. */
    readonly queue: readonly QueuedMessage[];
    readonly status: AgentStatus;
};
function PermissionOptions({ item, onAnswer }: { readonly item: FeedItem & { kind: 'permission' }; readonly onAnswer: FeedProps['onAnswer'] }) {
    return (
        <div className="options">
            {item.options.map((option) => (
                <button
                    key={option.optionId}
                    type="button"
                    className={option.kind.startsWith('allow') ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                    onClick={() => onAnswer(item.requestId, option.optionId)}
                >
                    {option.name}
                </button>
            ))}
        </div>
    );
}
function Permission({ item, onAnswer }: { readonly item: FeedItem & { kind: 'permission' }; readonly onAnswer: FeedProps['onAnswer'] }) {
    const t = useT();
    return (
        <div className="item permission">
            <div className="item-label">{t.feed.permission}</div>
            <div>{item.title}</div>
            {item.settled
                ? <div className="muted">{t.common.answered}</div>
                : <PermissionOptions item={item} onAnswer={onAnswer} />}
        </div>
    );
}
type AdminEntryProps = {
    readonly item: AdminActionItem;
    readonly agentId: string;
    readonly agents: readonly AgentSummary[];
    readonly onAdminAnswer: FeedProps['onAdminAnswer'];
};
/** Allow or Refuse, while the action waits for a person. */
function AdminAllowance({ item, onAdminAnswer }: Pick<AdminEntryProps, 'item' | 'onAdminAnswer'>) {
    const t = useT();
    if (item.settled) {
        return <div className="muted">{t.common.answered}</div>;
    }
    return (
        <div className="options">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onAdminAnswer(item.actionId, true)}>{t.feed.allow}</button>
            <button type="button" className="btn btn-sm" onClick={() => onAdminAnswer(item.actionId, false)}>{t.feed.refuse}</button>
        </div>
    );
}
/**
 * An action of an administrator: a line in both tabs, a request with Allow and
 * Refuse while it waits for a person, and — in the tab of the agent whose
 * context was cleared — a divider: what is above it the agent no longer knows.
 */
function AdminActionEntry({ item, agentId, agents, onAdminAnswer }: AdminEntryProps) {
    const name = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? id;
    const t = useT();
    const text = adminActionText(item, name, t);
    if (item.state === 'done' && item.action === 'clear-context' && item.target === agentId) {
        return <div className="item context-cleared" role="separator" aria-label={t.feed.contextClearedLabel(text)}><span>{t.feed.contextCleared} · {text}</span></div>;
    }
    if (item.state !== 'pending') {
        return <div className={`item admin-action admin-action-${item.state}`}>{text}</div>;
    }
    return (
        <div className="item permission admin-request">
            <div className="item-label">{t.feed.adminRequest}</div>
            <div>{text}</div>
            <AdminAllowance item={item} onAdminAnswer={onAdminAnswer} />
        </div>
    );
}
function ToolEntry({ item }: { readonly item: FeedItem & { kind: 'tool' } }) {
    const t = useT();
    return (
        <div className={`item tool tool-${item.status ?? 'pending'}`}>
            <span className="tool-title">{item.title}</span>
            <span className="tool-status">{t.feed.toolStatus[item.status ?? 'pending']}</span>
        </div>
    );
}
/** Everything in the feed but messages, tasks, permission requests and actions of administrators. */
function NoteEntry({ item }: { readonly item: Exclude<FeedItem, { kind: 'message' | 'permission' | 'undelivered' | 'delegation' | 'admin-action' }> }) {
    const t = useT();
    switch (item.kind) {
        case 'thought':
            return <details className="item thought"><summary>{t.feed.thinking}</summary><div className="text">{item.text}</div></details>;
        case 'progress':
            return <div className="item progress">{item.text}</div>;
        case 'tool':
            return <ToolEntry item={item} />;
        case 'turn-end':
            // A normal end of turn has no look (#115): for an A2A agent every answer is a turn, and a line would follow each.
            return item.reason === 'end_turn' ? null : <div className="item turn-end-note">{t.feed.turnEnded(item.reason)}</div>;
        case 'status':
            return <div className={`item status-line status-line-${item.status}`}>{t.status[item.status]}{item.reason === undefined || item.reason === item.status ? '' : `: ${item.reason}`}</div>;
        case 'log':
            return <div className="item log">{item.source === 'flotti' ? 'flotti: ' : ''}{item.text}</div>;
        case 'raw':
            return <details className="item raw"><summary>{t.feed.rawMessage(item.protocol.toUpperCase())}</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>;
    }
}
function FeedEntry({ item, onAnswer, onAdminAnswer, line, ...fleet }: { readonly item: FeedItem } & Omit<FeedProps, 'items' | 'jump'>) {
    switch (item.kind) {
        case 'message':
            return <Message item={item} {...fleet} />;
        case 'undelivered':
            return <Undelivered item={item} onSendAgain={line.onSendAgain} {...fleet} />;
        case 'permission':
            return <Permission item={item} onAnswer={onAnswer} />;
        case 'delegation':
            return <DelegationCard item={item} agents={fleet.agents} colors={fleet.colors} />;
        case 'admin-action':
            return <AdminActionEntry item={item} agentId={fleet.agentId} agents={fleet.agents} onAdminAnswer={onAdminAnswer} />;
        default:
            return <NoteEntry item={item} />;
    }
}
/** Keeps the newest output in view, unless the reader scrolled up from the bottom. */
/** No line of messages: the same one each time, so the scroll does not run again for nothing. */
const NO_QUEUE: readonly QueuedMessage[] = [];
function usePinnedScroll(items: readonly unknown[], queue: readonly QueuedMessage[] = NO_QUEUE) {
    const list = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    useLayoutEffect(() => {
        const element = list.current;
        if (element !== null && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [items, queue]);
    const onScroll = (event: UIEvent<HTMLDivElement>): void => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    return { list, onScroll };
}
/** Brings the message a quote points at into view, and flashes it so the eye finds it. */
function useJump(list: RefObject<HTMLDivElement | null>, agentId: string, jump: Jump | undefined) {
    useEffect(() => {
        const target = jump?.agentId === agentId ? list.current?.querySelector<HTMLElement>(`[data-seq="${jump.seq}"]`) : undefined;
        if (target === undefined || target === null) {
            return;
        }
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
        target.classList.remove('message-found');
        void target.offsetWidth;
        target.classList.add('message-found');
    }, [list, agentId, jump]);
}
/** The agent's output, newest at the bottom, and what waits for it; follows new output unless the reader scrolled up. */
function Feed({ items, queue, status, onAnswer, onAdminAnswer, jump, ...fleet }: FeedViewProps) {
    const { agentName, agentId } = fleet;
    const { list, onScroll } = usePinnedScroll(items, queue);
    const t = useT();
    useJump(list, agentId, jump);
    return (
        <div
            className="feed"
            role="log"
            aria-label={t.feed.output(agentName)}
            ref={list}
            onScroll={onScroll}
        >
            {items.length === 0 && queue.length === 0 ? <p className="muted empty">{t.feed.empty(agentName)}</p> : null}
            {items.map((item) => <FeedEntry key={item.key} item={item} onAnswer={onAnswer} onAdminAnswer={onAdminAnswer} {...fleet} />)}
            <NextUp queue={queue} status={status} onWithdraw={fleet.line.onWithdraw} {...fleet} />
        </div>
    );
}
export { Feed, usePinnedScroll };
export type { Jump };
