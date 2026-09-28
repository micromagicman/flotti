import { randomUUID } from 'node:crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Message, Part, SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk';
import { ServiceParameters, withA2AExtensions } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import type { AgentStatus } from './agent-events.js';
import type { Roster } from './fleet-roster.js';
/**
 * A2A extension through which flotti asks a remote agent to restart itself.
 * The agent declares it in `capabilities.extensions` of its card; the contract
 * is in docs/a2a-restart.md.
 */
const RESTART_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-restart.md';
/**
 * A2A extension through which a remote agent says things of its own — a message
 * nobody asked for, a line about what it is busy with — outside the turns of the
 * dashboard. The contract is in docs/a2a-inbox.md.
 */
const INBOX_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-inbox.md';
/**
 * A2A extension through which flotti tells a remote agent who is in the fleet:
 * the roster goes with the inbox request, and what changes in it follows as a
 * request of its own, outside any conversation. The contract is in
 * docs/a2a-fleet.md.
 */
const FLEET_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-fleet.md';
/**
 * A2A extension through which a remote agent names the program that runs it,
 * in `params.harness` of the extension in its card. The contract is in
 * docs/a2a-ssh.md, "Which harness runs the agent".
 */
const HARNESS_EXTENSION = 'https://github.com/micromagicman/flotti/blob/main/docs/a2a-ssh.md#which-harness-runs-the-agent';
/** A turn is over once the agent answered with a message, or its task stopped or paused. */
const FINAL_STATES: readonly TaskState[] = [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED
];
const INTERRUPTED_STATES: readonly TaskState[] = [
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED
];
/** The states in which the agent said no to what it was asked. */
const REFUSED_STATES: readonly TaskState[] = [
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_FAILED
];
/**
 * How a turn ended, by the state of its task, in the words the event model
 * shares with ACP. A turn without a task was answered with a message and is
 * simply over; any other state is an error.
 */
const TURN_END_REASONS = new Map<TaskState | undefined, string>([
    [undefined, 'end_turn'],
    [TaskState.TASK_STATE_COMPLETED, 'end_turn'],
    [TaskState.TASK_STATE_CANCELED, 'cancelled'],
    [TaskState.TASK_STATE_REJECTED, 'refusal'],
    [TaskState.TASK_STATE_INPUT_REQUIRED, 'input_required'],
    [TaskState.TASK_STATE_AUTH_REQUIRED, 'auth_required']
]);
/** How a task state shows on the dashboard; a state that is not here says nothing. */
const TASK_STATUSES = new Map<TaskState, { status: AgentStatus; reason?: string }>([
    [TaskState.TASK_STATE_SUBMITTED, { status: 'working' }],
    [TaskState.TASK_STATE_WORKING, { status: 'working' }],
    [TaskState.TASK_STATE_INPUT_REQUIRED, { status: 'waiting', reason: 'input required' }],
    [TaskState.TASK_STATE_AUTH_REQUIRED, { status: 'waiting', reason: 'authentication required' }],
    [TaskState.TASK_STATE_COMPLETED, { status: 'idle' }],
    [TaskState.TASK_STATE_CANCELED, { status: 'idle', reason: 'canceled' }],
    [TaskState.TASK_STATE_FAILED, { status: 'error', reason: 'the task failed' }],
    [TaskState.TASK_STATE_REJECTED, { status: 'error', reason: 'the agent rejected the task' }]
]);
type StreamPayload = NonNullable<StreamResponse['payload']>;
/** What to do with each kind of event of a stream; a kind without a handler is skipped. */
type PayloadHandlers<R> = {
    readonly [C in StreamPayload['$case']]?: (value: Extract<StreamPayload, { $case: C }>['value']) => R;
};
type PartContent = NonNullable<Part['content']>;
/** Text of a part by the kind of its content: text as it is, data as JSON, files as a line naming them. */
const PART_TEXTS: { readonly [C in PartContent['$case']]: (value: Extract<PartContent, { $case: C }>['value'], part: Part) => string } = {
    text: value => value,
    data: value => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
    url: (value, part) => `[${part.filename || value}](${value})`,
    raw: (value, part) => `[${part.filename || 'file'}, ${part.mediaType || 'binary'}, ${value.length} bytes]`
};
/** Hands the payload of a stream event to the handler of its kind; `otherwise` when there is none. */
function onPayload<R>(event: StreamResponse, handlers: PayloadHandlers<R>, otherwise: R): R {
    const payload = event.payload;
    if (payload === undefined) {
        return otherwise;
    }
    const handler = handlers[payload.$case] as ((value: StreamPayload['value']) => R) | undefined;
    return handler === undefined ? otherwise : handler(payload.value);
}
/** The state of a task by its status; unspecified when the status says none. */
function stateOf(status: Task['status']): TaskState {
    return status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
}
/** The message that came with the status of a task, if any. */
function statusMessage(status: Task['status']): Message | undefined {
    return status?.message;
}
/** Id of the message that came with the status of a task; empty without one. */
function statusMessageId(status: Task['status']): string {
    return statusMessage(status)?.messageId ?? '';
}
/** Why the agent said no, as the end of a sentence: `: <its words>`, or nothing when it gave none. */
function refusalReason(status: Task['status']): string {
    const message = statusMessage(status);
    return message === undefined ? '' : `: ${partsText(message.parts)}`;
}
/** Whether a task in this state has stopped or paused: the turn is over. */
function stopsTurn(state: TaskState): boolean {
    return FINAL_STATES.includes(state) || INTERRUPTED_STATES.includes(state);
}
/** How the turn ended, in the words the event model shares with ACP. */
function turnEndReason(state: TaskState | undefined): string {
    return TURN_END_REASONS.get(state) ?? 'error';
}
/** How a task state shows on the dashboard; nothing for a state that says nothing. */
function statusOfTask(state: TaskState): { status: AgentStatus; reason?: string } | undefined {
    return TASK_STATUSES.get(state);
}
/**
 * Asks the agent to restart itself through the restart extension. Any answer
 * but a failed or rejected task means the agent took the request.
 */
