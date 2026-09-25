import { randomUUID } from 'node:crypto';
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentEventBody, PermissionOption } from './agent-events.js';
type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
type MessageChunk = Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;
type ThoughtChunk = Extract<SessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>;
/**
 * Gives the pieces of the agent's answers the ids the event model wants. ACP
 * may leave a chunk without `messageId`, and then it belongs to the message
 * before; a chunk that is first in a turn and has no id starts a message of
 * its own.
 */
class AcpMessages {
    private current: string | undefined;
    /** A new turn: the next piece starts a new message. */
    reset(): void {
        this.current = undefined;
    }
    piece(messageId: string | null | undefined): { readonly messageId: string; readonly append: boolean } {
        if (messageId && messageId !== this.current) {
            this.current = messageId;
            return { messageId, append: false };
        }
        if (this.current === undefined) {
            this.current = randomUUID();
            return { messageId: this.current, append: false };
        }
        return { messageId: this.current, append: true };
    }
}
/**
 * Turns one ACP `session/update` into the fleet's agent events. What the
 * event model has no place for goes out as a `raw` event — shown as is by the
 * dashboard, never dropped.
 *
 * `user_message_chunk` is raw too: the message a person sent is already an
 * event, flotti records it when it sends it, and adapters echo it back.
 */
function acpUpdateEvents(update: SessionUpdate, messages: AcpMessages): AgentEventBody[] {
    return [knownEvent(update, messages) ?? { type: 'raw', protocol: 'acp', payload: update }];
}
/** The event of an update the event model has a place for; nothing for any other. */
function knownEvent(update: SessionUpdate, messages: AcpMessages): AgentEventBody | undefined {
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        return toolCallEvent(update);
    }
    return chunkEvent(update, messages);
}
/** A piece of the agent's answer or of its thought: only text has a place. */
function chunkEvent(update: SessionUpdate, messages: AcpMessages): AgentEventBody | undefined {
    switch (update.sessionUpdate) {
        case 'agent_message_chunk':
            return messageChunk(update, messages);
        case 'agent_thought_chunk':
            return thoughtChunk(update);
        default:
            return undefined;
    }
}
function messageChunk(update: MessageChunk, messages: AcpMessages): AgentEventBody | undefined {
    return update.content.type === 'text'
        ? { type: 'message', role: 'agent', text: update.content.text, ...messages.piece(update.messageId) }
        : undefined;
}
function thoughtChunk(update: ThoughtChunk): AgentEventBody | undefined {
    return update.content.type === 'text' ? { type: 'thought', text: update.content.text } : undefined;
}
/** A tool call, or a change to one: only a new call is sure to have a title. */
function toolCallEvent(update: ToolCallUpdate): AgentEventBody {
    return {
        type: 'tool-call',
        toolCallId: update.toolCallId,
        ...titleOf(update),
        ...(update.status ? { status: update.status } : {}),
        raw: update
    };
}
function titleOf(update: ToolCallUpdate): { readonly title?: string } {
    if (update.sessionUpdate === 'tool_call') {
        return { title: update.title };
    }
    return update.title ? { title: update.title } : {};
}
/** The permission request as an event; `requestId` is how the answer finds its way back. */
function acpPermissionEvent(requestId: string, request: RequestPermissionRequest): AgentEventBody {
    return {
        type: 'permission',
        requestId,
        title: request.toolCall.title ?? request.toolCall.toolCallId,
        options: request.options.map((option): PermissionOption => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind
        }))
    };
}
export { AcpMessages, acpPermissionEvent, acpUpdateEvents };
