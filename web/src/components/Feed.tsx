import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject, UIEvent } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { FeedItem } from '../feed.js';
import { Message } from './Message.js';
import type { MessageActions } from './Message.js';
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
    readonly actions: MessageActions;
    readonly jump?: Jump | undefined;
};
function PermissionOptions({ item, onAnswer }: { readonly item: FeedItem & { kind: 'permission' }; readonly onAnswer: FeedProps['onAnswer'] }) {
    return (
        <div className="options">
            {item.options.map((option) => (
                <button
                    key={option.optionId}
                    type="button"
                    className={option.kind.startsWith('allow') ? 'primary' : ''}
                    onClick={() => onAnswer(item.requestId, option.optionId)}
                >
                    {option.name}
                </button>
            ))}
        </div>
    );
}
function Permission({ item, onAnswer }: { readonly item: FeedItem & { kind: 'permission' }; readonly onAnswer: FeedProps['onAnswer'] }) {
    return (
        <div className="item permission">
            <div className="item-label">Permission requested</div>
            <div>{item.title}</div>
            {item.settled
                ? <div className="muted">answered</div>
                : <PermissionOptions item={item} onAnswer={onAnswer} />}
        </div>
    );
}
function ToolEntry({ item }: { readonly item: FeedItem & { kind: 'tool' } }) {
    return (
        <div className={`item tool tool-${item.status ?? 'pending'}`}>
            <span className="tool-title">{item.title}</span>
            <span className="tool-status">{item.status ?? 'pending'}</span>
        </div>
    );
}
/** Everything in the feed but messages and permission requests. */
function NoteEntry({ item }: { readonly item: Exclude<FeedItem, { kind: 'message' | 'permission' }> }) {
    switch (item.kind) {
        case 'thought':
            return <details className="item thought"><summary>Thinking</summary><div className="text">{item.text}</div></details>;
        case 'progress':
            return <div className="item progress">{item.text}</div>;
        case 'tool':
            return <ToolEntry item={item} />;
        case 'turn-end':
            return item.reason === 'end_turn' ? <hr className="turn-end" /> : <div className="item turn-end-note">Turn ended: {item.reason}</div>;
        case 'status':
            return <div className={`item status-line status-line-${item.status}`}>{item.status}{item.reason === undefined || item.reason === item.status ? '' : `: ${item.reason}`}</div>;
        case 'log':
            return <div className="item log">{item.source === 'flotti' ? 'flotti: ' : ''}{item.text}</div>;
        case 'raw':
            return <details className="item raw"><summary>{item.protocol.toUpperCase()} message</summary><pre>{JSON.stringify(item.payload, null, 2)}</pre></details>;
    }
}
function FeedEntry({ item, onAnswer, ...fleet }: { readonly item: FeedItem } & Omit<FeedProps, 'items' | 'jump'>) {
    switch (item.kind) {
        case 'message':
            return <Message item={item} {...fleet} />;
        case 'permission':
            return <Permission item={item} onAnswer={onAnswer} />;
        default:
            return <NoteEntry item={item} />;
    }
}
/** Keeps the newest output in view, unless the reader scrolled up from the bottom. */
function usePinnedScroll(items: readonly unknown[]) {
    const list = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    useLayoutEffect(() => {
        const element = list.current;
        if (element !== null && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [items]);
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
/** The agent's output, newest at the bottom; follows new output unless the reader scrolled up. */
function Feed({ items, onAnswer, jump, ...fleet }: FeedProps) {
    const { agentName, agentId } = fleet;
    const { list, onScroll } = usePinnedScroll(items);
    useJump(list, agentId, jump);
    return (
        <div
            className="feed"
            role="log"
            aria-label={`Output of ${agentName}`}
            ref={list}
            onScroll={onScroll}
        >
            {items.length === 0 ? <p className="muted empty">Nothing yet. Say something to {agentName}.</p> : null}
            {items.map((item) => <FeedEntry key={item.key} item={item} onAnswer={onAnswer} {...fleet} />)}
        </div>
    );
}
export { Feed, usePinnedScroll };
export type { Jump };
