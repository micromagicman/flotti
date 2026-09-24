import { useState } from 'react';
import type { AgentStatus } from '../../../src/agent-events.js';
import type { FeedItem, MessageItem, QueuedMessage } from '../feed.js';
import { MessageBody } from './Message.js';
import type { MessageProps } from './Message.js';
/** What the messages of the line can do: be taken back, and — dropped ones — be sent again. */
type LineActions = {
    /** Takes the message out of the line; rejects saying why it could not. */
    readonly onWithdraw: (messageId: string) => Promise<void>;
    /** Sends a dropped message again; rejects saying why it did not go. */
    readonly onSendAgain: (item: FeedItem & { kind: 'undelivered' }) => Promise<void>;
};
type Shared = Pick<MessageProps, 'agentId' | 'agents' | 'colors' | 'actions'>;
/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
    return `${n}${suffix}`;
}
/** A message of the line as the body of a message shows it: its quote, words and what it forwards. */
function asMessage(queued: Omit<QueuedMessage, 'seq'>, seq: number): MessageItem {
    return {
        kind: 'message',
        key: `q${seq}`,
        role: 'user',
        seq,
        time: queued.time,
        messageId: queued.messageId,
        text: queued.text,
        ...(queued.from === undefined ? {} : { from: queued.from }),
        ...(queued.replyTo === undefined ? {} : { replyTo: queued.replyTo }),
        ...(queued.forwarded === undefined ? {} : { forwarded: queued.forwarded })
    };
}
function nameOf(shared: Shared, id: string): string {
    return shared.agents.find((agent) => agent.id === id)?.name ?? id;
}
/** Runs the action once at a time, and keeps what went wrong to say it. */
function usePending(): { pending: boolean; error: string | undefined; run: (action: () => Promise<void>) => void } {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const run = (action: () => Promise<void>): void => {
        setPending(true);
        setError(undefined);
        action().then(
            () => setPending(false),
            (reason: unknown) => {
                setPending(false);
                setError(reason instanceof Error ? reason.message : String(reason));
            }
        );
    };
    return { pending, error, run };
}
/** Takes the message back; says so while the server answers. */
function WithdrawButton({ place, pending, onClick }: { readonly place: number; readonly pending: boolean; readonly onClick: () => void }) {
    return (
        <button
            type="button"
            className="queue-cancel"
            disabled={pending}
            aria-label={pending ? undefined : `Cancel queued message ${place}`}
            onClick={onClick}
        >
            {pending ? 'Cancelling…' : '✕ cancel'}
        </button>
    );
}
function ErrorNote({ error }: { readonly error: string | undefined }) {
    return error === undefined ? null : <span className="message-outcome error" role="alert">{error}</span>;
}
function QueuedEnvelope({ queued, place, onWithdraw, ...shared }: Shared & {
    readonly queued: QueuedMessage;
    readonly place: number;
    readonly onWithdraw: LineActions['onWithdraw'];
}) {
    const { pending, error, run } = usePending();
    const from = queued.from === undefined ? '' : ` · from ${nameOf(shared, queued.from)}`;
    return (
        <div className="message-row message-row-user" data-queued={queued.messageId}>
            <div className="item message message-queued">
                <div className="envelope-bar">
                    <span>In line · {ordinal(place)}{from}</span>
                    <WithdrawButton place={place} pending={pending} onClick={() => run(() => onWithdraw(queued.messageId))} />
                </div>
                <div className="envelope-body"><MessageBody item={asMessage(queued, queued.seq)} {...shared} /></div>
            </div>
            <ErrorNote error={error} />
        </div>
    );
}
/**
 * The messages waiting for the agent, after everything it said: cut off from
 * the feed by a dashed line, each an envelope with its place in the line.
 */
type NextUpProps = Shared & {
    readonly queue: readonly QueuedMessage[];
    readonly status: AgentStatus;
    readonly onWithdraw: LineActions['onWithdraw'];
};
function NextUp({ queue, status, onWithdraw, ...shared }: NextUpProps) {
    if (queue.length === 0) {
        return null;
    }
    const busy = status === 'working' || status === 'waiting';
    return (
        <div className="next-up" role="group" aria-label="Next up">
            <div className="next-up-head">
                <span>Next up · {queue.length} in line</span>
                <span>{busy ? 'after the current turn' : 'once the agent is ready'}</span>
            </div>
            {queue.map((queued, index) => (
                <QueuedEnvelope key={queued.messageId} queued={queued} place={index + 1} onWithdraw={onWithdraw} {...shared} />
            ))}
        </div>
    );
}
/** Why the message did not go, and the way to send it again when it is the person's to send. */
function DroppedLine({ item, onSendAgain }: { readonly item: FeedItem & { kind: 'undelivered' }; readonly onSendAgain: LineActions['onSendAgain'] }) {
    const { pending, error, run } = usePending();
    // A message of another agent is that agent's to send again, not the person's.
    const again = item.from === undefined && !item.resent;
    return (
        <>
            <div className="dropped-line">
                <span>Not delivered: {item.reason}{item.resent ? ' · sent again' : ''}</span>
                {again ? <button type="button" disabled={pending} onClick={() => run(() => onSendAgain(item))}>{pending ? 'Sending…' : 'Send again'}</button> : null}
            </div>
            <ErrorNote error={error} />
        </>
    );
}
/** A message dropped from the line: its words stay, with why it did not go. */
function Undelivered({ item, onSendAgain, ...shared }: Shared & {
    readonly item: FeedItem & { kind: 'undelivered' };
    readonly onSendAgain: LineActions['onSendAgain'];
}) {
    return (
        <div className="message-row message-row-user" data-undelivered={item.messageId}>
            <div className="item message message-user message-dropped">
                <div className="item-label">{item.from === undefined ? 'You' : `From ${nameOf(shared, item.from)}`}</div>
                <MessageBody item={asMessage(item, 0)} {...shared} />
            </div>
            <DroppedLine item={item} onSendAgain={onSendAgain} />
        </div>
    );
}
export { NextUp, Undelivered, ordinal };
export type { LineActions };