async function askToRestart(client: Client): Promise<void> {
    const request = extensionRequest(RESTART_EXTENSION, 'Restart requested by flotti.', { action: 'restart' });
    const result = await client.sendMessage(sendRequest(request), {
        serviceParameters: ServiceParameters.create(withA2AExtensions(RESTART_EXTENSION))
    });
    if ('messageId' in result) {
        return;
    }
    if (REFUSED_STATES.includes(stateOf(result.status))) {
        throw new Error(`the agent refused to restart${refusalReason(result.status)}`);
    }
}
/** Sends the roster of the fleet as a `fleet` request of the fleet extension; the answer says nothing. */
async function tellFleet(client: Client, fleet: Roster, signal: AbortSignal): Promise<void> {
    const request = extensionRequest(FLEET_EXTENSION, 'The fleet changed; the roster is in the metadata.', { action: 'fleet', ...fleet });
    await client.sendMessage(sendRequest(request), {
        signal,
        serviceParameters: ServiceParameters.create(withA2AExtensions(FLEET_EXTENSION))
    });
}
/**
 * A message that belongs to no conversation and asks something of an extension:
 * the request is in the metadata, under the extension URI; the text is for
 * agents and logs that show messages to people.
 */
function extensionRequest(uri: string, text: string, params: Record<string, unknown>): Message {
    return {
        messageId: randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [textPart(text)],
        metadata: { [uri]: params },
        extensions: [uri],
        referenceTaskIds: []
    };
}
function sendRequest(message: Message): SendMessageRequest {
    return { tenant: '', message, configuration: undefined, metadata: undefined };
}
function textPart(text: string): Part {
    return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}
/** Text of the parts: text as it is, data as JSON, files as a line naming them. */
function partsText(parts: readonly Part[]): string {
    return parts.map(partText).filter(text => text !== '').join('\n');
}
function partText(part: Part): string {
    const content = part.content;
    if (content === undefined) {
        return '';
    }
    const text = PART_TEXTS[content.$case] as (value: PartContent['value'], part: Part) => string;
    return text(content.value, part);
}
export {
    FINAL_STATES,
    FLEET_EXTENSION,
    HARNESS_EXTENSION,
    INBOX_EXTENSION,
    INTERRUPTED_STATES,
    REFUSED_STATES,
    RESTART_EXTENSION,
    askToRestart,
    extensionRequest,
    onPayload,
    partsText,
    refusalReason,
    sendRequest,
    stateOf,
    statusMessage,
    statusMessageId,
    statusOfTask,
    stopsTurn,
    tellFleet,
    textPart,
    turnEndReason
};
