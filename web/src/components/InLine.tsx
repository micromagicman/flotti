import { useState } from 'react';
import type { AgentStatus } from '../../../src/agent-events.js';
import type { FeedItem, MessageItem, QueuedMessage } from '../feed.js';
import { MessageBody } from './Message.js';
import type { MessageProps } from './Message.js';
import { useT } from '../i18n/I18n.js';
import { errorText } from '../i18n/errors.js';
/** What the messages of the line can do: be taken back, and — dropped ones — be sent again. */
type LineActions = {
    /** Takes the message out of the line; rejects saying why it could not. */
    readonly onWithdraw: (messageId: string) => Promise<void>;
    /** Sends a dropped message again; rejects saying why it did not go. */
    readonly onSendAgain: (item: FeedItem & { kind: 'undelivered' }) => Promise<void>;
};
type Shared = Pick<MessageProps, 'agentId' | 'agents' | 'colors' | 'actions'>;
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
    const t = useT();
    const run = (action: () => Promise<void>): void => {
        setPending(true);
        setError(undefined);
        action().then(
            () => setPending(false),
            (reason: unknown) => {
                setPending(false);
                setError(errorText(reason, t));
            }
        );
    };
    return { pending, error, run };
}
/** Takes the message back; says so while the server answers. */
function WithdrawButton({ place, pending, onClick }: { readonly place: number; readonly pending: boolean; readonly onClick: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            className="btn btn-ghost btn-xs queue-cancel"
            disabled={pending}
            aria-busy={pending}
            aria-label={pending ? undefined : t.line.cancelLabel(place)}
            onClick={onClick}
        >
            {pending ? t.line.cancelling : t.line.cancel}
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
    const { line } = useT();
    return (
        <div className="message-row message-row-user" data-queued={queued.messageId}>
            <div className="item message message-queued">
                <div className="envelope-bar">
                    <span>{line.place} · {line.ordinal(place)}{queued.from === undefined ? '' : ` · ${line.from(nameOf(shared, queued.from))}`}</span>
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
    const t = useT();
    if (queue.length === 0) {
        return null;
    }
    const busy = status === 'working' || status === 'waiting';
    return (
        <div className="next-up" role="group" aria-label={t.line.nextUp}>
            <div className="next-up-head">
                <span>{t.line.nextUp} · {t.common.inLine(queue.length)}</span>
                <span>{busy ? t.line.afterTurn : t.line.onceReady}</span>
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
    const t = useT();
    return (
        <>
            <div className="dropped-line">
                <span>{t.line.notDelivered(item.reason)}{item.resent ? ` · ${t.line.sentAgain}` : ''}</span>
                {again ? <button type="button" className="btn btn-xs" disabled={pending} aria-busy={pending} onClick={() => run(() => onSendAgain(item))}>{pending ? t.line.sending : t.line.sendAgain}</button> : null}
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
    const t = useT();
    return (
        <div className="message-row message-row-user" data-undelivered={item.messageId}>
            <div className="item message message-user message-dropped">
                <div className="item-label">{item.from === undefined ? t.common.you : t.line.fromName(nameOf(shared, item.from))}</div>
                <MessageBody item={asMessage(item, 0)} {...shared} />
            </div>
            <DroppedLine item={item} onSendAgain={onSendAgain} />
        </div>
    );
}
export { NextUp, Undelivered };
export type { LineActions };
