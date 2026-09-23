import { deepStrictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpMessages, acpUpdateEvents } from '../src/acp-events.js';

function chunk(text: string, messageId?: string): SessionUpdate {
    return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(messageId === undefined ? {} : { messageId })
    };
}

describe('acpUpdateEvents: pieces of the agent answer', () => {
    it('makes one message of the chunks with one id, and a new one of the next id', () => {
        const messages = new AcpMessages();
        const events = [chunk('Hel', 'm1'), chunk('lo', 'm1'), chunk('Bye', 'm2')]
            .flatMap((update) => acpUpdateEvents(update, messages));
        deepStrictEqual(events, [
            { type: 'message', role: 'agent', text: 'Hel', messageId: 'm1', append: false },
            { type: 'message', role: 'agent', text: 'lo', messageId: 'm1', append: true },
            { type: 'message', role: 'agent', text: 'Bye', messageId: 'm2', append: false }
        ]);
    });

    it('adds a chunk without an id to the message before, and starts a message of its own in a new turn', () => {
        const messages = new AcpMessages();
        const [first, second] = [chunk('Hel'), chunk('lo')].flatMap((update) => acpUpdateEvents(update, messages));
        ok(first?.type === 'message' && second?.type === 'message');
        deepStrictEqual([first.append, second.append], [false, true]);
        deepStrictEqual(second.messageId, first.messageId);
        messages.reset();
        const [next] = acpUpdateEvents(chunk('again'), messages);
        ok(next?.type === 'message');
        deepStrictEqual(next.append, false);
        ok(next.messageId !== first.messageId);
    });
});
