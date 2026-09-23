import { randomUUID } from 'node:crypto';
import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentEventBody, PermissionOption } from './agent-events.js';
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
 * event, supavisor records it when it sends it, and adapters echo it back.
 */
function acpUpdateEvents(update: SessionUpdate, messages: AcpMessages): AgentEventBody[] {
    switch (update.sessionUpdate) {
        case 'agent_message_chunk':
            if (update.content.type === 'text') {
                return [{ type: 'message', role: 'agent', text: update.content.text, ...messages.piece(update.messageId) }];
            }
            break;
        case 'agent_thought_chunk':
            if (update.content.type === 'text') {
                return [{ type: 'thought', text: update.content.text }];
            }
            break;
        case 'tool_call':
            return [{
                type: 'tool-call',
                toolCallId: update.toolCallId,
                title: update.title,
                ...(update.status ? { status: update.status } : {}),
                raw: update
            }];
        case 'tool_call_update':
            return [{
                type: 'tool-call',
                toolCallId: update.toolCallId,
                ...(update.title ? { title: update.title } : {}),
                ...(update.status ? { status: update.status } : {}),
                raw: update
            }];
        default:
            break;
    }
    return [{ type: 'raw', protocol: 'acp', payload: update }];
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
