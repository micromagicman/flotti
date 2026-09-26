import type { Message } from '@a2a-js/sdk';
import type { AdminAction, SendOptions } from './agent-events.js';
import { INBOX_EXTENSION } from './a2a-protocol.js';
/** An action on another agent — or on itself — the agent asked for through the inbox. */
type AdminRequest = { readonly action: AdminAction; readonly target: string };
/** What an inbox message that is not a request of an administrator says of itself. */
type SaidParams = {
    readonly kind: 'message' | 'progress';
    readonly busy?: boolean;
    readonly to?: string;
    /** The message gives `to` a task; the id of the task is the id of the message. */
    readonly task?: { readonly deadline?: string };
    /** Id of a task the agent gave and takes back. */
    readonly cancel?: string;
};
/** What an inbox message says of itself under the extension URI. */
type InboxParams = SaidParams | {
    /** A request of an administrator of the fleet: not a message, so `busy` and `to` are not read with it. */
    readonly kind: 'admin';
    readonly request: AdminRequest | undefined;
};
const ADMIN_ACTIONS: readonly unknown[] = ['restart', 'clear-context'] satisfies AdminAction[];
/** What an inbox message says of itself under the extension URI; anything else there is ignored. */
function inboxParams(message: Message): InboxParams {
    const params: unknown = message.metadata?.[INBOX_EXTENSION];
    if (!isRecord(params)) {
        return { kind: 'message' };
    }
    return params['kind'] === 'admin' ? { kind: 'admin', request: adminRequestOf(params) } : saidParams(params);
}
function saidParams(params: Record<string, unknown>): SaidParams {
    const { kind, busy, to, task, cancel } = params;
    return {
        kind: kind === 'progress' ? 'progress' : 'message',
        ...(typeof busy === 'boolean' ? { busy } : {}),
        ...field('to', nonEmpty(to)),
        ...(isRecord(task) ? { task: taskParams(task) } : {}),
        ...field('cancel', nonEmpty(cancel))
    };
}
function taskParams(task: Record<string, unknown>): { readonly deadline?: string } {
    return field('deadline', nonEmpty(task['deadline']));
}
/** `"action": "restart" | "clear-context"` on `"agent": "<id>"`; nothing when either is missing or unknown. */
function adminRequestOf(params: Record<string, unknown>): AdminRequest | undefined {
    const { action, agent } = params;
    const target = nonEmpty(agent);
    return ADMIN_ACTIONS.includes(action) && target !== undefined ? { action: action as AdminAction, target } : undefined;
}
/**
 * How a message to the agent says who sent it and what task it gives: under
 * the inbox extension URI, for a message of another agent of the fleet or one
 * that gives a task; a message of a person carries nothing.
 */
function senderMarks(options: SendOptions): Pick<Message, 'metadata' | 'extensions'> {
    const params = senderParams(options);
    return Object.keys(params).length === 0
        ? { metadata: undefined, extensions: [] }
        : { metadata: { [INBOX_EXTENSION]: params }, extensions: [INBOX_EXTENSION] };
}
function senderParams(options: SendOptions): Record<string, unknown> {
    return { ...field('from', options.from), ...field('task', options.delegation) };
}
/** `{ [key]: value }`, or nothing when there is no value. */
function field<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
    return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
}
function nonEmpty(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
export { adminRequestOf, inboxParams, senderMarks };
export type { AdminRequest, InboxParams, SaidParams };
