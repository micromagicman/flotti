import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentEventBody, PermissionOption } from './agent-events.js';

/**
 * Turns one ACP `session/update` into the fleet's agent events. What the
 * event model has no place for goes out as a `raw` event — shown as is by the
 * dashboard, never dropped.
 *
 * `user_message_chunk` is raw too: the message a person sent is already an
 * event, supavisor records it when it sends it, and adapters echo it back.
 */
function acpUpdateEvents(update: SessionUpdate): AgentEventBody[] {
    switch (update.sessionUpdate) {
        case 'agent_message_chunk':
            if (update.content.type === 'text') {
                return [{
                    type: 'message',
                    role: 'agent',
                    text: update.content.text,
                    ...(update.messageId ? { messageId: update.messageId } : {})
                }];
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

export { acpPermissionEvent, acpUpdateEvents };
