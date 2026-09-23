import { useLayoutEffect, useRef } from 'react';
import type { AgentSummary } from '../../../src/dashboard-protocol.js';
import type { AgentColors } from '../agent-colors.js';
import type { FeedItem } from '../feed.js';
type FeedProps = {
    readonly items: readonly FeedItem[];
    readonly agentId: string;
    readonly agentName: string;
    /** The whole fleet: a message between agents names the other one. */
    readonly agents: readonly AgentSummary[];
    readonly colors: AgentColors;
    readonly onAnswer: (requestId: string, optionId?: string) => void;
};
function Permission({ item, onAnswer }: { readonly item: FeedItem & { kind: 'permission' }; readonly onAnswer: FeedProps['onAnswer'] }) {
    return (
        <div className="item permission">
            <div className="item-label">Permission requested</div>
            <div>{item.title}</div>
            {item.settled
                ? <div className="muted">answered</div>
                : (
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
                )}
        </div>
    );
}
/**
 * A message one agent sent another, as an envelope: a bar in the colour of
 * the sender says who wrote to whom. In the tab of the receiver it stands on
 * the person's side — it came in as a person's message would — and in the tab
 * of the sender on the agent's.
 */
function Envelope({ item, peer, agentId, agentName, agents, colors }: {
    readonly item: FeedItem & { kind: 'message' };
    readonly peer: string;
} & Omit<FeedProps, 'items' | 'onAnswer'>) {
    const nameOf = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? id;
    const incoming = item.role === 'user';
    const sender = incoming ? peer : agentId;
    const from = incoming ? nameOf(peer) : agentName;
    const to = incoming ? agentName : nameOf(peer);
    return (
        <div className={`item message message-${item.role} ${incoming ? 'message-peer' : 'message-sent'} agent-color-${colors[sender] ?? 0}`}>
            <div className="envelope-bar">
                <span aria-hidden="true">{from} → {to}</span>
                <span className="visually-hidden">From {from} to {to}</span>
            </div>
            <div className="text">{item.text}</div>
        </div>
    );
}
function FeedEntry({ item, onAnswer, ...fleet }: { readonly item: FeedItem } & Omit<FeedProps, 'items'>) {
    const { agentName } = fleet;
    switch (item.kind) {
        case 'message': {
            const peer = item.role === 'user' ? item.from : item.to;
            if (peer !== undefined) {
                return <Envelope item={item} peer={peer} {...fleet} />;
            }
            return (
                <div className={`item message message-${item.role}`}>
                    <div className="item-label">{item.role === 'user' ? 'You' : agentName}</div>
                    <div className="text">{item.text}</div>
                </div>
            );
        }
        case 'thought':
            return <details className="item thought"><summary>Thinking</summary><div className="text">{item.text}</div></details>;
        case 'progress':
            return <div className="item progress">{item.text}</div>;
        case 'tool':
            return (
                <div className={`item tool tool-${item.status ?? 'pending'}`}>
                    <span className="tool-title">{item.title}</span>
                    <span className="tool-status">{item.status ?? 'pending'}</span>
                </div>
            );
        case 'permission':
            return <Permission item={item} onAnswer={onAnswer} />;
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
/** The agent's output, newest at the bottom; follows new output unless the reader scrolled up. */
function Feed({ items, onAnswer, ...fleet }: FeedProps) {
    const { agentName } = fleet;
    const list = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    useLayoutEffect(() => {
        const element = list.current;
        if (element !== null && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [items]);
    return (
        <div
            className="feed"
            role="log"
            aria-label={`Output of ${agentName}`}
            ref={list}
            onScroll={(event) => {
                const element = event.currentTarget;
                pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
            }}
        >
            {items.length === 0 ? <p className="muted empty">Nothing yet. Say something to {agentName}.</p> : null}
            {items.map((item) => <FeedEntry key={item.key} item={item} onAnswer={onAnswer} {...fleet} />)}
        </div>
    );
}
export { Feed };
